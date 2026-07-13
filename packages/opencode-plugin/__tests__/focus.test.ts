import { describe, expect, it, vi } from "vitest"
import {
	shouldSuppressForFocus,
	detectTerminalInfo,
	isTerminalFocused,
	getBundleId,
	getFrontmostApp,
} from "../src/focus.js"
import type {
	TerminalDetectDeps,
	TerminalInfo,
	PluginEventType,
} from "../src/types.js"

const linuxDeps: TerminalDetectDeps = {
	platform: "linux",
	env: { HOME: "/home/user", TERM_PROGRAM: "ghostty", TERMINAL_EMULATOR: undefined },
	runCommand: () => Promise.resolve(""),
}

describe("getBundleId", () => {
	it("returns ghostty bundle for ghostty", () => {
		expect(getBundleId("Ghostty")).toBe("com.mitchellh.ghostty")
	})

	it("returns kitty bundle for kitty", () => {
		expect(getBundleId("kitty")).toBe("net.kovidgoyal.kitty")
	})

	it("returns iterm2 bundle for iterm", () => {
		expect(getBundleId("iTerm2")).toBe("com.googlecode.iterm2")
	})

	it("returns wezterm bundle for wezterm", () => {
		expect(getBundleId("wezterm")).toBe("com.github.wez.wezterm")
	})

	it("returns alacritty bundle for alacritty", () => {
		expect(getBundleId("Alacritty")).toBe("org.alacritty")
	})

	it("returns terminal.app bundle for terminal", () => {
		expect(getBundleId("Apple_Terminal")).toBe("com.apple.Terminal")
	})

	it("returns hyper bundle for hyper", () => {
		expect(getBundleId("hyper")).toBe("co.zeit.hyper")
	})

	it("returns warp bundle for warp", () => {
		expect(getBundleId("warp")).toBe("dev.warp.Warp-Stable")
	})

	it("returns vscode bundle for vscode", () => {
		expect(getBundleId("vscode")).toBe("com.microsoft.VSCode")
	})

	it("returns undefined for unknown terminal", () => {
		expect(getBundleId("unknown-term")).toBeUndefined()
	})

	it("returns undefined for empty string", () => {
		expect(getBundleId("")).toBeUndefined()
	})
})

describe("isTerminalFocused", () => {
	it("returns true when frontmostApp matches a known terminal", () => {
		expect(isTerminalFocused("ghostty", undefined, "Ghostty")).toBe(true)
	})

	it("returns true when bundleId matches a known terminal", () => {
		expect(isTerminalFocused(undefined, "com.mitchellh.ghostty", "Safari")).toBe(true)
	})

	it("returns true when terminal matches", () => {
		expect(isTerminalFocused("kitty", undefined, "Finder")).toBe(true)
	})

	it("returns false when nothing matches", () => {
		expect(isTerminalFocused(undefined, "com.apple.Safari", "Safari")).toBe(false)
	})

	it("returns false when all inputs are undefined", () => {
		expect(isTerminalFocused(undefined, undefined, undefined)).toBe(false)
	})

	it("matches case-insensitively", () => {
		expect(isTerminalFocused("GHOSTTY", "com.apple.safari", "safari")).toBe(true)
	})
})

describe("getFrontmostApp", () => {
	it("returns lowercase trimmed value", () => {
		expect(getFrontmostApp("  Safari  ")).toBe("safari")
	})

	it("returns undefined for empty string", () => {
		expect(getFrontmostApp("  ")).toBeUndefined()
	})

	it("returns undefined for undefined input", () => {
		expect(getFrontmostApp(undefined)).toBeUndefined()
	})
})

describe("detectTerminalInfo", () => {
	it("returns focused=false on linux", async () => {
		const result = await detectTerminalInfo(linuxDeps)
		expect(result.focused).toBe(false)
		expect(result.terminal).toBe("ghostty")
		expect(result.bundleId).toBeUndefined()
	})

	it("returns focused=false on unknown platform", async () => {
		const result = await detectTerminalInfo({
			platform: "win32" as NodeJS.Platform,
			env: {},
			runCommand: () => Promise.resolve(""),
		})
		expect(result.focused).toBe(false)
	})

	it("returns terminal from TERM_PROGRAM when env.terminal is not set", async () => {
		const result = await detectTerminalInfo({
			...linuxDeps,
			env: { TERM_PROGRAM: "kitty" },
		})
		expect(result.terminal).toBe("kitty")
	})

	it("returns terminal from TERMINAL_EMULATOR fallback", async () => {
		const result = await detectTerminalInfo({
			...linuxDeps,
			env: { TERMINAL_EMULATOR: "ghostty" },
		})
		expect(result.terminal).toBe("ghostty")
	})

	it("on mac, queries osascript for bundleId and frontmostApp", async () => {
		const runCommand = vi.fn()
			.mockResolvedValueOnce("com.apple.Terminal")
			.mockResolvedValueOnce("Terminal")
		const deps: TerminalDetectDeps = {
			platform: "darwin",
			env: { TERM_PROGRAM: "kitty" },
			runCommand,
		}
		const result = await detectTerminalInfo(deps)
		expect(result.bundleId).toBe("com.apple.Terminal")
		expect(result.frontmostApp).toBe("terminal")
		expect(result.focused).toBe(true)
		expect(runCommand).toHaveBeenCalledTimes(2)
	})

	it("handles osascript failures gracefully on mac", async () => {
		const runCommand = vi.fn().mockRejectedValue(new Error("osascript failed"))
		const deps: TerminalDetectDeps = {
			platform: "darwin",
			env: { TERM_PROGRAM: "kitty" },
			runCommand,
		}
		const result = await detectTerminalInfo(deps)
		expect(result.bundleId).toBe("net.kovidgoyal.kitty")
		expect(result.frontmostApp).toBeUndefined()
		expect(result.focused).toBe(true)
	})

	it("computes bundleId from terminal name when osascript fails", async () => {
		const runCommand = vi.fn().mockRejectedValue(new Error("osascript failed"))
		const deps: TerminalDetectDeps = {
			platform: "darwin",
			env: { TERM_PROGRAM: "iTerm.app" },
			runCommand,
		}
		const result = await detectTerminalInfo(deps)
		expect(result.bundleId).toBe("com.googlecode.iterm2")
	})
})

describe("shouldSuppressForFocus", () => {
	const suppressedTypes: PluginEventType[] = [
		"session.idle",
		"session.error",
		"permission.asked",
		"permission.updated",
	]
	const nonSuppressedTypes: PluginEventType[] = ["question.asked"]

	for (const eventType of suppressedTypes) {
		it(`suppresses ${eventType} when terminal is focused`, () => {
			const info: TerminalInfo = {
				terminal: "ghostty",
				bundleId: "com.mitchellh.ghostty",
				focused: true,
			}
			expect(shouldSuppressForFocus(eventType, info)).toBe(true)
		})

		it(`does not suppress ${eventType} when terminal is not focused`, () => {
			const info: TerminalInfo = {
				terminal: "ghostty",
				bundleId: "com.mitchellh.ghostty",
				focused: false,
			}
			expect(shouldSuppressForFocus(eventType, info)).toBe(false)
		})

		it(`does not suppress ${eventType} when terminal is unknown`, () => {
			const info: TerminalInfo = { terminal: undefined, focused: true }
			expect(shouldSuppressForFocus(eventType, info)).toBe(false)
		})
	}

	for (const eventType of nonSuppressedTypes) {
		it(`never suppresses ${eventType} even when terminal is focused`, () => {
			const info: TerminalInfo = {
				terminal: "ghostty",
				bundleId: "com.mitchellh.ghostty",
				focused: true,
			}
			expect(shouldSuppressForFocus(eventType, info)).toBe(false)
		})
	}

	it("does not suppress when terminalInfo is empty", () => {
		expect(shouldSuppressForFocus("session.idle", {} as TerminalInfo)).toBe(false)
	})
})
