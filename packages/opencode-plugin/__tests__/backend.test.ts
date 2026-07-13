import { describe, expect, it, vi } from "vitest"
import {
	sendNotificationWithFallback,
	sendCmuxNotification,
	canUseCmuxNotification,
	buildCmuxNotifyArgs,
	CMUX_NOTIFY_TIMEOUT_MS,
} from "../src/backend.js"

describe("buildCmuxNotifyArgs", () => {
	it("builds args with title and body", () => {
		const args = buildCmuxNotifyArgs({
			title: "Test",
			body: "Hello world",
		})
		expect(args).toEqual(["notify", "--title", "Test", "--body", "Hello world"])
	})

	it("includes subtitle when provided", () => {
		const args = buildCmuxNotifyArgs({
			title: "Test",
			subtitle: "Subtitle text",
			body: "Hello world",
		})
		expect(args).toEqual([
			"notify",
			"--title",
			"Test",
			"--subtitle",
			"Subtitle text",
			"--body",
			"Hello world",
		])
	})

	it("omits subtitle when empty string", () => {
		const args = buildCmuxNotifyArgs({
			title: "Test",
			subtitle: "  ",
			body: "Hello world",
		})
		expect(args).toEqual(["notify", "--title", "Test", "--body", "Hello world"])
	})
})

describe("canUseCmuxNotification", () => {
	it("returns false when CMUX_WORKSPACE_ID is missing", () => {
		const result = canUseCmuxNotification({}, () => "/usr/bin/cmux")
		expect(result).toBe(false)
	})

	it("returns false when CMUX_WORKSPACE_ID is empty", () => {
		const result = canUseCmuxNotification(
			{ CMUX_WORKSPACE_ID: "  " },
			() => "/usr/bin/cmux",
		)
		expect(result).toBe(false)
	})

	it("returns false when cmux is not in PATH", () => {
		const result = canUseCmuxNotification(
			{ CMUX_WORKSPACE_ID: "ws1" },
			() => undefined,
		)
		expect(result).toBe(false)
	})

	it("returns true when env and executable are present", () => {
		const result = canUseCmuxNotification(
			{ CMUX_WORKSPACE_ID: "ws1" },
			() => "/usr/bin/cmux",
		)
		expect(result).toBe(true)
	})
})

describe("sendCmuxNotification", () => {
	it("returns true on successful exit (0)", async () => {
		const spawnProcess = vi.fn().mockReturnValue({
			exited: Promise.resolve(0),
		})
		const result = await sendCmuxNotification(
			{ title: "Test", body: "Body" },
			{ spawnProcess },
		)
		expect(result).toBe(true)
		expect(spawnProcess).toHaveBeenCalledWith([
			"cmux",
			"notify",
			"--title",
			"Test",
			"--body",
			"Body",
		])
	})

	it("returns false on non-zero exit", async () => {
		const spawnProcess = vi.fn().mockReturnValue({
			exited: Promise.resolve(1),
		})
		const result = await sendCmuxNotification(
			{ title: "Test", body: "Body" },
			{ spawnProcess },
		)
		expect(result).toBe(false)
	})

	it("returns false on spawn error", async () => {
		const spawnProcess = vi.fn().mockImplementation(() => {
			throw new Error("spawn failed")
		})
		const result = await sendCmuxNotification(
			{ title: "Test", body: "Body" },
			{ spawnProcess },
		)
		expect(result).toBe(false)
	})

	it("returns false on timeout", async () => {
		const spawnProcess = vi.fn().mockReturnValue({
			exited: new Promise(() => {}),
			kill: vi.fn(),
		})
		const result = await sendCmuxNotification(
			{ title: "Test", body: "Body" },
			{ spawnProcess, timeoutMs: 10 },
		)
		expect(result).toBe(false)
	})

	it("has default timeout of 1500ms", () => {
		expect(CMUX_NOTIFY_TIMEOUT_MS).toBe(1500)
	})
})

describe("sendNotificationWithFallback", () => {
	it("uses desktop directly when not preferring cmux", async () => {
		const sendNodeNotify = vi.fn().mockResolvedValue(true)
		const tryCmuxNotify = vi.fn()

		await sendNotificationWithFallback({
			preferCmux: false,
			tryCmuxNotify,
			sendNodeNotify,
		})

		expect(sendNodeNotify).toHaveBeenCalled()
		expect(tryCmuxNotify).not.toHaveBeenCalled()
	})

	it("falls back to desktop when cmux fails", async () => {
		const sendNodeNotify = vi.fn().mockResolvedValue(true)
		const tryCmuxNotify = vi.fn().mockResolvedValue(false)

		await sendNotificationWithFallback({
			preferCmux: true,
			tryCmuxNotify,
			sendNodeNotify,
		})

		expect(tryCmuxNotify).toHaveBeenCalled()
		expect(sendNodeNotify).toHaveBeenCalled()
	})

	it("does not fall back when cmux succeeds", async () => {
		const sendNodeNotify = vi.fn()
		const tryCmuxNotify = vi.fn().mockResolvedValue(true)

		await sendNotificationWithFallback({
			preferCmux: true,
			tryCmuxNotify,
			sendNodeNotify,
		})

		expect(tryCmuxNotify).toHaveBeenCalled()
		expect(sendNodeNotify).not.toHaveBeenCalled()
	})

	it("falls back to desktop when cmux throws", async () => {
		const sendNodeNotify = vi.fn().mockResolvedValue(true)
		const tryCmuxNotify = vi.fn().mockRejectedValue(new Error("cmux crash"))

		await sendNotificationWithFallback({
			preferCmux: true,
			tryCmuxNotify,
			sendNodeNotify,
		})

		expect(sendNodeNotify).toHaveBeenCalled()
	})
})
