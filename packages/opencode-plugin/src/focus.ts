import type { TerminalDetectDeps, TerminalInfo, PluginEventType } from "./types.js"

function toText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function getFrontmostApp(frontmostApp?: string): string | undefined {
	return toText(frontmostApp)?.toLowerCase()
}

export function getBundleId(terminal: string | undefined): string | undefined {
	const value = (terminal ?? "").toLowerCase()
	const map: Record<string, string> = {
		ghostty: "com.mitchellh.ghostty",
		kitty: "net.kovidgoyal.kitty",
		iterm: "com.googlecode.iterm2",
		iterm2: "com.googlecode.iterm2",
		wezterm: "com.github.wez.wezterm",
		alacritty: "org.alacritty",
		terminal: "com.apple.Terminal",
		apple_terminal: "com.apple.Terminal",
		hyper: "co.zeit.hyper",
		warp: "dev.warp.Warp-Stable",
		vscode: "com.microsoft.VSCode",
		"vscode-insiders": "com.microsoft.VSCodeInsiders",
	}
	for (const [name, bundle] of Object.entries(map)) {
		if (value.includes(name)) return bundle
	}
	return undefined
}

export function isTerminalFocused(
	terminal: string | undefined,
	bundleId?: string,
	frontmostApp?: string,
): boolean {
	const app = (frontmostApp ?? "").toLowerCase()
	const term = (terminal ?? "").toLowerCase()
	const bundle = (bundleId ?? "").toLowerCase()
	const known = [
		"ghostty", "kitty", "iterm", "iterm2", "wezterm", "alacritty",
		"terminal", "apple_terminal", "hyper", "warp", "vscode", "vscode-insiders",
	]
	return known.some((name) => app.includes(name) || term.includes(name) || bundle.includes(name))
}

export async function detectTerminalInfo(deps: TerminalDetectDeps): Promise<TerminalInfo> {
	const terminal = deps.env.TERM_PROGRAM ?? deps.env.TERMINAL_EMULATOR

	if (deps.platform !== "darwin") {
		return { terminal: toText(terminal), focused: false }
	}

	let bundleId: string | undefined
	let frontmostApp: string | undefined

	try {
		bundleId = toText(await deps.runCommand([
			"osascript", "-e",
			'tell application "System Events" to get bundle identifier of first application process whose frontmost is true',
		]))
	} catch { /* fall through */ }

	try {
		frontmostApp = toText(await deps.runCommand([
			"osascript", "-e",
			'tell application "System Events" to get name of first application process whose frontmost is true',
		]))
	} catch { /* fall through */ }

	const trimmedTerminal = toText(terminal)
	const resolvedBundleId = bundleId ?? getBundleId(trimmedTerminal)
	const resolvedFrontmost = getFrontmostApp(frontmostApp)
	const focused = isTerminalFocused(trimmedTerminal, resolvedBundleId, resolvedFrontmost)

	return {
		terminal: trimmedTerminal,
		bundleId: resolvedBundleId,
		frontmostApp: resolvedFrontmost,
		focused,
	}
}

export function shouldSuppressForFocus(
	eventType: PluginEventType,
	info: TerminalInfo,
): boolean {
	if (!info.terminal || !info.focused) return false
	return (
		eventType === "session.idle" ||
		eventType === "session.error" ||
		eventType === "permission.asked" ||
		eventType === "permission.updated"
	)
}
