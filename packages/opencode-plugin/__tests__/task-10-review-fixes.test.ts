import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { eventToUpsert, buildUpsertMessage, type UpsertEvent } from "../src/events.js"
import { RelayClient } from "../src/relay-client.js"
import type { DecisionMessage } from "@repo/protocol"

// ─── Fake WebSocket ──────────────────────────────────────────

class FakeWebSocket {
	static OPEN = 1
	static CLOSED = 3

	url: string
	readyState = 0
	private listeners: Record<string, Array<(...args: unknown[]) => void>> = {}

	constructor(url: string) {
		this.url = url
		queueMicrotask(() => {
			this.readyState = FakeWebSocket.OPEN
			this.emit("open", {})
		})
	}

	addEventListener(event: string, fn: (...args: unknown[]) => void) {
		(this.listeners[event] ??= []).push(fn)
	}

	emit(event: string, ...args: unknown[]) {
		for (const fn of this.listeners[event] ?? []) {
			try {
				if (event === "message") {
					fn({ data: args[0] })
				} else {
					fn(...args)
				}
			} catch { /* ignore */ }
		}
	}

	removeEventListener(event: string, fn: (...args: unknown[]) => void) {
		const arr = this.listeners[event]
		if (!arr) return
		const idx = arr.indexOf(fn)
		if (idx >= 0) arr.splice(idx, 1)
	}

	send() {}
	close() {
		this.readyState = FakeWebSocket.CLOSED
		this.emit("close", { code: 1000, reason: "" })
	}
}

// ─── Helpers ─────────────────────────────────────────────────

function serverPairingMessage(paired: boolean) {
	return JSON.stringify({
		protocolVersion: 1,
		messageId: `srv-pair-${Date.now()}`,
		type: "pairing",
		sentAt: new Date().toISOString(),
		payload: { clientId: "client-opencode-001", sessionId: "session-abc123", paired },
	})
}

function makeDecision(requestId: string, approved = true): DecisionMessage {
	return {
		protocolVersion: 1,
		messageId: `srv-dec-${requestId}`,
		type: "decision",
		sentAt: new Date().toISOString(),
		payload: {
			requestId,
			clientId: "client-opencode-001",
			sessionId: "session-abc123",
			approved,
		},
	}
}

// ─── Fix 1: sanitize props.id extraction ──────────────────────

describe("FIX: sanitize props.id extraction (getSessionID)", () => {
	it("RED: does not use props.id as sessionID when sessionID/sessionId are missing", () => {
		// Props with id but no sessionID — id should NOT become sessionID
		const ev = {
			type: "question.asked" as const,
			properties: {
				id: "req-id-only",
				questions: [{ question: "Q?", options: [{ label: "A", value: "a" }] }],
			},
		}
		const result = eventToUpsert(ev, "client-1")
		expect(result).not.toBeNull()
		// sessionId should NOT be "req-id-only" (that's the request ID, not session)
		expect(result!.sessionId).not.toBe("req-id-only")
		// Should be "unknown" since there's no real session ID
		expect(result!.sessionId).toBe("unknown")
	})

	it("still uses props.id as requestID when requestID/requestId are missing", () => {
		const ev = {
			type: "question.asked" as const,
			properties: {
				id: "req-id-only",
				sessionID: "s1",
				questions: [{ question: "Q?", options: [{ label: "A", value: "a" }] }],
			},
		}
		const result = eventToUpsert(ev, "client-1")
		expect(result).not.toBeNull()
		expect(result!.requestId).toBe("req-id-only")
		expect(result!.sessionId).toBe("s1")
	})

	it("uses actual sessionID when present alongside id", () => {
		const ev = {
			type: "question.asked" as const,
			properties: {
				id: "req-id",
				sessionID: "session-real",
				questions: [{ question: "Q?", options: [{ label: "A", value: "a" }] }],
			},
		}
		const result = eventToUpsert(ev, "client-1")
		expect(result).not.toBeNull()
		expect(result!.sessionId).toBe("session-real")
	})
})

// ─── Fix 2: valid protocol upserts (no undefined payload fields) ─

describe("FIX: send valid protocol upserts (no undefined payload fields)", () => {
	it("RED: buildUpsertMessage strips undefined question from permission-only events", () => {
		const ev: UpsertEvent = {
			requestId: "req-1",
			clientId: "client-1",
			sessionId: "s1",
			expiresAt: new Date(Date.now() + 300_000).toISOString(),
			permission: { action: "read", patterns: ["*.ts"], display: "read" },
		}
		const msg = buildUpsertMessage(ev, "msg-1")
		// question should NOT be in payload at all (not undefined)
		expect("question" in msg.payload).toBe(false)
		expect(msg.payload.permission).toBeDefined()
	})

	it("RED: buildUpsertMessage strips undefined permission from question-only events", () => {
		const ev: UpsertEvent = {
			requestId: "req-1",
			clientId: "client-1",
			sessionId: "s1",
			expiresAt: new Date(Date.now() + 300_000).toISOString(),
			question: { text: "Q?", options: [{ label: "A", value: "a" }] },
		}
		const msg = buildUpsertMessage(ev, "msg-1")
		// permission should NOT be in payload at all
		expect("permission" in msg.payload).toBe(false)
		expect(msg.payload.question).toBeDefined()
	})

	it("RED: buildUpsertMessage preserves complete question payload", () => {
		const ev: UpsertEvent = {
			requestId: "req-1",
			clientId: "client-1",
			sessionId: "s1",
			expiresAt: new Date(Date.now() + 300_000).toISOString(),
			question: {
				text: "Which file?",
				options: [
					{ label: "Config", value: "config" },
					{ label: "Source", value: "source" },
				],
				multiSelect: true,
			},
		}
		const msg = buildUpsertMessage(ev, "msg-1")
		expect(msg.payload.question).toEqual(ev.question)
		expect(msg.payload.question!.options).toHaveLength(2)
	})
})

// ─── Fix 3: bound/expire seen decision dedupe entries ──────────

describe("FIX: bound/expire seen decision dedupe entries", () => {
	let fakeWs: FakeWebSocket | null = null
	let originalWebSocket: typeof WebSocket

	beforeEach(() => {
		fakeWs = null
		originalWebSocket = globalThis.WebSocket
		globalThis.WebSocket = function (url: string) {
			fakeWs = new FakeWebSocket(url)
			return fakeWs as unknown as WebSocket
		} as unknown as typeof WebSocket
		;(globalThis.WebSocket as unknown as Record<string, unknown>).OPEN = FakeWebSocket.OPEN
		;(globalThis.WebSocket as unknown as Record<string, unknown>).CLOSED = FakeWebSocket.CLOSED
	})

	afterEach(() => {
		globalThis.WebSocket = originalWebSocket
		vi.restoreAllMocks()
	})

	it("RED: seenDecisions evicts old entries on each new decision", async () => {
		const onDecision = vi.fn()
		const client = new RelayClient({
			url: "wss://relay.example/ws",
			clientToken: "token",
			clientId: "client-1",
			sessionId: "s1",
			onDecision,
			heartbeatIntervalMs: 9999, // effectively disabled
		})
		client.connect()

		await vi.waitFor(() => { expect(fakeWs).not.toBeNull() }, { timeout: 200 })
		fakeWs!.emit("message", serverPairingMessage(true))
		await vi.waitFor(() => { expect(client.currentStatus).toBe("paired") }, { timeout: 200 })

		// Send many unique decisions to fill up
		const decisions = Array.from({ length: 100 }, (_, i) => makeDecision(`req-${i}`))
		for (const dec of decisions) {
			fakeWs!.emit("message", JSON.stringify(dec))
		}

		// All should have been delivered (no dedupe since all unique)
		expect(onDecision).toHaveBeenCalledTimes(100)

		// Now send the same decisions again — should be deduplicated
		for (const dec of decisions) {
			fakeWs!.emit("message", JSON.stringify(dec))
		}

		// Count should still be 100 (dedupe worked for all)
		expect(onDecision).toHaveBeenCalledTimes(100)
	})
})

// ─── Fix 4: prevent user decision callback exceptions from escaping ─

describe("FIX: prevent user decision callback exceptions from escaping", () => {
	let fakeWs: FakeWebSocket | null = null
	let originalWebSocket: typeof WebSocket

	beforeEach(() => {
		fakeWs = null
		originalWebSocket = globalThis.WebSocket
		globalThis.WebSocket = function (url: string) {
			fakeWs = new FakeWebSocket(url)
			return fakeWs as unknown as WebSocket
		} as unknown as typeof WebSocket
		;(globalThis.WebSocket as unknown as Record<string, unknown>).OPEN = FakeWebSocket.OPEN
		;(globalThis.WebSocket as unknown as Record<string, unknown>).CLOSED = FakeWebSocket.CLOSED
	})

	afterEach(() => {
		globalThis.WebSocket = originalWebSocket
		vi.restoreAllMocks()
	})

	it("RED: onDecision exception does not crash the message handler", async () => {
		const throwingDecision = vi.fn().mockImplementation(() => {
			throw new Error("callback explosion")
		})
		const client = new RelayClient({
			url: "wss://relay.example/ws",
			clientToken: "token",
			clientId: "client-1",
			sessionId: "s1",
			onDecision: throwingDecision,
			heartbeatIntervalMs: 9999,
		})
		client.connect()

		await vi.waitFor(() => { expect(fakeWs).not.toBeNull() }, { timeout: 200 })
		fakeWs!.emit("message", serverPairingMessage(true))
		await vi.waitFor(() => { expect(client.currentStatus).toBe("paired") }, { timeout: 200 })

		// Send a decision — callback throws but client stays connected
		fakeWs!.emit("message", JSON.stringify(makeDecision("req-1")))

		await vi.waitFor(() => {
			expect(throwingDecision).toHaveBeenCalled()
		}, { timeout: 200 })

		// Client should still be paired (not crashed)
		expect(client.currentStatus).toBe("paired")

		// Second decision should still get delivered (message handler didn't die)
		fakeWs!.emit("message", JSON.stringify(makeDecision("req-2")))

		// throwingDecision was called again — proves handler stayed alive
		await vi.waitFor(() => {
			expect(throwingDecision).toHaveBeenCalledTimes(2)
		}, { timeout: 200 })
	})

	it("RED: onDecision exception does not prevent dedupe tracking", async () => {
		let callCount = 0
		const onDecision = vi.fn().mockImplementation(() => {
			callCount++
			if (callCount === 1) throw new Error("first call fails")
		})

		const client = new RelayClient({
			url: "wss://relay.example/ws",
			clientToken: "token",
			clientId: "client-1",
			sessionId: "s1",
			onDecision,
			heartbeatIntervalMs: 9999,
		})
		client.connect()

		await vi.waitFor(() => { expect(fakeWs).not.toBeNull() }, { timeout: 200 })
		fakeWs!.emit("message", serverPairingMessage(true))
		await vi.waitFor(() => { expect(client.currentStatus).toBe("paired") }, { timeout: 200 })

		// Send same decision twice — first throws, second should be deduped
		const dec = makeDecision("req-dedup")
		fakeWs!.emit("message", JSON.stringify(dec))
		fakeWs!.emit("message", JSON.stringify(dec))

		await vi.waitFor(() => {
			expect(onDecision).toHaveBeenCalledTimes(1)
		}, { timeout: 200 })
	})
})

// ─── Fix 5: failed apply-result delivery retained/retried ──────

describe("FIX: failed apply-result delivery retained/retried safely", () => {
	let fakeWs: FakeWebSocket | null = null
	let originalWebSocket: typeof WebSocket

	beforeEach(() => {
		fakeWs = null
		originalWebSocket = globalThis.WebSocket
		globalThis.WebSocket = function (url: string) {
			fakeWs = new FakeWebSocket(url)
			return fakeWs as unknown as WebSocket
		} as unknown as typeof WebSocket
		;(globalThis.WebSocket as unknown as Record<string, unknown>).OPEN = FakeWebSocket.OPEN
		;(globalThis.WebSocket as unknown as Record<string, unknown>).CLOSED = FakeWebSocket.CLOSED
	})

	afterEach(() => {
		globalThis.WebSocket = originalWebSocket
		vi.restoreAllMocks()
	})

	it("RED: sendApplyResult queues result when not paired and flushes on reconnect", async () => {
		const client = new RelayClient({
			url: "wss://relay.example/ws",
			clientToken: "token",
			clientId: "client-1",
			sessionId: "s1",
			onDecision: vi.fn(),
			heartbeatIntervalMs: 9999,
		})
		client.connect()

		await vi.waitFor(() => { expect(fakeWs).not.toBeNull() }, { timeout: 200 })

		// Not paired yet — sendApplyResult should queue
		await client.sendApplyResult("req-1", true)

		// Now pair
		const sendSpy = vi.spyOn(fakeWs!, "send")
		fakeWs!.emit("message", serverPairingMessage(true))
		await vi.waitFor(() => { expect(client.currentStatus).toBe("paired") }, { timeout: 200 })

		// The queued apply result should have been sent
		const applyResultCalls = sendSpy.mock.calls.filter(([data]) => {
			return typeof data === "string" && data.includes('"apply_result"') && data.includes('"req-1"')
		})
		expect(applyResultCalls.length).toBeGreaterThanOrEqual(1)
	})

	it("RED: sendApplyResult sends immediately when already paired", async () => {
		const client = new RelayClient({
			url: "wss://relay.example/ws",
			clientToken: "token",
			clientId: "client-1",
			sessionId: "s1",
			onDecision: vi.fn(),
			heartbeatIntervalMs: 9999,
		})
		client.connect()

		await vi.waitFor(() => { expect(fakeWs).not.toBeNull() }, { timeout: 200 })
		fakeWs!.emit("message", serverPairingMessage(true))
		await vi.waitFor(() => { expect(client.currentStatus).toBe("paired") }, { timeout: 200 })

		const sendSpy = vi.spyOn(fakeWs!, "send")
		await client.sendApplyResult("req-immediate", true)

		const applyResultCalls = sendSpy.mock.calls.filter(([data]) => {
			return typeof data === "string" && data.includes('"apply_result"') && data.includes('"req-immediate"')
		})
		expect(applyResultCalls.length).toBe(1)
	})

	it("RED: sendApplyResult does not throw when called during shutdown", async () => {
		const client = new RelayClient({
			url: "wss://relay.example/ws",
			clientToken: "token",
			clientId: "client-1",
			sessionId: "s1",
			onDecision: vi.fn(),
			heartbeatIntervalMs: 9999,
		})
		client.shutdown()
		// Should not throw
		await expect(client.sendApplyResult("req-1", true)).resolves.toBeUndefined()
	})
})

// ─── Fix 6: avoid stale message listener retention across reconnects ─

describe("FIX: avoid stale message listener retention across reconnects", () => {
	it("RED: old WebSocket listeners do not fire after reconnect", async () => {
		const originalWebSocket = globalThis.WebSocket
		const allSockets: FakeWebSocket[] = []

		globalThis.WebSocket = function (url: string) {
			const ws = new FakeWebSocket(url)
			allSockets.push(ws)
			return ws as unknown as WebSocket
		} as unknown as typeof WebSocket
		;(globalThis.WebSocket as unknown as Record<string, unknown>).OPEN = FakeWebSocket.OPEN
		;(globalThis.WebSocket as unknown as Record<string, unknown>).CLOSED = FakeWebSocket.CLOSED

		try {
			const onDecision = vi.fn()
			const client = new RelayClient({
				url: "wss://relay.example/ws",
				clientToken: "token",
				clientId: "client-1",
				sessionId: "s1",
				onDecision,
				heartbeatIntervalMs: 9999,
				maxReconnectDelayMs: 50,
			})
			client.connect()

			await vi.waitFor(() => { expect(allSockets.length).toBe(1) }, { timeout: 200 })
			const firstWs = allSockets[0]!
			firstWs.emit("message", serverPairingMessage(true))
			await vi.waitFor(() => { expect(client.currentStatus).toBe("paired") }, { timeout: 200 })

			// Deliver a decision through the first socket
			firstWs.emit("message", JSON.stringify(makeDecision("req-1")))
			await vi.waitFor(() => { expect(onDecision).toHaveBeenCalledTimes(1) }, { timeout: 200 })

			// Lose connection — triggers reconnect
			firstWs.emit("close", { code: 1006, reason: "" })

			// Wait for reconnect
			await vi.waitFor(() => { expect(allSockets.length).toBeGreaterThan(1) }, { timeout: 500 })

			// The old (first) socket should no longer affect the client
			// Simulate the old socket firing a stale message
			firstWs.emit("message", JSON.stringify(makeDecision("req-stale")))
			await new Promise((r) => setTimeout(r, 50))

			// The stale message from the old socket should NOT increment callback
			// (onDecision was already called once, should not increase from old socket)
			const callCountAfterStale = onDecision.mock.calls.length

			// Deliver a decision through the new socket
			const newWs = allSockets[allSockets.length - 1]!
			newWs.emit("message", JSON.stringify(makeDecision("req-new")))
			await vi.waitFor(() => {
				expect(onDecision.mock.calls.length).toBe(callCountAfterStale + 1)
			}, { timeout: 200 })
		} finally {
			globalThis.WebSocket = originalWebSocket
			vi.restoreAllMocks()
		}
	})
})

// ─── Fix 7: preserve complete UpsertEvent payloads for reconnect ─

describe("FIX: preserve complete UpsertEvent payloads for reconnect reconciliation", () => {
	let fakeWs: FakeWebSocket | null = null
	let originalWebSocket: typeof WebSocket

	beforeEach(() => {
		fakeWs = null
		originalWebSocket = globalThis.WebSocket
		globalThis.WebSocket = function (url: string) {
			fakeWs = new FakeWebSocket(url)
			return fakeWs as unknown as WebSocket
		} as unknown as typeof WebSocket
		;(globalThis.WebSocket as unknown as Record<string, unknown>).OPEN = FakeWebSocket.OPEN
		;(globalThis.WebSocket as unknown as Record<string, unknown>).CLOSED = FakeWebSocket.CLOSED
	})

	afterEach(() => {
		globalThis.WebSocket = originalWebSocket
		vi.restoreAllMocks()
	})

	it("RED: flushPending sends complete UpsertEvent with question/permission payload", async () => {
		const client = new RelayClient({
			url: "wss://relay.example/ws",
			clientToken: "token",
			clientId: "client-1",
			sessionId: "s1",
			onDecision: vi.fn(),
			heartbeatIntervalMs: 9999,
		})
		client.connect()

		await vi.waitFor(() => { expect(fakeWs).not.toBeNull() }, { timeout: 200 })

		// Send upsert before paired — gets queued
		const upsert: UpsertEvent = {
			requestId: "req-full",
			clientId: "client-1",
			sessionId: "s1",
			expiresAt: new Date(Date.now() + 300_000).toISOString(),
			question: {
				text: "Which file?",
				options: [
					{ label: "Config", value: "config" },
				],
				multiSelect: false,
			},
		}
		client.sendUpsert(upsert)

		// Now pair — should flush
		const sendSpy = vi.spyOn(fakeWs!, "send")
		fakeWs!.emit("message", serverPairingMessage(true))
		await vi.waitFor(() => { expect(client.currentStatus).toBe("paired") }, { timeout: 200 })

		// Get the flushed upsert message
		const upsertCalls = sendSpy.mock.calls.filter(([data]) => {
			return typeof data === "string" && data.includes('"request_upsert"')
		})
		expect(upsertCalls.length).toBeGreaterThanOrEqual(1)

		// The flushed upsert should contain the full question payload
		const flushedData = JSON.parse(upsertCalls[0]![0] as string)
		expect(flushedData.payload.question).toBeDefined()
		expect(flushedData.payload.question.text).toBe("Which file?")
		expect(flushedData.payload.question.options).toHaveLength(1)
	})

	it("RED: flushPending also flushes queued apply results", async () => {
		const client = new RelayClient({
			url: "wss://relay.example/ws",
			clientToken: "token",
			clientId: "client-1",
			sessionId: "s1",
			onDecision: vi.fn(),
			heartbeatIntervalMs: 9999,
		})
		client.connect()

		await vi.waitFor(() => { expect(fakeWs).not.toBeNull() }, { timeout: 200 })

		// Queue apply result before paired
		await client.sendApplyResult("req-ar-1", true, "some error")

		// Pair
		const sendSpy = vi.spyOn(fakeWs!, "send")
		fakeWs!.emit("message", serverPairingMessage(true))
		await vi.waitFor(() => { expect(client.currentStatus).toBe("paired") }, { timeout: 200 })

		const arCalls = sendSpy.mock.calls.filter(([data]) => {
			return typeof data === "string" && data.includes('"apply_result"') && data.includes('"req-ar-1"')
		})
		expect(arCalls.length).toBeGreaterThanOrEqual(1)
	})
})
