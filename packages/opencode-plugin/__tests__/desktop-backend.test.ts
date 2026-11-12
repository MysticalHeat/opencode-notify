import { afterEach, describe, expect, it, vi } from "vitest"

const { execFile, notify } = vi.hoisted(() => ({ execFile: vi.fn(), notify: vi.fn() }))
vi.mock("node:child_process", () => ({ execFile }))
vi.mock("node-notifier", () => ({ default: { notify } }))

import { sendDesktopNotification } from "../src/backend.js"

afterEach(() => {
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
	execFile.mockReset()
	notify.mockReset()
})

describe("GNOME desktop notifications", () => {
	it("uses a single GTK application source without graphical session environment", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("linux")
		vi.stubEnv("XDG_CURRENT_DESKTOP", undefined)
		execFile.mockImplementation((_file, args, _options, callback) => {
			callback(null, args.includes("org.freedesktop.Notifications.GetServerInformation")
				? "('gnome-shell', 'GNOME', '50.1', '1.2')" : "()")
		})
		notify.mockImplementation((_options, callback) => callback(null))

		expect(await sendDesktopNotification({ title: "Need answer", body: "First" })).toBe(true)
		expect(await sendDesktopNotification({ title: "Task complete", body: "Second" })).toBe(true)

		const gtkCalls = execFile.mock.calls.filter(([, args]) => args.includes("org.gtk.Notifications.AddNotification"))
		expect(gtkCalls).toHaveLength(2)
		expect(gtkCalls.map(([, args]) => args[8])).toEqual(["com.opencode.CLI", "com.opencode.CLI"])
		expect(notify).not.toHaveBeenCalled()
	})

	it.each(["('Plasma', 'KDE', '6.0', '1.2')", null])("falls back when GNOME is unavailable: %s", async (server) => {
		vi.spyOn(process, "platform", "get").mockReturnValue("linux")
		vi.stubEnv("XDG_CURRENT_DESKTOP", undefined)
		execFile.mockImplementation((_file, _args, _options, callback) => callback(server ? null : new Error("No bus"), server ?? ""))
		notify.mockImplementation((_options, callback) => callback(null))

		expect(await sendDesktopNotification({ title: "Test", body: "Body" })).toBe(true)
		expect(notify).toHaveBeenCalledOnce()
	})
})
