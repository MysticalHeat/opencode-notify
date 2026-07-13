import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { RelayClient } from "../src/relay-client.js"
import type { DecisionMessage } from "@repo/protocol"

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

	send() {}
	close() {
		this.readyState = FakeWebSocket.CLOSED
	}

	removeEventListener() {}
}

function makeDecision(requestId: string, approved = true, always?: boolean): DecisionMessage {
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
			...always !== undefined ? { always } : {},
		},
	} as DecisionMessage
}

function makeAnswersDecision(requestId: string, answers: Array<{ value: string; label: string }>): DecisionMessage {
	return {
		protocolVersion: 1,
		messageId: `srv-dec-${requestId}`,
		type: "decision",
		sentAt: new Date().toISOString(),
		payload: {
			requestId,
			clientId: "client-opencode-001",
			sessionId: "session-abc123",
			answers,
		},
	}
}

function serverPairingMessage(paired: boolean) {
	return JSON.stringify({
		protocolVersion: 1,
		messageId: `srv-pair-${Date.now()}`,
		type: "pairing",
		sentAt: new Date().toISOString(),
		payload: {
			clientId: "client-opencode-001",
			sessionId: "session-abc123",
			paired,
		},
	})
}

describe("RelayClient", () => {
	let fakeWs: FakeWebSocket | null = null
	let originalWebSocket: typeof WebSocket

	beforeEach(() => {
		fakeWs = null
		originalWebSocket = globalThis.WebSocket
		globalThis.WebSocket = function(url: string) {
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

	function createClient(overrides?: Partial<Parameters<typeof RelayClient.prototype.constructor>[0]>) {
		return new RelayClient({
			url: "wss://relay.example/ws",
			clientToken: "pairing-token-123",
			clientId: "client-opencode-001",
			sessionId: "session-abc123",
			onDecision: vi.fn(),
			onStatusChange: vi.fn(),
			heartbeatIntervalMs: 100,
			maxReconnectDelayMs: 200,
			...overrides,
		})
	}

	it("transitions to connecting then paired on successful handshake", async () => {
		const onStatus = vi.fn()
		const client = createClient({ onStatusChange: onStatus })
		client.connect()

		await vi.waitFor(() => {
			expect(onStatus).toHaveBeenCalledWith("connecting")
		}, { timeout: 200 })

		expect(fakeWs).not.toBeNull()

		fakeWs!.emit("message", serverPairingMessage(true))

		await vi.waitFor(() => {
			expect(onStatus).toHaveBeenCalledWith("paired")
		}, { timeout: 200 })
	})

	it("calls onDecision when a decision message arrives", async () => {
		const onDecision = vi.fn()
		const client = createClient({ onDecision })
		client.connect()

		await vi.waitFor(() => {
			expect(fakeWs).not.toBeNull()
		}, { timeout: 200 })

		fakeWs!.emit("message", serverPairingMessage(true))

		await vi.waitFor(() => {
			expect(client.currentStatus).toBe("paired")
		}, { timeout: 200 })

		const dec = makeDecision("req-001")
		fakeWs!.emit("message", JSON.stringify(dec))

		await vi.waitFor(() => {
			expect(onDecision).toHaveBeenCalledTimes(1)
		}, { timeout: 200 })

		expect(onDecision).toHaveBeenCalledWith(
			expect.objectContaining({ type: "decision" }),
		)
	})

	it("deduplicates decisions by messageId", async () => {
		const onDecision = vi.fn()
		const client = createClient({ onDecision })
		client.connect()

		await vi.waitFor(() => { expect(fakeWs).not.toBeNull() }, { timeout: 200 })
		fakeWs!.emit("message", serverPairingMessage(true))
		await vi.waitFor(() => { expect(client.currentStatus).toBe("paired") }, { timeout: 200 })

		const dec = makeDecision("req-001")
		fakeWs!.emit("message", JSON.stringify(dec))
		fakeWs!.emit("message", JSON.stringify(dec))

		await vi.waitFor(() => {
			expect(onDecision).toHaveBeenCalledTimes(1)
		}, { timeout: 200 })
	})

	it("reconnects with backoff on connection loss", async () => {
		const onStatus = vi.fn()
		const client = createClient({ onStatusChange: onStatus })

		client.connect()

		await vi.waitFor(() => {
			expect(onStatus).toHaveBeenCalledWith("connecting")
		}, { timeout: 200 })

		fakeWs!.emit("message", serverPairingMessage(true))

		await vi.waitFor(() => {
			expect(onStatus).toHaveBeenCalledWith("paired")
		}, { timeout: 200 })

		fakeWs!.emit("close", { code: 1006, reason: "" })

		await vi.waitFor(() => {
			expect(onStatus).toHaveBeenCalledWith("reconnecting")
		}, { timeout: 300 })
	})

	it("does not reconnect after shutdown", async () => {
		const client = createClient()
		client.connect()

		await vi.waitFor(() => { expect(fakeWs).not.toBeNull() }, { timeout: 200 })

		fakeWs!.emit("message", serverPairingMessage(true))
		await vi.waitFor(() => { expect(client.currentStatus).toBe("paired") }, { timeout: 200 })

		client.shutdown()
		expect(client.currentStatus).toBe("shutdown")

		fakeWs!.emit("close", { code: 1000, reason: "" })

		await new Promise((r) => setTimeout(r, 200))
		expect(client.currentStatus).toBe("shutdown")
	})

	it("sends heartbeat while paired", async () => {
		const client = createClient({ heartbeatIntervalMs: 20 })
		client.connect()

		await vi.waitFor(() => { expect(fakeWs).not.toBeNull() }, { timeout: 200 })

		const sendSpy = vi.spyOn(fakeWs!, "send")
		fakeWs!.emit("message", serverPairingMessage(true))

		await vi.waitFor(() => { expect(client.currentStatus).toBe("paired") }, { timeout: 200 })

		await vi.waitFor(() => {
			const hbCalls = sendSpy.mock.calls.filter(([data]) =>
				typeof data === "string" && data.includes('"heartbeat"'),
			)
			expect(hbCalls.length).toBeGreaterThan(0)
		}, { timeout: 500, interval: 10 })
	}, 5000)

	it("preserves always flag in decision through parseServerMessage", async () => {
		const onDecision = vi.fn()
		const client = createClient({ onDecision })
		client.connect()

		await vi.waitFor(() => { expect(fakeWs).not.toBeNull() }, { timeout: 200 })
		fakeWs!.emit("message", serverPairingMessage(true))
		await vi.waitFor(() => { expect(client.currentStatus).toBe("paired") }, { timeout: 200 })

		const dec = makeDecision("req-always", true, true)
		fakeWs!.emit("message", JSON.stringify(dec))

		await vi.waitFor(() => {
			expect(onDecision).toHaveBeenCalledTimes(1)
		}, { timeout: 200 })

		const calledWith: DecisionMessage = onDecision.mock.calls[0]![0]
		expect(calledWith.payload.always).toBe(true)
	})

	it("preserves always false in decision message", async () => {
		const onDecision = vi.fn()
		const client = createClient({ onDecision })
		client.connect()

		await vi.waitFor(() => { expect(fakeWs).not.toBeNull() }, { timeout: 200 })
		fakeWs!.emit("message", serverPairingMessage(true))
		await vi.waitFor(() => { expect(client.currentStatus).toBe("paired") }, { timeout: 200 })

		const dec = makeDecision("req-once", true, false)
		fakeWs!.emit("message", JSON.stringify(dec))

		await vi.waitFor(() => {
			expect(onDecision).toHaveBeenCalledTimes(1)
		}, { timeout: 200 })

		const calledWith: DecisionMessage = onDecision.mock.calls[0]![0]
		expect(calledWith.payload.always).toBe(false)
	})

	it("always field is absent from decision when not provided", async () => {
		const onDecision = vi.fn()
		const client = createClient({ onDecision })
		client.connect()

		await vi.waitFor(() => { expect(fakeWs).not.toBeNull() }, { timeout: 200 })
		fakeWs!.emit("message", serverPairingMessage(true))
		await vi.waitFor(() => { expect(client.currentStatus).toBe("paired") }, { timeout: 200 })

		const dec = makeDecision("req-no-always", true)
		fakeWs!.emit("message", JSON.stringify(dec))

		await vi.waitFor(() => {
			expect(onDecision).toHaveBeenCalledTimes(1)
		}, { timeout: 200 })

		const calledWith: DecisionMessage = onDecision.mock.calls[0]![0]
		expect(calledWith.payload.always).toBeUndefined()
	})

	it("handles malformed messages gracefully", async () => {
		const onDecision = vi.fn()
		const client = createClient({ onDecision })
		client.connect()

		await vi.waitFor(() => { expect(fakeWs).not.toBeNull() }, { timeout: 200 })

		fakeWs!.emit("message", "not json")
		fakeWs!.emit("message", JSON.stringify({ type: "unknown", payload: {} }))

		expect(onDecision).not.toHaveBeenCalled()
	})

	it("treats answers decision correctly (question reply)", async () => {
		const onDecision = vi.fn()
		const client = createClient({ onDecision })
		client.connect()

		await vi.waitFor(() => { expect(fakeWs).not.toBeNull() }, { timeout: 200 })
		fakeWs!.emit("message", serverPairingMessage(true))
		await vi.waitFor(() => { expect(client.currentStatus).toBe("paired") }, { timeout: 200 })

		const dec = makeAnswersDecision("req-q", [{ value: "opt-a", label: "Option A" }])
		fakeWs!.emit("message", JSON.stringify(dec))

		await vi.waitFor(() => {
			expect(onDecision).toHaveBeenCalledTimes(1)
		}, { timeout: 200 })
	})
})
