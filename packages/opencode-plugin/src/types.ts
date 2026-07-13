import type { PluginInput } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"

export type NotifyEventType =
	| "tool.execute.before"
	| "question.asked"
	| "permission.asked"
	| "permission.updated"
	| "session.error"
	| "session.idle"
	| "session.status"

export type PluginEventType = Exclude<NotifyEventType, "tool.execute.before" | "session.status">

export interface NotifySoundConfig {
	idle?: string
	error?: string
	permission?: string
	question?: string
}

export interface QuietHoursConfig {
	enabled?: boolean
	start?: string
	end?: string
}

export interface NotifyPluginConfig {
	notifyChildSessions?: boolean
	sounds?: NotifySoundConfig
	quietHours?: QuietHoursConfig
}

export interface CmuxNotificationPayload {
	title: string
	body: string
	subtitle?: string
}

export interface DesktopNotificationOptions {
	title: string
	subtitle?: string
	body: string
	sound?: string
	activate?: boolean
	bundleId?: string
}

export type ResolveExecutable = (command: string) => string | null | undefined
export type EnvironmentVariables = Record<string, string | undefined>

export interface ChildProcessLike {
	exited: Promise<number>
	kill?(): void
}

export type SpawnProcess = (command: string[], options?: Record<string, unknown>) => ChildProcessLike

export interface NotifyDeps {
	resolveExecutable?: ResolveExecutable
	spawnProcess?: SpawnProcess
	env?: EnvironmentVariables
}

export type EventLike = Event & { type?: string; properties?: unknown }
export type SessionMetadata = { title?: string; parentID?: string; parentTitle?: string }

export type OpencodeClient = PluginInput["client"]
