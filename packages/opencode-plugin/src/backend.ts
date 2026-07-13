declare const Bun: { which: (cmd: string) => string | null; spawn: (cmd: string[], opts?: Record<string, unknown>) => { exited: Promise<number>; kill?: () => void } } | undefined

import { TimeoutError, withTimeout } from "./timeout.js"
import type {
	CmuxNotificationPayload,
	DesktopNotificationOptions,
	ResolveExecutable,
	EnvironmentVariables,
	SpawnProcess,
	ChildProcessLike,
} from "./types.js"

let nodeNotifier: { notify(options: Record<string, unknown>, callback?: (error: unknown) => void): void } | null = null

async function loadNodeNotifier(): Promise<typeof nodeNotifier> {
	if (nodeNotifier) return nodeNotifier
	try {
		const mod = await import("node-notifier")
		nodeNotifier = mod.default as NonNullable<typeof nodeNotifier>
		return nodeNotifier
	} catch {
		return null
	}
}

// ─── CMUX ────────────────────────────────────────────────

function defaultWhich(command: string): string | null | undefined {
	return typeof Bun !== "undefined" ? Bun.which(command) : undefined
}

function defaultSpawn(command: string[]): ChildProcessLike {
	if (typeof Bun === "undefined") throw new Error("Bun.spawn not available; provide spawnProcess via deps")
	return Bun.spawn(command, { stdout: "ignore", stderr: "ignore" }) as ChildProcessLike
}

export const CMUX_NOTIFY_TIMEOUT_MS = 1500

export function canUseCmuxNotification(
	env: EnvironmentVariables = process.env as EnvironmentVariables,
	resolveExecutable: ResolveExecutable = defaultWhich,
): boolean {
	const workspaceID = env.CMUX_WORKSPACE_ID?.trim()
	if (!workspaceID) return false
	return Boolean(resolveExecutable("cmux"))
}

export function buildCmuxNotifyArgs(payload: CmuxNotificationPayload): string[] {
	const args = ["notify", "--title", payload.title]
	const subtitle = payload.subtitle?.trim()
	if (subtitle) args.push("--subtitle", subtitle)
	args.push("--body", payload.body)
	return args
}

export async function sendCmuxNotification(
	payload: CmuxNotificationPayload,
	options?: {
		timeoutMs?: number
		spawnProcess?: SpawnProcess
	},
): Promise<boolean> {
	const timeoutMs = options?.timeoutMs ?? CMUX_NOTIFY_TIMEOUT_MS
	const spawnProcess = options?.spawnProcess ?? defaultSpawn

	try {
		const proc = spawnProcess(["cmux", ...buildCmuxNotifyArgs(payload)])

		try {
			const exitCode = await withTimeout(proc.exited, timeoutMs, "cmux notify timed out")
			return exitCode === 0
		} catch (error) {
			if (error instanceof TimeoutError) {
				try { proc.kill?.() } catch { /* best effort */ }
			}
			return false
		}
	} catch {
		return false
	}
}

// ─── DESKTOP ─────────────────────────────────────────────

export function sendDesktopNotification(options: DesktopNotificationOptions): Promise<boolean> {
	return new Promise((resolve) => {
		loadNodeNotifier().then((notifier) => {
			if (!notifier) {
				resolve(false)
				return
			}
			notifier.notify(
				{
					title: options.title,
					subtitle: options.subtitle,
					message: options.body,
					wait: false,
					sound: options.sound,
					activate: options.activate,
					appID: options.bundleId,
				},
				(error: unknown) => resolve(!error),
			)
		}).catch(() => resolve(false))
	})
}

// ─── FALLBACK ────────────────────────────────────────────

export interface NotifyBackendOptions {
	preferCmux: boolean
	tryCmuxNotify: () => Promise<boolean>
	sendNodeNotify: () => Promise<boolean> | boolean
}

export async function sendNotificationWithFallback(options: NotifyBackendOptions): Promise<void> {
	if (!options.preferCmux) {
		void options.sendNodeNotify()
		return
	}

	try {
		const sentViaCmux = await options.tryCmuxNotify()
		if (sentViaCmux) return
	} catch {
		// Fall through to node-notifier fallback
	}

	void options.sendNodeNotify()
}
