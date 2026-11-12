import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createNotifyPlugin } from "../src/notify.js"
import { RelayBridge } from "../src/relay-bridge.js"
import { loadConfig, type FsAbstraction } from "../src/config.js"
import type { PluginInput } from "@opencode-ai/plugin"

vi.mock("../src/backend.js", () => ({
	canUseCmuxNotification: () => false,
	sendCmuxNotification: vi.fn(),
	sendDesktopNotification: vi.fn(),
	sendNotificationWithFallback: async (opts: { sendNodeNotify: () => Promise<void> }) => opts.sendNodeNotify(),
}))
import { sendDesktopNotification } from "../src/backend.js"

describe("unified scheduling", () => {
	beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks() })
	afterEach(() => { vi.useRealTimers() })
	async function setup(isActive: (id: string) => boolean | undefined = () => undefined) {
		const relay = { start: vi.fn(), stop: vi.fn(), handleEvent: vi.fn() }
		const plugin = await createNotifyPlugin(undefined, { relayBridge: relay, presence: { isActive } })({ client: { session: { get: async () => ({ data: {} }) } } } as unknown as PluginInput)
		const emit = async (type: string, properties: object) => plugin.event!({ event: { type, properties } } as never)
		return { plugin, relay, emit }
	}
	const question = { sessionID: "s", requestID: "q", questions: [{ question: "Question?" }] }
	it("delays both channels, preserves pending duplicates and cancels matching resolutions", async () => {
		const { emit, relay, plugin } = await setup()
		await emit("question.asked", question)
		await vi.advanceTimersByTimeAsync(8000)
		await emit("question.asked", question)
		await vi.advanceTimersByTimeAsync(1999)
		expect(relay.handleEvent).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		expect(relay.handleEvent).toHaveBeenCalledTimes(1)
		expect(sendDesktopNotification).toHaveBeenCalledTimes(1)
		await emit("question.replied", { sessionID: "s", requestID: "q" })
		expect(relay.handleEvent).toHaveBeenCalledTimes(2)
		await plugin.dispose?.()
	})
	it("waits while active, sends on departure or at 30 seconds, and unknown sends at 10", async () => {
		let active: boolean | undefined = true
		const { emit, relay, plugin } = await setup(() => active)
		await emit("question.asked", question)
		await vi.advanceTimersByTimeAsync(15000)
		expect(relay.handleEvent).not.toHaveBeenCalled()
		active = false
		await vi.advanceTimersByTimeAsync(1000)
		expect(relay.handleEvent).toHaveBeenCalledTimes(1)
		active = true
		await emit("permission.asked", { sessionID: "s", requestID: "p" })
		await vi.advanceTimersByTimeAsync(30000)
		expect(relay.handleEvent).toHaveBeenCalledTimes(2)
		active = undefined
		await emit("question.asked", { ...question, requestID: "q2" })
		await vi.advanceTimersByTimeAsync(10000)
		expect(relay.handleEvent).toHaveBeenCalledTimes(3)
		await plugin.dispose?.()
	})
	it("cancels idle on busy or user prompt and requests only on matching resolution", async () => {
		const { emit, relay, plugin } = await setup()
		await emit("session.idle", { sessionID: "s" })
		await emit("session.status", { sessionID: "s", status: { type: "busy" } })
		await emit("session.idle", { sessionID: "s" })
		await emit("message.updated", { info: { sessionID: "s", role: "user" } })
		await emit("question.asked", question)
		await emit("question.replied", { sessionID: "s", requestID: "other" })
		await emit("question.replied", { sessionID: "s", requestID: "q" })
		await vi.advanceTimersByTimeAsync(30000)
		expect(sendDesktopNotification).not.toHaveBeenCalled()
		expect(relay.handleEvent).toHaveBeenCalledTimes(2)
		await plugin.dispose?.()
	})
	it("forwards relay cancellations for resolved requests", () => {
		const client = { connect: vi.fn(), shutdown: vi.fn(), sendUpsert: vi.fn(), sendCancel: vi.fn(), sendApplyResult: vi.fn() }
		const bridge = new RelayBridge({ config: { relay: { enabled: true, url: "wss://example.test", clientToken: "x" } }, clientId: "c", sessionId: "s", opencodeClient: {} as never, relayClientFactory: () => client })
		bridge.start()
		bridge.handleEvent({ type: "permission.replied", properties: { sessionID: "s", requestID: "p" } })
		expect(client.sendCancel).toHaveBeenCalledWith({ clientId: "c", sessionId: "s", requestId: "p" })
	})
	it("sends idle at seven seconds and errors immediately", async () => {
		const { emit, plugin } = await setup()
		await emit("session.idle", { sessionID: "s" })
		await vi.advanceTimersByTimeAsync(6999)
		expect(sendDesktopNotification).not.toHaveBeenCalled()
		await emit("session.error", { sessionID: "e", message: "failure" })
		await vi.advanceTimersByTimeAsync(0)
		expect(sendDesktopNotification).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(1)
		expect(sendDesktopNotification).toHaveBeenCalledTimes(2)
		await plugin.dispose?.()
	})
	it("keeps rich request data across sparse repeats and cancels hook aliases", async () => {
		const { emit, relay, plugin } = await setup()
		await plugin["tool.execute.before"]!({ tool: "question", sessionID: "s", callID: "call" } as never, {} as never)
		await emit("question.asked", { ...question, tool: { callID: "call" } })
		await emit("question.asked", { sessionID: "s", requestID: "q" })
		await vi.advanceTimersByTimeAsync(10000)
		expect(relay.handleEvent).toHaveBeenCalledOnce()
		expect(relay.handleEvent).toHaveBeenCalledWith(expect.objectContaining({ properties: expect.objectContaining({ questions: question.questions }) }))
		await emit("question.replied", { sessionID: "s", requestID: "q" })
		await plugin.dispose?.()
	})
	it("cancels only the matching session and request, and cleans up on disposal", async () => {
		const { emit, relay, plugin } = await setup(() => { throw new Error("unavailable") })
		await emit("permission.asked", { sessionID: "s", requestID: "p" })
		await emit("permission.asked", { sessionID: "other", requestID: "p" })
		await emit("permission.replied", { sessionID: "s", requestID: "p" })
		await vi.advanceTimersByTimeAsync(10000)
		expect(relay.handleEvent).toHaveBeenCalledTimes(2)
		expect(sendDesktopNotification).toHaveBeenCalledTimes(1)
		await emit("question.asked", question)
		await plugin.dispose?.()
		await vi.advanceTimersByTimeAsync(30000)
		expect(relay.handleEvent).toHaveBeenCalledTimes(2)
	})
	it("suppresses idle when the session is confirmed active at its deadline", async () => {
		let active = true
		const { emit, relay, plugin } = await setup(() => active)
		await emit("session.idle", { sessionID: "s" })
		await vi.advanceTimersByTimeAsync(7000)
		active = false
		await vi.advanceTimersByTimeAsync(30000)
		expect(sendDesktopNotification).not.toHaveBeenCalled()
		expect(relay.handleEvent).not.toHaveBeenCalled()
		await plugin.dispose?.()
	})
	it("cancels a legacy permission reply and forwards its permissionID", async () => {
		const client = { connect: vi.fn(), shutdown: vi.fn(), sendUpsert: vi.fn(), sendCancel: vi.fn(), sendApplyResult: vi.fn() }
		const bridge = new RelayBridge({ config: { relay: { enabled: true, url: "wss://example.test", clientToken: "x" } }, clientId: "c", sessionId: "s", opencodeClient: {} as never, relayClientFactory: () => client })
		const plugin = await createNotifyPlugin(undefined, { relayBridge: bridge })({ client: {} } as unknown as PluginInput)
		const emit = async (type: string, properties: object) => plugin.event!({ event: { type, properties } } as never)
		await emit("permission.asked", { sessionID: "s", id: "p", permission: "bash" })
		await emit("permission.replied", { sessionID: "s", permissionID: "p" })
		await vi.advanceTimersByTimeAsync(10000)
		expect(client.sendUpsert).not.toHaveBeenCalled()
		expect(client.sendCancel).toHaveBeenCalledWith({ clientId: "c", sessionId: "s", requestId: "p" })
		expect(sendDesktopNotification).not.toHaveBeenCalled()
		await plugin.dispose?.()
	})
	it("cancels an idle desktop delivery if busy arrives while metadata is loading", async () => {
		let finish!: (value: object) => void
		const metadata = new Promise<object>(resolve => { finish = resolve })
		const plugin = await createNotifyPlugin()({ client: { session: { get: () => metadata } } } as unknown as PluginInput)
		const emit = async (type: string, properties: object) => plugin.event!({ event: { type, properties } } as never)
		await emit("session.idle", { sessionID: "s" })
		await vi.advanceTimersByTimeAsync(7000)
		await emit("session.status", { sessionID: "s", status: { type: "busy" } })
		finish({ data: {} })
		await vi.advanceTimersByTimeAsync(0)
		expect(sendDesktopNotification).not.toHaveBeenCalled()
		await plugin.dispose?.()
	})
	it("does not deliver a request to desktop if it resolves during relay delivery", async () => {
		let resolveRequest = () => {}
		const relay = { start: vi.fn(), stop: vi.fn(), handleEvent: vi.fn((event: { type?: string }) => { if (event.type === "question.asked") resolveRequest() }) }
		const plugin = await createNotifyPlugin(undefined, { relayBridge: relay })({ client: {} } as PluginInput)
		resolveRequest = () => { void plugin.event!({ event: { type: "question.replied", properties: { sessionID: "s", requestID: "q" } } } as never) }
		await plugin.event!({ event: { type: "question.asked", properties: question } } as never)
		await vi.advanceTimersByTimeAsync(10000)
		expect(relay.handleEvent).toHaveBeenCalledTimes(2)
		expect(sendDesktopNotification).not.toHaveBeenCalled()
		await plugin.dispose?.()
	})
	it("uses configured delays for both channels and the active deadline", async () => {
		const relay = { start: vi.fn(), stop: vi.fn(), handleEvent: vi.fn() }
		const fs = { readFile: async () => JSON.stringify({ desktop: { delays: { idleMs: 50, requestMs: 100, activeMaxMs: 250 } } }) } as FsAbstraction
		const config = await loadConfig({ fs, os: { homedir: () => "/home/test" } })
		const plugin = await createNotifyPlugin(config.desktop, { relayBridge: relay, presence: { isActive: id => id === "active" } })({ client: { session: { get: async () => ({ data: {} }) } } } as unknown as PluginInput)
		const emit = async (type: string, properties: object) => plugin.event!({ event: { type, properties } } as never)
		await emit("session.idle", { sessionID: "s" })
		await emit("permission.asked", { sessionID: "active", requestID: "p" })
		await vi.advanceTimersByTimeAsync(49)
		expect(relay.handleEvent).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		expect(sendDesktopNotification).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(199)
		expect(relay.handleEvent).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(1)
		expect(relay.handleEvent).toHaveBeenCalledTimes(2)
		await plugin.dispose?.()
	})
})
