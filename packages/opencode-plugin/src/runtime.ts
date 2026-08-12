import { randomUUID } from "node:crypto"
import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { ensureConfigMode, loadConfig, writeConfig, type OpenCodeNotifyConfig } from "./config.js"
import { createNotifyPlugin } from "./notify.js"
import { RelayBridge } from "./relay-bridge.js"
import type { OpencodeClient } from "./opencode-client.js"

interface PairingCode {
	code: string
	expiresAt: Date
}

const PAIRING_TOAST_DURATION_MS = 30_000
const PAIRING_TOAST_INTERVAL_MS = 15_000
const PAIRING_RETRY_DELAY_MS = 15_000

function pairingUrl(relayUrl: string): string {
	const url = new URL(relayUrl)
	if (url.protocol === "wss:") url.protocol = "https:"
	if (url.protocol === "ws:") url.protocol = "http:"
	url.pathname = "/v1/pairing"
	url.search = ""
	return url.toString()
}

async function requestPairingCode(relayUrl: string): Promise<PairingCode> {
	const response = await fetch(pairingUrl(relayUrl), {
		method: "POST",
		signal: AbortSignal.timeout(10_000),
	})
	if (!response.ok) throw new Error(`Relay pairing request failed: ${response.status}`)
	const body = await response.json() as { code?: unknown; expiresAt?: unknown }
	if (typeof body.code !== "string" || !body.code) throw new Error("Relay returned an invalid pairing code")
	const expiresAt = new Date(typeof body.expiresAt === "string" ? body.expiresAt : "")
	if (Number.isNaN(expiresAt.getTime())) throw new Error("Relay returned an invalid pairing expiry")
	return { code: body.code, expiresAt }
}

export const OpenCodeNotifyPlugin: Plugin = async (input: PluginInput) => {
	const config = await loadConfig()
	await ensureConfigMode()
	const relay = config.relay
	if (!relay?.enabled || !relay.url) return createNotifyPlugin(config.desktop)(input)
	const relayUrl = relay.url

	let clientId = relay.clientId ?? randomUUID()
	let pairing: PairingCode | undefined
	try {
		pairing = relay.clientToken ? undefined : await requestPairingCode(relayUrl)
	} catch (error) {
		console.warn(`OpenCode Notify relay unavailable; using desktop notifications: ${error instanceof Error ? error.message : String(error)}`)
		return createNotifyPlugin(config.desktop)(input)
	}
	if (pairing) console.info(`OpenCode Notify pairing code: ${pairing.code}. Send /pair ${pairing.code} to Telegram.`)

	let reminderTimer: ReturnType<typeof setInterval> | undefined
	let expiryTimer: ReturnType<typeof setTimeout> | undefined
	let retryTimer: ReturnType<typeof setTimeout> | undefined
	let disposed = false
	let paired = Boolean(relay.clientToken)
	let renewing = false

	const clearPairingTimers = () => {
		if (reminderTimer) clearInterval(reminderTimer)
		if (expiryTimer) clearTimeout(expiryTimer)
		if (retryTimer) clearTimeout(retryTimer)
		reminderTimer = undefined
		expiryTimer = undefined
		retryTimer = undefined
	}

	const showPairingCode = () => {
		if (!pairing || paired || disposed || Date.now() >= pairing.expiresAt.getTime()) return
		void input.client.tui.showToast({
			body: {
				title: "OpenCode Notify pairing",
				message: `Send /pair ${pairing.code} to Telegram.`,
				variant: "info",
				duration: PAIRING_TOAST_DURATION_MS,
			},
		}).catch(() => {})
	}

	const schedulePairingReminders = () => {
		if (!pairing || paired || disposed) return
		clearPairingTimers()
		showPairingCode()
		reminderTimer = setInterval(showPairingCode, PAIRING_TOAST_INTERVAL_MS)
		const delay = Math.max(0, pairing.expiresAt.getTime() - Date.now())
		expiryTimer = setTimeout(() => void renewPairingCode(), delay)
	}

	const persist = async (token: string | undefined, issuedClientId: string) => {
		if (token) {
			paired = true
			clearPairingTimers()
		}
		if (issuedClientId) clientId = issuedClientId
		const next: OpenCodeNotifyConfig = {
			...config,
			relay: { ...relay, clientId, ...(token ? { clientToken: token } : {}) },
		}
		await writeConfig(next)
		if (token) {
			void input.client.tui.showToast({
				body: {
					title: "OpenCode Notify",
					message: "Telegram pairing completed.",
					variant: "success",
					duration: 5_000,
				},
			}).catch(() => {})
		}
	}

	const bridge = new RelayBridge({
			config: { ...config, relay: { ...relay, clientId, clientToken: relay.clientToken } },
			opencodeClient: input.client as unknown as OpencodeClient,
			clientId,
			sessionId: randomUUID(),
			pairingCode: pairing?.code,
			onPairingFailure: () => void renewPairingCode(),
			onTokenIssued: persist,
		})

	const renewPairingCode = async () => {
		if (disposed || paired || renewing) return
		renewing = true
		clearPairingTimers()
		try {
			const replacement = await requestPairingCode(relayUrl)
			if (disposed || paired) return
			pairing = replacement
			console.info(`OpenCode Notify pairing code: ${pairing.code}. Send /pair ${pairing.code} to Telegram.`)
			bridge.replacePairingCode(pairing.code)
			schedulePairingReminders()
		} catch (error) {
			console.warn(`OpenCode Notify could not renew pairing code: ${error instanceof Error ? error.message : String(error)}`)
			if (!disposed && !paired) retryTimer = setTimeout(() => void renewPairingCode(), PAIRING_RETRY_DELAY_MS)
		} finally {
			renewing = false
		}
	}

	bridge.start()
	schedulePairingReminders()
	const hooks = await createNotifyPlugin(config.desktop, { relayBridge: bridge })(input)
	return {
		...hooks,
		dispose: async () => {
			disposed = true
			clearPairingTimers()
			bridge.stop()
			await hooks.dispose?.()
		},
	}
}

export default { id: "@nomli/opencode-notify", server: OpenCodeNotifyPlugin }
