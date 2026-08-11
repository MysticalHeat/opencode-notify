import { randomBytes } from "node:crypto"
import { parseServerMessage } from "@repo/protocol"
import type { ServerMessage, DecisionMessage } from "@repo/protocol"
import type { UpsertEvent, CancelEvent } from "./events.js"
import {
	buildUpsertMessage,
	buildCancelMessage,
} from "./events.js"

export type RelayDecisionCallback = (decision: DecisionMessage) => void
export type RelayStatusCallback = (status: RelayStatus) => void

export type RelayStatus =
	| "disconnected"
	| "connecting"
	| "connected"
	| "paired"
	| "reconnecting"
	| "shutdown"

export interface RelayClientOptions {
	url: string
	clientToken: string
	pairingCode?: string
	clientId: string
	sessionId: string
	onDecision: RelayDecisionCallback
	onStatusChange?: RelayStatusCallback
	onTokenIssued?: (token: string, clientId: string) => void | Promise<void>
	heartbeatIntervalMs?: number
	maxReconnectDelayMs?: number
}

interface QueuedApplyResult {
	requestId: string
	success: boolean
	error?: string
}

const DEFAULT_HEARTBEAT_MS = 30_000
const DEFAULT_MAX_RECONNECT_MS = 120_000
const BASE_RECONNECT_MS = 1000
const JITTER_FACTOR = 0.3
const DECISION_DEDUPE_TTL_MS = 5 * 60 * 1000
const DECISION_DEDUPE_MAX_ENTRIES = 1000

export class RelayClient {
	private ws: WebSocket | null = null
	private status: RelayStatus = "disconnected"
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null
	private reconnectAttempt = 0
	private shutdownRequested = false
	private seenDecisions = new Map<string, number>()
	private pendingUpserts = new Map<string, UpsertEvent>()
	private pendingApplyResults: QueuedApplyResult[] = []
	private messageListener: ((event: MessageEvent) => void) | null = null
	private closeListener: ((event: CloseEvent) => void) | null = null

	readonly url: string
	private clientToken: string
	private pairingCode: string | undefined
	private clientId: string
	readonly sessionId: string
	readonly onDecision: RelayDecisionCallback
	readonly onStatusChange: RelayStatusCallback | undefined
	readonly onTokenIssued: ((token: string, clientId: string) => void | Promise<void>) | undefined
	private readonly heartbeatIntervalMs: number
	private readonly maxReconnectDelayMs: number

	constructor(options: RelayClientOptions) {
		this.url = options.url
		this.clientToken = options.clientToken
		this.pairingCode = options.pairingCode
		this.clientId = options.clientId
		this.sessionId = options.sessionId
		this.onDecision = options.onDecision
		this.onStatusChange = options.onStatusChange
		this.onTokenIssued = options.onTokenIssued
		this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS
		this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_MS
	}

	get currentStatus(): RelayStatus {
		return this.status
	}

	connect(): void {
		if (this.shutdownRequested) return
		this.setStatus("connecting")
		this.establishConnection()
	}

	shutdown(): void {
		this.shutdownRequested = true
		this.clearTimers()
		this.removeListeners()
		this.setStatus("shutdown")
		if (this.ws) {
			try { this.ws.close(1000, "client shutdown") } catch { /* ignore */ }
			this.ws = null
		}
		this.pendingApplyResults = []
	}

	sendUpsert(event: UpsertEvent): void {
		if (this.status !== "paired") {
			this.pendingUpserts.set(event.requestId, event)
			return
		}
		const msg = buildUpsertMessage(event, this.genMessageId())
		this.sendJson(msg)
	}

	sendCancel(event: CancelEvent): void {
		if (this.status !== "paired") {
			this.pendingUpserts.delete(event.requestId)
			return
		}
		const msg = buildCancelMessage(event, this.genMessageId())
		this.sendJson(msg)
	}

	async sendApplyResult(
		requestId: string,
		success: boolean,
		error?: string,
	): Promise<void> {
		if (this.shutdownRequested) return
		if (this.status !== "paired") {
			this.pendingApplyResults.push({ requestId, success, error })
			return
		}
		const msg = {
			protocolVersion: 1 as const,
			messageId: this.genMessageId(),
			type: "apply_result" as const,
			sentAt: new Date().toISOString(),
			payload: {
				requestId,
				clientId: this.clientId,
				sessionId: this.sessionId,
				success,
				error,
			},
		}
		this.sendJson(msg)
	}

	flushPending(): void {
		if (this.status !== "paired") return
		for (const event of this.pendingUpserts.values()) {
			const msg = buildUpsertMessage(event, this.genMessageId())
			this.sendJson(msg)
		}
		this.pendingUpserts.clear()
		this.flushPendingApplyResults()
	}

	private flushPendingApplyResults(): void {
		if (this.pendingApplyResults.length === 0) return
		const results = this.pendingApplyResults.splice(0)
		for (const ar of results) {
			const msg = {
				protocolVersion: 1 as const,
				messageId: this.genMessageId(),
				type: "apply_result" as const,
				sentAt: new Date().toISOString(),
				payload: {
					requestId: ar.requestId,
					clientId: this.clientId,
					sessionId: this.sessionId,
					success: ar.success,
					error: ar.error,
				},
			}
			this.sendJson(msg)
		}
	}

	private establishConnection(): void {
		this.removeListeners()
		if (this.ws) {
			try { this.ws.close() } catch { /* ignore */ }
			this.ws = null
		}

		let ws: WebSocket
		try {
			ws = new WebSocket(this.connectionUrl())
		} catch {
			this.scheduleReconnect()
			return
		}

		this.ws = ws

		this.messageListener = (event: MessageEvent) => {
			this.handleMessage(event.data)
		}
		this.closeListener = (event: CloseEvent) => {
			this.clearHeartbeat()
			this.ws = null
			this.removeListeners()
			if (this.shutdownRequested) return
			if (event.code === 4001) {
				this.setStatus("disconnected")
				return
			}
			this.scheduleReconnect()
		}

		ws.addEventListener("open", () => {
			this.reconnectAttempt = 0
			this.sendHello()
		})

		ws.addEventListener("message", this.messageListener)
		ws.addEventListener("close", this.closeListener)

		ws.addEventListener("error", () => {
		})
	}

	private removeListeners(): void {
		if (this.ws && this.messageListener) {
			try { this.ws.removeEventListener("message", this.messageListener) } catch { /* ignore */ }
		}
		if (this.ws && this.closeListener) {
			try { this.ws.removeEventListener("close", this.closeListener) } catch { /* ignore */ }
		}
		this.messageListener = null
		this.closeListener = null
	}

	private sendHello(): void {
		this.sendJson({
			protocolVersion: 1,
			messageId: this.genMessageId(),
			type: "hello",
			sentAt: new Date().toISOString(),
			payload: {
				clientId: this.clientId,
				sessionId: this.sessionId,
			},
		})
	}


	private connectionUrl(): string {
		const url = new URL(this.url)
		if (url.protocol === "https:") url.protocol = "wss:"
		if (url.protocol === "http:") url.protocol = "ws:"
		if (!url.pathname.endsWith("/v1/ws")) {
			url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/ws`
		}
		if (this.pairingCode) url.searchParams.set("pairing_code", this.pairingCode)
		else url.searchParams.set("token", this.clientToken)
		return url.toString()
	}

	private sendHeartbeat(): void {
		if (this.status !== "paired") return
		this.sendJson({
			protocolVersion: 1,
			messageId: this.genMessageId(),
			type: "heartbeat",
			sentAt: new Date().toISOString(),
			payload: {
				clientId: this.clientId,
				sessionId: this.sessionId,
			},
		})
	}

	private startHeartbeat(): void {
		this.clearHeartbeat()
		this.heartbeatTimer = setInterval(() => {
			this.sendHeartbeat()
		}, this.heartbeatIntervalMs)
	}

	private clearHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer)
			this.heartbeatTimer = null
		}
	}

	private addSeenDecision(key: string): boolean {
		this.pruneSeenDecisions()
		if (this.seenDecisions.has(key)) return false
		this.seenDecisions.set(key, Date.now())
		return true
	}

	private pruneSeenDecisions(): void {
		const now = Date.now()
		for (const [k, at] of this.seenDecisions) {
			if (now - at > DECISION_DEDUPE_TTL_MS) this.seenDecisions.delete(k)
		}
		if (this.seenDecisions.size > DECISION_DEDUPE_MAX_ENTRIES) {
			const entries = [...this.seenDecisions.entries()]
			entries.sort((a, b) => a[1] - b[1])
			for (let i = 0; i < entries.length - DECISION_DEDUPE_MAX_ENTRIES; i++) {
				this.seenDecisions.delete(entries[i]![0])
			}
		}
	}

	private handleMessage(data: unknown): void {
		let raw: unknown
		try {
			raw = typeof data === "string" ? JSON.parse(data) : data
		} catch {
			return
		}

		let msg: ServerMessage
		try {
			msg = parseServerMessage(raw)
		} catch {
			return
		}

		switch (msg.type) {
			case "pairing":
				if (msg.payload.paired) {
					if (msg.payload.token) {
						this.clientToken = msg.payload.token
						this.pairingCode = undefined
						this.clientId = msg.payload.clientId
						void this.onTokenIssued?.(msg.payload.token, this.clientId)
						this.sendHello()
					}
					this.setStatus("paired")
					this.startHeartbeat()
					this.flushPending()
				} else {
					this.setStatus("disconnected")
					if (this.ws) {
						try { this.ws.close(4001, "pairing rejected") } catch { /* ignore */ }
					}
				}
				break
			case "heartbeat":
				break
			case "decision": {
				const key = `${msg.payload.requestId}:${msg.messageId}`
				if (!this.addSeenDecision(key)) return
				try {
					this.onDecision(msg)
				} catch {
					/* callback exception must not escape handler */
				}
				break
			}
			case "error":
				break
			default:
				break
		}
	}

	private scheduleReconnect(): void {
		if (this.shutdownRequested) return
		this.setStatus("reconnecting")

		const delay = this.calcReconnectDelay()
		this.reconnectAttempt++

		this.reconnectTimer = setTimeout(() => {
			if (this.shutdownRequested) return
			this.establishConnection()
		}, delay)
	}

	private calcReconnectDelay(): number {
		const base = BASE_RECONNECT_MS * Math.pow(2, Math.min(this.reconnectAttempt, 10))
		const capped = Math.min(base, this.maxReconnectDelayMs)
		const jitter = capped * JITTER_FACTOR * (Math.random() * 2 - 1)
		return Math.round(capped + jitter)
	}

	private sendJson(obj: unknown): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
		try {
			this.ws.send(JSON.stringify(obj))
		} catch {
			/* send failure is non-blocking */
		}
	}

	private genMessageId(): string {
		const hex = randomBytes(12).toString("hex")
		return `relay-${Date.now()}-${hex}`
	}

	private setStatus(next: RelayStatus): void {
		if (this.status === next) return
		this.status = next
		try { this.onStatusChange?.(next) } catch { /* non-blocking */ }
	}

	private clearTimers(): void {
		this.clearHeartbeat()
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = null
		}
	}
}
