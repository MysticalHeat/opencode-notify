import { describe, expect, it, vi } from "vitest"
import { shouldSkipChildSession, getSessionMetadata } from "../src/notify.js"
import type { EventLike, NotifyPluginConfig, PluginEventType } from "../src/types.js"
import type { PluginInput } from "@opencode-ai/plugin"

function makeEvent(type: PluginEventType, properties?: Record<string, unknown>): EventLike {
	return { type, properties } as EventLike
}

function mockClient(parentID?: string, parentTitle?: string): PluginInput["client"] {
	return {
		session: {
			get: vi.fn().mockResolvedValue({
				data: {
					title: "Test Session",
					parentID,
					parentTitle,
				},
			}),
		},
	} as unknown as PluginInput["client"]
}

const configWithChildrenDisabled: NotifyPluginConfig = { notifyChildSessions: false }
const configWithChildrenEnabled: NotifyPluginConfig = { notifyChildSessions: true }

describe("shouldSkipChildSession", () => {
	it("does not skip question.asked even for child sessions", async () => {
		const event = makeEvent("question.asked", { sessionID: "child-1" })
		const result = await shouldSkipChildSession("question.asked", event, configWithChildrenDisabled, mockClient("parent-1"))
		expect(result.skip).toBe(false)
	})

	it("does not skip permission.asked even for child sessions", async () => {
		const event = makeEvent("permission.asked", { sessionID: "child-1" })
		const result = await shouldSkipChildSession("permission.asked", event, configWithChildrenDisabled, mockClient("parent-1"))
		expect(result.skip).toBe(false)
	})

	it("does not skip permission.updated even for child sessions", async () => {
		const event = makeEvent("permission.updated", { sessionID: "child-1" })
		const result = await shouldSkipChildSession("permission.updated", event, configWithChildrenDisabled, mockClient("parent-1"))
		expect(result.skip).toBe(false)
	})

	it("skips session.error from child when notifyChildSessions is false", async () => {
		const event = makeEvent("session.error", { sessionID: "child-1" })
		const result = await shouldSkipChildSession("session.error", event, configWithChildrenDisabled, mockClient("parent-1", "Parent Session"))
		expect(result.skip).toBe(true)
	})

	it("skips session.idle from child when notifyChildSessions is false", async () => {
		const event = makeEvent("session.idle", { sessionID: "child-1" })
		const result = await shouldSkipChildSession("session.idle", event, configWithChildrenDisabled, mockClient("parent-1"))
		expect(result.skip).toBe(true)
	})

	it("does not skip session.error from child when notifyChildSessions is true", async () => {
		const event = makeEvent("session.error", { sessionID: "child-1" })
		const result = await shouldSkipChildSession("session.error", event, configWithChildrenEnabled, mockClient("parent-1"))
		expect(result.skip).toBe(false)
	})

	it("does not skip session.idle from root session", async () => {
		const event = makeEvent("session.idle", { sessionID: "root-1" })
		const result = await shouldSkipChildSession("session.idle", event, configWithChildrenDisabled, mockClient(undefined))
		expect(result.skip).toBe(false)
	})

	it("returns session metadata when not skipping", async () => {
		const event = makeEvent("session.idle", { sessionID: "root-1" })
		const result = await shouldSkipChildSession("session.idle", event, configWithChildrenDisabled, mockClient(undefined, undefined))
		expect(result.skip).toBe(false)
		expect(result.session.title).toBe("Test Session")
	})
})

describe("getSessionMetadata", () => {
	it("returns empty on client error", async () => {
		const client = {
			session: {
				get: vi.fn().mockRejectedValue(new Error("Not found")),
			},
		} as unknown as PluginInput["client"]
		const result = await getSessionMetadata(client, "s1")
		expect(result).toEqual({})
	})

	it("returns empty when client is undefined", async () => {
		const result = await getSessionMetadata(undefined, "s1")
		expect(result).toEqual({})
	})
})
