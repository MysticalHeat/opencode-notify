import { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
import { createServer } from "node:net"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { PluginInput } from "@opencode-ai/plugin"
import { afterEach, describe, expect, it, vi } from "vitest"
import { startPresenceTui } from "../src/tui.js"
import { PresenceBroker, discoverPresence, tuiPresenceKey } from "../src/presence.js"

const loadConfig = vi.fn()
const createNotifyPlugin = vi.fn()
vi.mock("../src/config.js", () => ({ loadConfig, ensureConfigMode: async () => {}, writeConfig: async () => {} }))
vi.mock("../src/notify.js", () => ({ createNotifyPlugin }))
const { OpenCodeNotifyPlugin } = await import("../src/runtime.js")

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks() })

function setup(relay = false) {
	loadConfig.mockResolvedValue({ desktop: {}, relay: relay ? { enabled: true, url: "wss://relay.invalid" } : undefined })
	const deps: Array<{ presence?: { isActive(id: string): boolean } }> = []
	createNotifyPlugin.mockImplementation((_config, options) => { deps.push(options); return async () => ({ dispose: vi.fn() }) })
	return deps
}
function input(url: URL, directory: string): PluginInput {
	return { serverUrl: url, directory, client: {} } as unknown as PluginInput
}
function startTui(url: string, directory: string) {
	const renderer = new EventEmitter()
	const controller = new AbortController()
	const api = {
		client: createOpencodeClient({ baseUrl: url }),
		state: { path: { directory } },
		route: { current: { name: "session", params: { sessionID: "s1" } } },
		renderer,
		lifecycle: { signal: controller.signal, onDispose: () => {} },
	}
	cleanup.push(startPresenceTui(api, { pollMs: 10, heartbeatMs: 40, reconnectMs: 20 }))
	return { renderer, api }
}

describe("runtime presence discovery", () => {
	it("discovers the in-process worker and stops suppressing immediately when another broker is ambiguous", async () => {
		const deps = setup()
		const directory = `/tmp/notify-test-${randomUUID()}`
		const first = await OpenCodeNotifyPlugin(input(new URL("http://localhost:4096"), directory))
		cleanup.push(() => first.dispose?.())
		expect(deps[0]!.presence).toBeDefined()
		const { renderer } = startTui("http://opencode.internal", directory)
		await vi.waitFor(() => { renderer.emit("focus"); expect(deps[0]!.presence!.isActive("s1")).toBe(true) })
		expect(deps[0]!.presence!.isActive("s2")).toBe(false)
		const second = await OpenCodeNotifyPlugin(input(new URL("http://localhost:4096"), directory))
		cleanup.push(() => second.dispose?.())
		expect(deps[0]!.presence!.isActive("s1")).toBe(false)
		expect(deps[1]!.presence!.isActive("s1")).toBe(false)
		await second.dispose?.()
		await vi.waitFor(() => { renderer.emit("focus"); expect(deps[0]!.presence!.isActive("s1")).toBe(true) })
		await first.dispose?.()
		expect(deps[0]!.presence!.isActive("s1")).toBe(false)
	})

	it("matches a proven local TCP listener and fails open for a different server URL", async () => {
		const deps = setup()
		const server = createServer()
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
		cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
		const address = server.address()
		if (!address || typeof address === "string") throw new Error("missing listener")
		const url = `http://127.0.0.1:${address.port}`
		const directory = `/tmp/notify-test-${randomUUID()}`
		const hooks = await OpenCodeNotifyPlugin(input(new URL(url), directory))
		cleanup.push(() => hooks.dispose?.())
		expect(deps[0]!.presence).toBeDefined()
		const wrong = startTui(`http://127.0.0.1:${address.port === 1 ? 2 : address.port - 1}`, directory)
		wrong.renderer.emit("focus")
		await new Promise(resolve => setTimeout(resolve, 80))
		expect(deps[0]!.presence!.isActive("s1")).toBe(false)
		const right = startTui(url, directory)
		await vi.waitFor(() => { right.renderer.emit("focus"); expect(deps[0]!.presence!.isActive("s1")).toBe(true) })
		await new Promise<void>(resolve => server.close(() => resolve()))
		expect(deps[0]!.presence!.isActive("s1")).toBe(false)
	})

	it("retains presence on relay pairing failure and tolerates unsupported discovery", async () => {
		const deps = setup(true)
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")))
		cleanup.push(() => vi.unstubAllGlobals())
		const directory = `/tmp/notify-test-${randomUUID()}`
		const hooks = await OpenCodeNotifyPlugin(input(new URL("http://localhost:4096"), directory))
		cleanup.push(() => hooks.dispose?.())
		expect(deps[0]!.presence).toBeDefined()
		const tui = startTui("http://opencode.internal", directory)
		await vi.waitFor(() => { tui.renderer.emit("focus"); expect(deps[0]!.presence!.isActive("s1")).toBe(true) })
		const other = await OpenCodeNotifyPlugin(input(new URL("https://remote.example"), directory))
		cleanup.push(() => other.dispose?.())
		expect(deps[1]!.presence).toBeUndefined()
	})

	it("continues when the broker cannot start and cleans registration if plugin initialization throws", async () => {
		const deps = setup()
		const directory = `/tmp/notify-test-${randomUUID()}`
		const start = vi.spyOn(PresenceBroker, "start").mockRejectedValueOnce(new Error("socket unavailable"))
		const hooks = await OpenCodeNotifyPlugin(input(new URL("http://localhost:4096"), directory))
		cleanup.push(() => hooks.dispose?.())
		expect(deps[0]!.presence).toBeUndefined()
		start.mockRestore()
		createNotifyPlugin.mockImplementationOnce(() => async () => { throw new Error("init failed") })
		await expect(OpenCodeNotifyPlugin(input(new URL("http://localhost:4096"), directory))).rejects.toThrow("init failed")
		const key = tuiPresenceKey("http://opencode.internal", directory)!
		expect(discoverPresence(key)).toBeUndefined()
	})
})
