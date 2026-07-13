import { describe, expect, it, beforeEach } from "vitest"
import { dedupeKey, createDedupeTracker } from "../src/notify.js"
import type { EventLike } from "../src/types.js"

function makeEvent(type: string, properties?: Record<string, unknown>): EventLike {
	return { type, properties } as EventLike
}

describe("dedupeKey", () => {
	describe("question.asked", () => {
		it("returns key with callID when available", () => {
			const event = makeEvent("question.asked", {
				sessionID: "s1",
				tool: { callID: "c1" },
			})
			expect(dedupeKey("question.asked", event)).toBe("question:s1:c1")
		})

		it("returns key with requestID when callID missing", () => {
			const event = makeEvent("question.asked", {
				sessionID: "s1",
				requestID: "r1",
			})
			expect(dedupeKey("question.asked", event)).toBe("question:s1:r1")
		})

		it("falls back to 'unknown' when ids missing", () => {
			const event = makeEvent("question.asked", { sessionID: "s1" })
			expect(dedupeKey("question.asked", event)).toBe("question:s1:unknown")
		})

		it("returns null when no properties", () => {
			const event = makeEvent("question.asked")
			expect(dedupeKey("question.asked", event)).toBeNull()
		})
	})

	describe("permission.asked", () => {
		it("returns key with requestID", () => {
			const event = makeEvent("permission.asked", {
				sessionID: "s1",
				requestID: "r1",
			})
			expect(dedupeKey("permission.asked", event)).toBe("permission:r1")
		})

		it("falls back to sessionID", () => {
			const event = makeEvent("permission.asked", { sessionID: "s1" })
			expect(dedupeKey("permission.asked", event)).toBe("permission:s1")
		})
	})

	describe("session.idle", () => {
		it("returns idle key with sessionID", () => {
			const event = makeEvent("session.idle", { sessionID: "s1" })
			expect(dedupeKey("session.idle", event)).toBe("idle:s1")
		})
	})

	describe("session.error", () => {
		it("returns error key with sessionID", () => {
			const event = makeEvent("session.error", { sessionID: "s1" })
			expect(dedupeKey("session.error", event)).toBe("error:s1")
		})
	})
})

describe("createDedupeTracker", () => {
	let tracker: ReturnType<typeof createDedupeTracker>

	beforeEach(() => {
		tracker = createDedupeTracker()
	})

	it("allows first event", () => {
		expect(tracker.shouldSend("key-1")).toBe(true)
	})

	it("suppresses duplicate within window", () => {
		expect(tracker.shouldSend("key-1")).toBe(true)
		expect(tracker.shouldSend("key-1")).toBe(false)
	})

	it("allows different keys", () => {
		expect(tracker.shouldSend("key-1")).toBe(true)
		expect(tracker.shouldSend("key-2")).toBe(true)
	})

	it("allows null key always", () => {
		expect(tracker.shouldSend(null)).toBe(true)
		expect(tracker.shouldSend(null)).toBe(true)
	})

	it("allows same key after reset", () => {
		expect(tracker.shouldSend("key-1")).toBe(true)
		tracker.reset()
		expect(tracker.shouldSend("key-1")).toBe(true)
	})
})
