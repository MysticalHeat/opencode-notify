import { describe, it, expect } from "vitest"
import { eventToUpsert, buildUpsertMessage, buildCancelMessage, shouldRelayEvent } from "../src/events.js"

const CLIENT_ID = "client-test-001"

function event(type: string, props: Record<string, unknown>) {
	return { type, properties: props }
}

const questionV2Fixture = {
	type: "question.v2.asked",
	properties: {
		id: "req-qv2-001",
		sessionID: "session-abc",
		questions: [
			{
				question: "Which file should I edit?",
				options: [
					{ label: "Config files", value: "opt-configs" },
					{ label: "Source files", value: "opt-source" },
					{ label: "Test files", value: "opt-tests" },
				],
				multiSelect: false,
			},
		],
	},
}

const questionLegacyFixture = {
	type: "question.asked",
	properties: {
		id: "req-ql-001",
		sessionID: "session-abc",
		questions: [
			{
				question: "Approve this change?",
				options: [
					{ label: "Yes", value: "yes" },
					{ label: "No", value: "no" },
				],
			},
		],
	},
}

const permissionV2Fixture = {
	type: "permission.v2.asked",
	properties: {
		id: "req-pv2-001",
		sessionID: "session-abc",
		action: "read",
		resources: ["**/*.ts", "**/*.json"],
		save: ["**/*.md"],
	},
}

const permissionLegacyFixture = {
	type: "permission.asked",
	properties: {
		id: "req-pl-001",
		sessionID: "session-abc",
		permission: "write",
		patterns: ["**/*.ts", "**/*.json"],
	},
}

describe("eventToUpsert", () => {
	it("converts question.v2.asked to UpsertEvent", () => {
		const result = eventToUpsert(questionV2Fixture, CLIENT_ID)
		expect(result).not.toBeNull()
		expect(result!.requestId).toBe("req-qv2-001")
		expect(result!.clientId).toBe(CLIENT_ID)
		expect(result!.sessionId).toBe("session-abc")
		expect(result!.question).toBeDefined()
		expect(result!.question!.text).toBe("Which file should I edit?")
		expect(result!.question!.options).toHaveLength(3)
		expect(result!.question!.options[0]).toEqual({ label: "Config files", value: "opt-configs" })
		expect(result!.question!.multiSelect).toBe(false)
		expect(result!.permission).toBeUndefined()
		expect(result!.expiresAt).toBeDefined()
	})

	it("converts question.asked to UpsertEvent", () => {
		const result = eventToUpsert(questionLegacyFixture, CLIENT_ID)
		expect(result).not.toBeNull()
		expect(result!.requestId).toBe("req-ql-001")
		expect(result!.question).toBeDefined()
		expect(result!.question!.text).toBe("Approve this change?")
		expect(result!.question!.options).toHaveLength(2)
		expect(result!.permission).toBeUndefined()
	})

	it("converts permission.v2.asked to UpsertEvent", () => {
		const result = eventToUpsert(permissionV2Fixture, CLIENT_ID)
		expect(result).not.toBeNull()
		expect(result!.requestId).toBe("req-pv2-001")
		expect(result!.permission).toBeDefined()
		expect(result!.permission!.action).toBe("read")
		expect(result!.permission!.patterns).toContain("**/*.ts")
		expect(result!.permission!.patterns).toContain("**/*.json")
		expect(result!.permission!.patterns).toContain("**/*.md")
		expect(result!.question).toBeUndefined()
	})

	it("converts permission.asked to UpsertEvent", () => {
		const result = eventToUpsert(permissionLegacyFixture, CLIENT_ID)
		expect(result).not.toBeNull()
		expect(result!.requestId).toBe("req-pl-001")
		expect(result!.permission).toBeDefined()
		expect(result!.permission!.action).toBe("write")
		expect(result!.permission!.patterns).toContain("**/*.ts")
		expect(result!.question).toBeUndefined()
	})

	it("returns null for non-relay event types", () => {
		expect(eventToUpsert(event("session.idle", { sessionID: "s1" }), CLIENT_ID)).toBeNull()
		expect(eventToUpsert(event("session.error", { sessionID: "s1" }), CLIENT_ID)).toBeNull()
		expect(eventToUpsert(event("tool.execute.before", { sessionID: "s1" }), CLIENT_ID)).toBeNull()
	})

	it("returns null when no properties", () => {
		expect(eventToUpsert({ type: "question.asked" }, CLIENT_ID)).toBeNull()
	})

	it("returns null when no request ID can be extracted", () => {
		expect(eventToUpsert(
			{ type: "question.asked", properties: { sessionID: "s1", questions: [{ question: "Q?", options: [{ label: "A", value: "a" }] }] } },
			CLIENT_ID,
		)).toBeNull()
	})

	it("extracts requestId from requestID when id is not present", () => {
		const ev = {
			type: "question.asked" as const,
			properties: {
				requestID: "req-custom",
				sessionID: "session-abc",
				questions: [{ question: "Q?", options: [{ label: "A", value: "a" }] }],
			},
		}
		const result = eventToUpsert(ev, CLIENT_ID)
		expect(result).not.toBeNull()
		expect(result!.requestId).toBe("req-custom")
	})
})

describe("buildUpsertMessage", () => {
	it("builds a valid RequestUpsertMessage with question", () => {
		const ev = eventToUpsert(questionV2Fixture, CLIENT_ID)!
		const msg = buildUpsertMessage(ev, "msg-001")
		expect(msg.protocolVersion).toBe(1)
		expect(msg.type).toBe("request_upsert")
		expect(msg.messageId).toBe("msg-001")
		expect(msg.sentAt).toBeDefined()
		expect(msg.payload.clientId).toBe(CLIENT_ID)
		expect(msg.payload.question).toBeDefined()
		expect(msg.payload.permission).toBeUndefined()
	})

	it("builds a valid RequestUpsertMessage with permission", () => {
		const ev = eventToUpsert(permissionV2Fixture, CLIENT_ID)!
		const msg = buildUpsertMessage(ev, "msg-002")
		expect(msg.type).toBe("request_upsert")
		expect(msg.payload.permission).toBeDefined()
		expect(msg.payload.question).toBeUndefined()
	})
})

describe("buildCancelMessage", () => {
	it("builds a valid RequestCancelMessage", () => {
		const cancel = { requestId: "req-001", clientId: CLIENT_ID, sessionId: "session-abc" }
		const msg = buildCancelMessage(cancel, "msg-003")
		expect(msg.protocolVersion).toBe(1)
		expect(msg.type).toBe("request_cancel")
		expect(msg.messageId).toBe("msg-003")
		expect(msg.payload.requestId).toBe("req-001")
		expect(msg.payload.clientId).toBe(CLIENT_ID)
	})
})

describe("shouldRelayEvent", () => {
	it("returns true for question and permission events", () => {
		expect(shouldRelayEvent("question.asked")).toBe(true)
		expect(shouldRelayEvent("question.v2.asked")).toBe(true)
		expect(shouldRelayEvent("permission.asked")).toBe(true)
		expect(shouldRelayEvent("permission.v2.asked")).toBe(true)
	})

	it("returns false for non-relay events", () => {
		expect(shouldRelayEvent("session.idle")).toBe(false)
		expect(shouldRelayEvent("session.error")).toBe(false)
		expect(shouldRelayEvent(undefined)).toBe(false)
	})
})
