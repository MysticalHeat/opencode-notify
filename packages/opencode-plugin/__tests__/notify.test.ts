import { describe, expect, it } from "vitest"
import { summarizeEvent, buildContext } from "../src/notify.js"
import type { EventLike, NotifyPluginConfig } from "../src/types.js"

const DEFAULT_CONFIG: NotifyPluginConfig = {
	notifyChildSessions: false,
	sounds: { idle: "default", error: "basso", permission: "ping", question: "default" },
	quietHours: { enabled: false, start: "22:00", end: "08:00" },
}

function makeEvent(type: string, properties?: Record<string, unknown>): EventLike {
	return { type, properties } as EventLike
}

describe("summarizeEvent", () => {
	describe("question.asked", () => {
		it("includes question text as message", () => {
			const event = makeEvent("question.asked", {
				sessionID: "s1",
				question: "What is the answer?",
			})
			const result = summarizeEvent("question.asked", event, DEFAULT_CONFIG, {})
			expect(result.title).toBe("Need answer")
			expect(result.message).toBe("What is the answer?")
			expect(result.sessionID).toBe("s1")
		})

		it("falls back to default message when no question text", () => {
			const event = makeEvent("question.asked", { sessionID: "s1" })
			const result = summarizeEvent("question.asked", event, DEFAULT_CONFIG, {})
			expect(result.message).toBe("Please answer this question.")
		})

		it("reads from questions array", () => {
			const event = makeEvent("question.asked", {
				sessionID: "s1",
				questions: [{ question: "First question" }],
			})
			const result = summarizeEvent("question.asked", event, DEFAULT_CONFIG, {})
			expect(result.message).toBe("First question")
		})

		it("includes session title in context", () => {
			const event = makeEvent("question.asked", {
				sessionID: "s1",
				title: "My Session",
				question: "Hello",
			})
			const result = summarizeEvent("question.asked", event, DEFAULT_CONFIG, {})
			expect(result.context).toBe("My Session")
		})
	})

	describe("permission.asked", () => {
		it("reads permission text", () => {
			const event = makeEvent("permission.asked", {
				sessionID: "s1",
				permission: "Allow file write",
			})
			const result = summarizeEvent("permission.asked", event, DEFAULT_CONFIG, {})
			expect(result.title).toBe("Approval needed")
			expect(result.message).toBe("Allow file write")
		})

		it("falls back to prompt", () => {
			const event = makeEvent("permission.asked", {
				sessionID: "s1",
				prompt: "Grant access?",
			})
			const result = summarizeEvent("permission.asked", event, DEFAULT_CONFIG, {})
			expect(result.message).toBe("Grant access?")
		})

		it("falls back to tool name", () => {
			const event = makeEvent("permission.asked", {
				sessionID: "s1",
				tool: { name: "bash" },
			})
			const result = summarizeEvent("permission.asked", event, DEFAULT_CONFIG, {})
			expect(result.message).toBe("bash")
		})
	})

	describe("permission.updated", () => {
		it("has static message", () => {
			const event = makeEvent("permission.updated", { sessionID: "s1" })
			const result = summarizeEvent("permission.updated", event, DEFAULT_CONFIG, {})
			expect(result.title).toBe("Approval needed")
			expect(result.message).toBe("Permission updated.")
		})
	})

	describe("session.error", () => {
		it("reads error message property", () => {
			const event = makeEvent("session.error", {
				sessionID: "s1",
				message: "Something went wrong",
			})
			const result = summarizeEvent("session.error", event, DEFAULT_CONFIG, {})
			expect(result.title).toBe("Failed")
			expect(result.message).toBe("Error: Something went wrong")
		})

		it("reads error.message nested property", () => {
			const event = makeEvent("session.error", {
				sessionID: "s1",
				error: { message: "Nested error" },
			})
			const result = summarizeEvent("session.error", event, DEFAULT_CONFIG, {})
			expect(result.message).toBe("Error: Nested error")
		})

		it("falls back to default message", () => {
			const event = makeEvent("session.error", { sessionID: "s1" })
			const result = summarizeEvent("session.error", event, DEFAULT_CONFIG, {})
			expect(result.message).toBe("The session failed.")
		})
	})

	describe("session.idle", () => {
		it("returns ready for review", () => {
			const event = makeEvent("session.idle", { sessionID: "s1" })
			const result = summarizeEvent("session.idle", event, DEFAULT_CONFIG, {})
			expect(result.title).toBe("Ready for review")
			expect(result.message).toBe("Finished and ready for review.")
		})
	})

	describe("sound assignment", () => {
		it("assigns correct sounds per event type", () => {
			expect(summarizeEvent("question.asked", makeEvent("question.asked", { sessionID: "s1" }), DEFAULT_CONFIG, {}).sound).toBe("default")
			expect(summarizeEvent("permission.asked", makeEvent("permission.asked", { sessionID: "s1" }), DEFAULT_CONFIG, {}).sound).toBe("ping")
			expect(summarizeEvent("session.error", makeEvent("session.error", { sessionID: "s1" }), DEFAULT_CONFIG, {}).sound).toBe("basso")
			expect(summarizeEvent("session.idle", makeEvent("session.idle", { sessionID: "s1" }), DEFAULT_CONFIG, {}).sound).toBe("default")
		})
	})
})

describe("buildContext", () => {
	it("returns context from props.context", () => {
		const result = buildContext("question.asked", { context: "some context" }, {})
		expect(result).toBe("some context")
	})

	it("returns parentLabel when available", () => {
		const result = buildContext("question.asked", {}, { parentTitle: "Main session" })
		expect(result).toBe("Parent: Main session")
	})

	it("returns parentID when no parentTitle", () => {
		const result = buildContext("question.asked", {}, { parentID: "parent-1" })
		expect(result).toBe("Parent: parent-1")
	})

	it("joins context and parentLabel for idle sessions", () => {
		const result = buildContext("session.idle", { context: "Done" }, { parentTitle: "Main" })
		expect(result).toBe("Done · Parent: Main")
	})

	it("returns undefined when nothing is available", () => {
		const result = buildContext("question.asked", {}, {})
		expect(result).toBeUndefined()
	})
})
