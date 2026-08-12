import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PluginInput } from "@opencode-ai/plugin"

const loadConfig = vi.fn()
const ensureConfigMode = vi.fn()
const writeConfig = vi.fn()
const createNotifyPlugin = vi.fn()
const relayBridgeInstances: FakeRelayBridge[] = []

class FakeRelayBridge {
	readonly start = vi.fn()
	readonly stop = vi.fn()
	readonly replacePairingCode = vi.fn()

	constructor(readonly options: Record<string, unknown>) {
		relayBridgeInstances.push(this)
	}
}

vi.mock("../src/config.js", () => ({ loadConfig, ensureConfigMode, writeConfig }))
vi.mock("../src/notify.js", () => ({ createNotifyPlugin }))
vi.mock("../src/relay-bridge.js", () => ({ RelayBridge: FakeRelayBridge }))

const { OpenCodeNotifyPlugin } = await import("../src/runtime.js")

function pairingResponse(code: string, expiresAt = new Date(Date.now() + 60_000).toISOString()) {
	return new Response(JSON.stringify({ code, expiresAt }), { status: 200 })
}

function input(showToast = vi.fn().mockResolvedValue({})): PluginInput {
	return {
		client: { tui: { showToast } },
	} as unknown as PluginInput
}

describe("OpenCodeNotifyPlugin pairing", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.clearAllMocks()
		relayBridgeInstances.length = 0
		loadConfig.mockResolvedValue({
			version: 1,
			relay: { enabled: true, url: "wss://relay.example.com" },
		})
		ensureConfigMode.mockResolvedValue(undefined)
		writeConfig.mockResolvedValue(undefined)
		createNotifyPlugin.mockReturnValue(async () => ({ dispose: vi.fn() }))
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	it("keeps the pairing code visible until it is confirmed", async () => {
		const showToast = vi.fn().mockResolvedValue({})
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(pairingResponse("ABCD-1234")))

		const hooks = await OpenCodeNotifyPlugin(input(showToast))
		expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
			body: expect.objectContaining({
				message: "Send /pair ABCD-1234 to Telegram.",
				duration: 30_000,
			}),
		}))

		await vi.advanceTimersByTimeAsync(15_000)
		expect(showToast).toHaveBeenCalledTimes(2)
		await hooks.dispose?.()
	})

	it("stops pairing reminders after persisting the issued token", async () => {
		const showToast = vi.fn().mockResolvedValue({})
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(pairingResponse("ABCD-1234")))
		const hooks = await OpenCodeNotifyPlugin(input(showToast))
		const onTokenIssued = relayBridgeInstances[0]!.options.onTokenIssued as (token: string, clientId: string) => Promise<void>

		await onTokenIssued("issued-token", "client-002")
		expect(writeConfig).toHaveBeenCalledWith(expect.objectContaining({
			relay: expect.objectContaining({ clientId: "client-002", clientToken: "issued-token" }),
		}))
		expect(showToast).toHaveBeenLastCalledWith(expect.objectContaining({
			body: expect.objectContaining({ variant: "success" }),
		}))

		await vi.advanceTimersByTimeAsync(30_000)
		expect(showToast).toHaveBeenCalledTimes(2)
		await hooks.dispose?.()
	})

	it("replaces an expired pairing code without restarting OpenCode", async () => {
		const showToast = vi.fn().mockResolvedValue({})
		vi.stubGlobal("fetch", vi.fn()
			.mockResolvedValueOnce(pairingResponse("ABCD-1234", new Date(Date.now() + 1_000).toISOString()))
			.mockResolvedValueOnce(pairingResponse("WXYZ-9876")))

		const hooks = await OpenCodeNotifyPlugin(input(showToast))
		await vi.advanceTimersByTimeAsync(1_000)

		expect(relayBridgeInstances).toHaveLength(1)
		expect(relayBridgeInstances[0]!.replacePairingCode).toHaveBeenCalledWith("WXYZ-9876")
		expect(showToast).toHaveBeenLastCalledWith(expect.objectContaining({
			body: expect.objectContaining({ message: "Send /pair WXYZ-9876 to Telegram." }),
		}))
		await hooks.dispose?.()
	})

	it("cleans up pairing reminders and bridge when disposed", async () => {
		const showToast = vi.fn().mockResolvedValue({})
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(pairingResponse("ABCD-1234")))
		const hooks = await OpenCodeNotifyPlugin(input(showToast))
		await hooks.dispose?.()

		expect(relayBridgeInstances[0]!.stop).toHaveBeenCalledOnce()
		await vi.advanceTimersByTimeAsync(60_000)
		expect(showToast).toHaveBeenCalledTimes(1)
	})
})
