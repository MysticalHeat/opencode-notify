import type { DecisionMessage } from "@repo/protocol"
import type { OpenCodeNotifyConfig } from "./config.js"
import type { UpsertEvent, CancelEvent } from "./events.js"
import { eventToUpsert } from "./events.js"
import type { RelayClientOptions } from "./relay-client.js"
import { RelayClient } from "./relay-client.js"
import type { OpencodeClient } from "./opencode-client.js"
import {
	applyQuestion,
	rejectQuestion,
	applyPermission,
} from "./opencode-client.js"

export interface IRelayClient {
	connect(): void
	shutdown(): void
	sendUpsert(event: UpsertEvent): void
	sendCancel(event: CancelEvent): void
	sendApplyResult(requestId: string, success: boolean, error?: string): Promise<void>
}

export interface IRelayBridge {
	start(): void
	stop(): void
	handleEvent(event: { type?: string; properties?: unknown }): void
}

export type RelayClientFactory = (opts: RelayClientOptions) => IRelayClient

export interface RelayBridgeDeps {
	config: OpenCodeNotifyConfig
	opencodeClient: OpencodeClient
	clientId: string
	sessionId: string
	relayClientFactory?: RelayClientFactory
}

const defaultRelayClientFactory: RelayClientFactory = (opts) =>
	new RelayClient({
		url: opts.url,
		clientToken: opts.clientToken,
		clientId: opts.clientId,
		sessionId: opts.sessionId,
		onDecision: opts.onDecision,
		onStatusChange: opts.onStatusChange,
		heartbeatIntervalMs: opts.heartbeatIntervalMs,
		maxReconnectDelayMs: opts.maxReconnectDelayMs,
	})

export class RelayBridge {
	private relayClient: IRelayClient | null = null
	private readonly config: OpenCodeNotifyConfig
	private readonly opencodeClient: OpencodeClient
	private readonly clientId: string
	private readonly sessionId: string
	private readonly factory: RelayClientFactory

	constructor(deps: RelayBridgeDeps) {
		this.config = deps.config
		this.opencodeClient = deps.opencodeClient
		this.clientId = deps.clientId
		this.sessionId = deps.sessionId
		this.factory = deps.relayClientFactory ?? defaultRelayClientFactory
	}

	start(): void {
		const relay = this.config.relay
		if (!relay?.enabled) return
		if (!relay.url || !relay.clientToken) return

		this.relayClient = this.factory({
			url: relay.url,
			clientToken: relay.clientToken,
			clientId: this.clientId,
			sessionId: this.sessionId,
			onDecision: (decision) => {
				void this.processDecision(decision)
			},
		})
		this.relayClient.connect()
	}

	stop(): void {
		if (!this.relayClient) return
		this.relayClient.shutdown()
		this.relayClient = null
	}

	handleEvent(event: { type?: string; properties?: unknown }): void {
		if (!this.relayClient) return
		const upsert = eventToUpsert(event, this.clientId)
		if (upsert) {
			this.relayClient.sendUpsert(upsert)
			return
		}
	}

	private async processDecision(decision: DecisionMessage): Promise<void> {
		const rlc = this.relayClient
		if (!rlc) return

		const { payload } = decision
		const sessionID = payload.sessionId
		const requestID = payload.requestId

		let result: "applied" | "expired" | "failed" = "failed"

		try {
			if (payload.answers) {
				if (payload.answers.length > 0) {
					result = await applyQuestion({
						sessionID,
						requestID,
						answers: payload.answers,
						client: this.opencodeClient,
					})
				} else {
					result = await rejectQuestion({
						sessionID,
						requestID,
						client: this.opencodeClient,
					})
				}
			} else if (payload.approved !== undefined) {
				let reply: "once" | "always" | "reject"
				if (!payload.approved) {
					reply = "reject"
				} else if (payload.always === true) {
					reply = "always"
				} else {
					reply = "once"
				}

				result = await applyPermission({
					sessionID,
					requestID,
					reply,
					client: this.opencodeClient,
				})
			}
		} catch (err) {
			const msg = String(err instanceof Error ? err.message : err)
			result = msg.includes("404") || msg.includes("not found") || msg.includes("Not Found")
				? "expired"
				: "failed"
		}

		if (rlc) {
			void rlc.sendApplyResult(
				requestID,
				result === "applied",
				result !== "applied" ? result : undefined,
			)
		}
	}
}
