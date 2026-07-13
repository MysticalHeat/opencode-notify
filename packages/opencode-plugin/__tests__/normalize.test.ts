import { describe, expect, it } from "vitest"
import { normalizeEventType } from "../src/notify.js"
import type { EventLike } from "../src/types.js"

function makeEvent(type: string, properties?: Record<string, unknown>): EventLike {
	return { type, properties } as EventLike
}

describe("normalizeEventType", () => {
	describe("tool.execute.before", () => {
		it("normalizes tool.execute.before with tool=question → question.asked", () => {
			const event = makeEvent("tool.execute.before", {
				tool: { name: "question", callID: "abc" },
			})
			expect(normalizeEventType(event)).toBe("question.asked")
		})

		it("ignores tool.execute.before with non-question tool", () => {
			const event = makeEvent("tool.execute.before", {
				tool: { name: "bash", callID: "abc" },
			})
			expect(normalizeEventType(event)).toBeUndefined()
		})

		it("ignores tool.execute.before without properties", () => {
			const event = makeEvent("tool.execute.before")
			expect(normalizeEventType(event)).toBeUndefined()
		})

		it("ignores tool.execute.before with empty tool name", () => {
			const event = makeEvent("tool.execute.before", {
				tool: { name: "", callID: "abc" },
			})
			expect(normalizeEventType(event)).toBeUndefined()
		})
	})

	describe("session.status", () => {
		it("normalizes session.status with status.type=idle → session.idle", () => {
			const event = makeEvent("session.status", {
				status: { type: "idle" },
			})
			expect(normalizeEventType(event)).toBe("session.idle")
		})

		it("ignores session.status with non-idle status", () => {
			const event = makeEvent("session.status", {
				status: { type: "running" },
			})
			expect(normalizeEventType(event)).toBeUndefined()
		})

		it("ignores session.status without properties", () => {
			const event = makeEvent("session.status")
			expect(normalizeEventType(event)).toBeUndefined()
		})

		it("ignores session.status with null status type", () => {
			const event = makeEvent("session.status", {
				status: { type: null },
			})
			expect(normalizeEventType(event)).toBeUndefined()
		})
	})

	describe("direct event types", () => {
		it("passes through question.asked", () => {
			const event = makeEvent("question.asked", { sessionID: "s1" })
			expect(normalizeEventType(event)).toBe("question.asked")
		})

		it("passes through permission.asked", () => {
			const event = makeEvent("permission.asked", { sessionID: "s1" })
			expect(normalizeEventType(event)).toBe("permission.asked")
		})

		it("passes through permission.updated", () => {
			const event = makeEvent("permission.updated", { sessionID: "s1" })
			expect(normalizeEventType(event)).toBe("permission.updated")
		})

		it("passes through session.error", () => {
			const event = makeEvent("session.error", { sessionID: "s1" })
			expect(normalizeEventType(event)).toBe("session.error")
		})

		it("passes through session.idle", () => {
			const event = makeEvent("session.idle", { sessionID: "s1" })
			expect(normalizeEventType(event)).toBe("session.idle")
		})
	})

	describe("unknown event types", () => {
		it("returns undefined for unknown event type", () => {
			const event = makeEvent("unknown.event", {})
			expect(normalizeEventType(event)).toBeUndefined()
		})

		it("returns undefined for null type", () => {
			const event = { properties: {} } as EventLike
			expect(normalizeEventType(event)).toBeUndefined()
		})
	})
})
