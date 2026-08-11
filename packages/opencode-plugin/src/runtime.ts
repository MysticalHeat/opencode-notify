import { randomUUID } from "node:crypto"
import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { ensureConfigMode, loadConfig, writeConfig, type OpenCodeNotifyConfig } from "./config.js"
import { createNotifyPlugin } from "./notify.js"
import { RelayBridge } from "./relay-bridge.js"
import type { OpencodeClient } from "./opencode-client.js"

function pairingUrl(relayUrl: string): string {
	const url = new URL(relayUrl)
	if (url.protocol === "wss:") url.protocol = "https:"
	if (url.protocol === "ws:") url.protocol = "http:"
	url.pathname = "/v1/pairing"
	url.search = ""
	return url.toString()
}

async function requestPairingCode(relayUrl: string): Promise<string> {
	const response = await fetch(pairingUrl(relayUrl), { method: "POST" })
	if (!response.ok) throw new Error(`Relay pairing request failed: ${response.status}`)
	const body = await response.json() as { code?: unknown }
	if (typeof body.code !== "string" || !body.code) throw new Error("Relay returned an invalid pairing code")
	return body.code
}

export const OpenCodeNotifyPlugin: Plugin = async (input: PluginInput) => {
	const config = await loadConfig()
	await ensureConfigMode()
	const relay = config.relay
	if (!relay?.enabled || !relay.url) return createNotifyPlugin(config.desktop)(input)

	let clientId = relay.clientId ?? randomUUID()
	const pairingCode = relay.clientToken ? undefined : await requestPairingCode(relay.url)
	if (pairingCode) console.info(`OpenCode Notify pairing code: ${pairingCode}. Send /pair ${pairingCode} to Telegram.`)

	const persist = async (token?: string, issuedClientId?: string) => {
		if (issuedClientId) clientId = issuedClientId
		const next: OpenCodeNotifyConfig = {
			...config,
			relay: { ...relay, clientId, ...(token ? { clientToken: token } : {}) },
		}
		await writeConfig(next)
	}
	await persist()

	const bridge = new RelayBridge({
		config: { ...config, relay: { ...relay, clientId, clientToken: relay.clientToken ?? pairingCode } },
		opencodeClient: input.client as unknown as OpencodeClient,
		clientId,
		sessionId: randomUUID(),
		pairingCode,
		onTokenIssued: persist,
	})
	const hooks = await createNotifyPlugin(config.desktop, { relayBridge: bridge })(input)
	return { ...hooks, dispose: async () => bridge.stop() }
}

export default { id: "@nomli/opencode-notify", server: OpenCodeNotifyPlugin }
