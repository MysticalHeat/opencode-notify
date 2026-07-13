import { describe, expect, it, vi } from "vitest"
import { createNotifyPlugin } from "../src/index.js"
import type { PluginInput } from "@opencode-ai/plugin"

function buildInput(overrides: Partial<PluginInput> = {}): PluginInput {
	return {
		client: overrides.client,
		tool: overrides.tool ?? "",
		sessionID: overrides.sessionID ?? "",
		callID: overrides.callID ?? "",
	} as PluginInput
}

function idleEvent(sessionID = "s1"): Parameters<PluginInput["event"]>[0] {
	return { event: { type: "session.idle", properties: { sessionID } } } as Parameters<PluginInput["event"]>[0]
}

function questionEvent(sessionID = "s1"): Parameters<PluginInput["event"]>[0] {
	return { event: { type: "question.asked", properties: { sessionID, question: "Hello" } } } as Parameters<PluginInput["event"]>[0]
}

describe("createNotifyPlugin — session metadata single-fetch", () => {
	it("does not call client.session.get for question.asked (short-circuits)", async () => {
		const sessionGet = vi.fn()
		const client = {
			session: { get: sessionGet },
		} as unknown as PluginInput["client"]

		const plugin = createNotifyPlugin()
		const instance = await plugin(buildInput({ client }))
		await instance.event(questionEvent("s1"))

		expect(sessionGet).not.toHaveBeenCalled()
	})

	it("calls client.session.get exactly once for session.idle event", async () => {
		const sessionGet = vi.fn().mockResolvedValue({
			data: { title: "My Session", parentID: undefined },
		})
		const client = {
			session: { get: sessionGet },
		} as unknown as PluginInput["client"]

		const plugin = createNotifyPlugin()
		const instance = await plugin(buildInput({ client }))
		await instance.event(idleEvent("s1"))

		expect(sessionGet).toHaveBeenCalledTimes(1)
	})
})

describe("createNotifyPlugin — events reach handler", () => {
	it("processes a question.asked event without throwing", async () => {
		const sessionGet = vi.fn()
		const client = {
			session: { get: sessionGet },
		} as unknown as PluginInput["client"]

		const plugin = createNotifyPlugin()
		const instance = await plugin(buildInput({ client }))
		await expect(
			instance.event(questionEvent("s1")),
		).resolves.toBeUndefined()
	})

	it("processes a session.idle event without throwing", async () => {
		const sessionGet = vi.fn().mockResolvedValue({
			data: { title: "My Session", parentID: undefined },
		})
		const client = {
			session: { get: sessionGet },
		} as unknown as PluginInput["client"]

		const plugin = createNotifyPlugin()
		const instance = await plugin(buildInput({ client }))
		await expect(
			instance.event(idleEvent("s1")),
		).resolves.toBeUndefined()
	})
})

describe("createNotifyPlugin — tool.execute.before", () => {
	it("processes question tool hook without throwing", async () => {
		const client = {
			session: { get: vi.fn() },
		} as unknown as PluginInput["client"]

		const plugin = createNotifyPlugin()
		const instance = await plugin(buildInput({
			client,
			tool: "question",
			sessionID: "s1",
			callID: "c1",
		} as Partial<PluginInput>))
		await expect(
			instance["tool.execute.before"]?.({
				tool: "question",
				sessionID: "s1",
				callID: "c1",
			} as Parameters<NonNullable<typeof instance["tool.execute.before"]>>[0]),
		).resolves.toBeUndefined()
	})

	it("ignores non-question tool hooks", async () => {
		const client = {
			session: { get: vi.fn() },
		} as unknown as PluginInput["client"]

		const plugin = createNotifyPlugin()
		const instance = await plugin(buildInput({
			client,
			tool: "bash",
			sessionID: "s1",
			callID: "c1",
		} as Partial<PluginInput>))
		await expect(
			instance["tool.execute.before"]?.({
				tool: "bash",
				sessionID: "s1",
				callID: "c1",
			} as Parameters<NonNullable<typeof instance["tool.execute.before"]>>[0]),
		).resolves.toBeUndefined()
	})
})

describe("createNotifyPlugin — focus suppression with deps", () => {
	it("suppresses session.idle when terminal is focused on mac", async () => {
		const sessionGet = vi.fn().mockResolvedValue({
			data: { title: "Session", parentID: undefined },
		})
		const client = {
			session: { get: sessionGet },
		} as unknown as PluginInput["client"]

		const runCommand = vi.fn()
			.mockResolvedValueOnce("com.googlecode.iterm2")
			.mockResolvedValueOnce("iTerm2")

		const plugin = createNotifyPlugin({ notifyChildSessions: true }, {
			terminal: {
				platform: "darwin",
				env: { TERM_PROGRAM: "iTerm.app" },
				runCommand,
			},
		})

		const instance = await plugin(buildInput({ client }))
		await instance.event(idleEvent("s1"))

		expect(sessionGet).not.toHaveBeenCalled()
	})

	it("does NOT suppress question.asked when terminal is focused", async () => {
		const sessionGet = vi.fn()
		const client = {
			session: { get: sessionGet },
		} as unknown as PluginInput["client"]

		const runCommand = vi.fn()
			.mockResolvedValueOnce("com.googlecode.iterm2")
			.mockResolvedValueOnce("iTerm2")

		const plugin = createNotifyPlugin({ notifyChildSessions: true }, {
			terminal: {
				platform: "darwin",
				env: { TERM_PROGRAM: "iTerm.app" },
				runCommand,
			},
		})

		const instance = await plugin(buildInput({ client }))
		await instance.event(questionEvent("s1"))

		expect(sessionGet).not.toHaveBeenCalled()
	})

	it("does NOT suppress session.idle when terminal is NOT focused (linux)", async () => {
		const sessionGet = vi.fn().mockResolvedValue({
			data: { title: "Session", parentID: undefined },
		})
		const client = {
			session: { get: sessionGet },
		} as unknown as PluginInput["client"]

		const plugin = createNotifyPlugin({ notifyChildSessions: true }, {
			terminal: {
				platform: "linux",
				env: { TERM_PROGRAM: "ghostty" },
				runCommand: vi.fn().mockResolvedValue(""),
			},
		})

		const instance = await plugin(buildInput({ client }))
		await instance.event(idleEvent("s1"))

		expect(sessionGet).toHaveBeenCalledTimes(1)
	})
})
