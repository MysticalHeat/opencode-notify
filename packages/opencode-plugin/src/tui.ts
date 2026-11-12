import { createConnection, type Socket } from "node:net"
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { discoverPresence, tuiPresenceKey, type PresenceFocus, type PresenceSnapshot } from "./presence.js"

export interface PresenceTuiApi {
	route: { readonly current: { name: string; params?: Record<string, unknown> } }
	renderer: { on(event: string, listener: () => void): unknown; off(event: string, listener: () => void): unknown }
	lifecycle: { onDispose(callback: () => void): unknown; readonly signal: AbortSignal }
	readonly client?: unknown
	state?: { readonly path: { readonly directory: string } }
}
export interface PresenceTuiOptions { socketPath?: string; heartbeatMs?: number; pollMs?: number; reconnectMs?: number }

/** Start a TUI reporter. The socket path must identify the specific server, not just its working directory. */
export function startPresenceTui(api: PresenceTuiApi, options: PresenceTuiOptions = {}): () => void {
	const heartbeatMs = options.heartbeatMs ?? 2_000
	const pollMs = options.pollMs ?? 250
	const reconnectMs = options.reconnectMs ?? 1_000
	if (![heartbeatMs, pollMs, reconnectMs].every(n => Number.isFinite(n) && n > 0)) throw new Error("Invalid presence TUI options")
	let focus: PresenceFocus = "unknown"
	let socket: Socket | undefined
	let reconnect: ReturnType<typeof setTimeout> | undefined
	let stopped = false
	let last = ""
	let lastSent = 0
	let connectedPath: string | undefined
	let lastDiscovery = 0
	const resolvePath = (): string | undefined => {
		if (options.socketPath) return options.socketPath
		try {
			// The SDK's generated client currently keeps getConfig() on a protected field.
			// This is not a public TUI contract; if it changes, discovery safely stops.
			const client = api.client as { client?: { getConfig?: () => { baseUrl?: unknown } } } | undefined
			const key = tuiPresenceKey(client?.client?.getConfig?.().baseUrl, api.state?.path.directory)
			return key ? discoverPresence(key) : undefined
		} catch { return }
	}

	const send = (force = false) => {
		if (!socket || socket.destroyed || socket.connecting || !socket.writable) return
		const route = api.route.current
		const id = route.name === "session" ? route.params?.sessionID : undefined
		const snapshot: PresenceSnapshot = { focus, sessionId: typeof id === "string" && id.length > 0 && id.length <= 512 ? id : null }
		const message = JSON.stringify(snapshot)
		if (force || message !== last || Date.now() - lastSent >= heartbeatMs) {
			// A stuck peer must not allow an unbounded write queue.
			if (socket.writableLength > 4096) { socket.destroy(); return }
			socket.write(`${message}\n`)
			last = message
			lastSent = Date.now()
		}
	}
	const connect = () => {
		if (stopped) return
		const path = resolvePath()
		if (!path) { reconnect = setTimeout(connect, reconnectMs); reconnect.unref?.(); return }
		connectedPath = path
		let current: Socket
		try { current = createConnection(path) }
		catch { connectedPath = undefined; focus = "unknown"; reconnect = setTimeout(connect, reconnectMs); reconnect.unref?.(); return }
		socket = current
		current.on("error", () => {})
		current.on("connect", () => { last = ""; try { send(true) } catch { current.destroy() } })
		current.on("close", () => {
			if (socket !== current) return
			socket = undefined
			connectedPath = undefined
			focus = "unknown"
			if (!stopped) { reconnect = setTimeout(connect, reconnectMs); reconnect.unref?.() }
		})
	}
	const onFocus = () => { focus = "focused"; send() }
	const onBlur = () => { focus = "blurred"; send() }
	api.renderer.on("focus", onFocus)
	api.renderer.on("blur", onBlur)
	const timer = setInterval(() => {
		if (!options.socketPath && socket && Date.now() - lastDiscovery >= reconnectMs) {
			lastDiscovery = Date.now()
			if (resolvePath() !== connectedPath) { socket.destroy(); return }
		}
		try { send() } catch { socket?.destroy() }
	}, Math.min(pollMs, heartbeatMs))
	timer.unref?.()
	const stop = () => {
		if (stopped) return
		stopped = true
		clearInterval(timer)
		if (reconnect) clearTimeout(reconnect)
		api.renderer.off("focus", onFocus)
		api.renderer.off("blur", onBlur)
		api.lifecycle.signal.removeEventListener("abort", stop)
		socket?.destroy()
	}
	api.lifecycle.onDispose(stop)
	api.lifecycle.signal.addEventListener("abort", stop, { once: true })
	if (api.lifecycle.signal.aborted) stop()
	else connect()
	return stop
}

/** Discovers the local broker when the SDK transport and server can be identified unambiguously. */
export const OpenCodeNotifyTui: TuiPlugin = async (api, options) => {
	startPresenceTui(api as unknown as PresenceTuiApi, { socketPath: typeof options?.socketPath === "string" ? options.socketPath : undefined })
}

export default { id: "@nomli/opencode-notify-tui", tui: OpenCodeNotifyTui }
