import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { resolve, dirname } from "node:path"
import type { NotifySoundConfig, QuietHoursConfig } from "./types.js"

export interface RelayConfig {
	url?: string
	clientToken?: string
	enabled?: boolean
	clientMetadata?: {
		sounds?: NotifySoundConfig
		quietHours?: QuietHoursConfig
		notifyChildSessions?: boolean
	}
}

export interface OpenCodeNotifyConfig {
	relay?: RelayConfig
	desktop?: {
		sounds?: NotifySoundConfig
		quietHours?: QuietHoursConfig
		notifyChildSessions?: boolean
	}
	version?: number
}

export interface KdcoNotifyConfig {
	telegram?: {
		botToken?: string
		chatId?: string
	}
	sounds?: NotifySoundConfig
	quietHours?: QuietHoursConfig
	childSessions?: boolean
	notifyChildSessions?: boolean
}

export interface FsAbstraction {
	readFile(path: string): Promise<string>
	writeFile(path: string, data: string, options?: { mode?: number }): Promise<void>
	stat(path: string): Promise<{ mode: number }>
	chmod(path: string, mode: number): Promise<void>
	rename(oldPath: string, newPath: string): Promise<void>
	unlink(path: string): Promise<void>
	access(path: string): Promise<void>
}

export interface OsAbstraction {
	homedir(): string
}

const defaultFs: FsAbstraction = {
	async readFile(path: string) {
		return fs.readFile(path, "utf-8")
	},
	async writeFile(path: string, data: string, options?: { mode?: number }) {
		await fs.writeFile(path, data, { mode: options?.mode ?? 0o600 })
	},
	async stat(path: string) {
		const s = await fs.stat(path)
		return { mode: s.mode }
	},
	async chmod(path: string, mode: number) {
		await fs.chmod(path, mode)
	},
	async rename(oldPath: string, newPath: string) {
		await fs.rename(oldPath, newPath)
	},
	async unlink(path: string) {
		await fs.unlink(path)
	},
	async access(path: string) {
		await fs.access(path)
	},
}

const defaultOs: OsAbstraction = { homedir }

const DEFAULT_SOUNDS: NotifySoundConfig = {
	idle: "default",
	error: "basso",
	permission: "ping",
	question: "default",
}

const DEFAULT_QUIET_HOURS: QuietHoursConfig = {
	enabled: false,
	start: "22:00",
	end: "08:00",
}

export const DEFAULT_CONFIG: OpenCodeNotifyConfig = {
	relay: {
		enabled: false,
		clientMetadata: {
			sounds: { ...DEFAULT_SOUNDS },
			quietHours: { ...DEFAULT_QUIET_HOURS },
			notifyChildSessions: false,
		},
	},
	desktop: {
		sounds: { ...DEFAULT_SOUNDS },
		quietHours: { ...DEFAULT_QUIET_HOURS },
		notifyChildSessions: false,
	},
	version: 1,
}

export class ConfigError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "ConfigError"
	}
}

export class ValidationError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "ValidationError"
	}
}

function isValidUrl(url: string): boolean {
	try {
		const parsed = new URL(url)
		return parsed.protocol === "https:" || parsed.protocol === "wss:"
	} catch {
		return false
	}
}

function isValidTimeFormat(time: string): boolean {
	return /^([01]\d|2[0-3]):[0-5]\d$/.test(time)
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v)
}

function validateConfig(input: unknown, label: string): OpenCodeNotifyConfig {
	if (!isRecord(input)) {
		throw new ConfigError(`${label} must be an object`)
	}

	const cfg = input as Record<string, unknown>
	const errors: string[] = []

	if (cfg.relay !== undefined) {
		if (!isRecord(cfg.relay)) {
			errors.push("relay must be an object")
		} else {
			const r = cfg.relay as Record<string, unknown>
			if (r.url !== undefined && typeof r.url !== "string") {
				errors.push("relay.url must be a string")
			} else if (r.url !== undefined && !isValidUrl(r.url as string)) {
				errors.push("relay.url must be a valid https:// or wss:// URL")
			}
			if (r.clientToken !== undefined && typeof r.clientToken !== "string") {
				errors.push("relay.clientToken must be a string")
			}
			if (r.enabled !== undefined && typeof r.enabled !== "boolean") {
				errors.push("relay.enabled must be a boolean")
			}
			if (r.clientMetadata !== undefined) {
				if (!isRecord(r.clientMetadata)) {
					errors.push("relay.clientMetadata must be an object")
				} else {
					const cm = r.clientMetadata as Record<string, unknown>
					if (cm.notifyChildSessions !== undefined && typeof cm.notifyChildSessions !== "boolean") {
						errors.push("relay.clientMetadata.notifyChildSessions must be a boolean")
					}
					if (cm.quietHours !== undefined && isRecord(cm.quietHours)) {
						const qh = cm.quietHours as Record<string, unknown>
						if (qh.start !== undefined && typeof qh.start === "string" && !isValidTimeFormat(qh.start)) {
							errors.push("relay.clientMetadata.quietHours.start must be HH:MM")
						}
						if (qh.end !== undefined && typeof qh.end === "string" && !isValidTimeFormat(qh.end)) {
							errors.push("relay.clientMetadata.quietHours.end must be HH:MM")
						}
					}
				}
			}
		}
	}

	if (cfg.desktop !== undefined) {
		if (!isRecord(cfg.desktop)) {
			errors.push("desktop must be an object")
		} else {
			const d = cfg.desktop as Record<string, unknown>
			if (d.notifyChildSessions !== undefined && typeof d.notifyChildSessions !== "boolean") {
				errors.push("desktop.notifyChildSessions must be a boolean")
			}
			if (d.quietHours !== undefined && isRecord(d.quietHours)) {
				const qh = d.quietHours as Record<string, unknown>
				if (qh.enabled !== undefined && typeof qh.enabled !== "boolean") {
					errors.push("desktop.quietHours.enabled must be a boolean")
				}
				if (qh.start !== undefined && typeof qh.start === "string" && !isValidTimeFormat(qh.start)) {
					errors.push("desktop.quietHours.start must be HH:MM")
				}
				if (qh.end !== undefined && typeof qh.end === "string" && !isValidTimeFormat(qh.end)) {
					errors.push("desktop.quietHours.end must be HH:MM")
				}
			}
		}
	}

	if (errors.length > 0) {
		throw new ValidationError(errors.join("; "))
	}

	return input as OpenCodeNotifyConfig
}

function deepMerge(
	defaults: Record<string, unknown>,
	partial: Record<string, unknown>,
): Record<string, unknown> {
	const result: Record<string, unknown> = { ...defaults }
	for (const [key, val] of Object.entries(partial)) {
		if (val === undefined || val === null) continue
		if (isRecord(val)) {
			const current = result[key]
			const base = isRecord(current) ? current : ({} as Record<string, unknown>)
			result[key] = deepMerge(base, val as Record<string, unknown>)
		} else {
			result[key] = val
		}
	}
	return result
}

export function configPath(os: OsAbstraction = defaultOs, envPath?: string): string {
	if (envPath) return resolve(envPath)
	return resolve(os.homedir(), ".config", "opencode", "opencode-notify.json")
}

export function oldConfigPath(os: OsAbstraction = defaultOs): string {
	return resolve(os.homedir(), ".config", "opencode", "kdco-notify.json")
}

export async function loadConfig(options: {
	fs?: FsAbstraction
	os?: OsAbstraction
	envPath?: string
} = {}): Promise<OpenCodeNotifyConfig> {
	const f = options.fs ?? defaultFs
	const o = options.os ?? defaultOs
	const path = configPath(o, options.envPath)

	let raw: string
	try {
		raw = await f.readFile(path)
	} catch {
		return deepMerge({} as Record<string, unknown>, DEFAULT_CONFIG as unknown as Record<string, unknown>) as unknown as OpenCodeNotifyConfig
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		throw new ConfigError("Config file contains invalid JSON")
	}

	if (!isRecord(parsed)) {
		throw new ConfigError("Config file must contain a JSON object")
	}

	validateConfig(parsed, "Config")
	return deepMerge(
		deepMerge({} as Record<string, unknown>, DEFAULT_CONFIG as unknown as Record<string, unknown>) as unknown as Record<string, unknown>,
		parsed as Record<string, unknown>,
	) as unknown as OpenCodeNotifyConfig
}

export async function writeConfig(
	config: OpenCodeNotifyConfig,
	options: {
		fs?: FsAbstraction
		os?: OsAbstraction
		envPath?: string
	} = {},
): Promise<void> {
	const f = options.fs ?? defaultFs
	const o = options.os ?? defaultOs
	const target = configPath(o, options.envPath)
	const dir = dirname(target)
	const tmpPath = resolve(dir, `.opencode-notify.${randomUUID()}.tmp`)

	validateConfig(config, "Config")

	const merged = deepMerge(
		deepMerge({} as Record<string, unknown>, DEFAULT_CONFIG as unknown as Record<string, unknown>) as unknown as Record<string, unknown>,
		config as unknown as Record<string, unknown>,
	) as unknown as OpenCodeNotifyConfig

	const json = JSON.stringify(merged, null, 2)

	try {
		await f.writeFile(tmpPath, json, { mode: 0o600 })

		try {
			const stat = await f.stat(tmpPath)
			if ((stat.mode & 0o777) !== 0o600) {
				await f.chmod(tmpPath, 0o600)
			}
		} catch {
			// If we can't stat/chmod, proceed with rename anyway
		}

		await f.rename(tmpPath, target)
	} catch (error) {
		try { await f.unlink(tmpPath) } catch { /* ignore cleanup failures */ }
		throw error
	}
}

export async function migrateFromOldConfig(options: {
	fs?: FsAbstraction
	os?: OsAbstraction
	envPath?: string
} = {}): Promise<OpenCodeNotifyConfig | null> {
	const f = options.fs ?? defaultFs
	const o = options.os ?? defaultOs
	const oldPath = oldConfigPath(o)

	try {
		await f.access(oldPath)
	} catch {
		return null
	}

	let raw: string
	try {
		raw = await f.readFile(oldPath)
	} catch {
		return null
	}

	let oldConfig: KdcoNotifyConfig
	try {
		oldConfig = JSON.parse(raw) as KdcoNotifyConfig
	} catch {
		return null
	}

	if (!oldConfig || typeof oldConfig !== "object") {
		return null
	}

	const newConfig = deepMerge(
		{} as Record<string, unknown>,
		DEFAULT_CONFIG as unknown as Record<string, unknown>,
	) as unknown as OpenCodeNotifyConfig

	if (oldConfig.sounds) {
		newConfig.desktop!.sounds = {
			...newConfig.desktop!.sounds,
			...oldConfig.sounds,
		}
		if (newConfig.relay?.clientMetadata) {
			newConfig.relay.clientMetadata.sounds = {
				...newConfig.relay.clientMetadata.sounds,
				...oldConfig.sounds,
			}
		}
	}

	if (oldConfig.quietHours) {
		newConfig.desktop!.quietHours = {
			...newConfig.desktop!.quietHours,
			...oldConfig.quietHours,
		}
		if (newConfig.relay?.clientMetadata) {
			newConfig.relay.clientMetadata.quietHours = {
				...newConfig.relay.clientMetadata.quietHours,
				...oldConfig.quietHours,
			}
		}
	}

	if (oldConfig.childSessions !== undefined) {
		newConfig.desktop!.notifyChildSessions = oldConfig.childSessions
		if (newConfig.relay?.clientMetadata) {
			newConfig.relay.clientMetadata.notifyChildSessions = oldConfig.childSessions
		}
	}

	if (oldConfig.notifyChildSessions !== undefined) {
		newConfig.desktop!.notifyChildSessions = oldConfig.notifyChildSessions
		if (newConfig.relay?.clientMetadata) {
			newConfig.relay.clientMetadata.notifyChildSessions = oldConfig.notifyChildSessions
		}
	}

	if (oldConfig.telegram) {
		newConfig.relay!.enabled = false
	}

	return newConfig
}

export async function ensureConfigMode(options: {
	fs?: FsAbstraction
	os?: OsAbstraction
	envPath?: string
} = {}): Promise<boolean> {
	const f = options.fs ?? defaultFs
	const o = options.os ?? defaultOs
	const path = configPath(o, options.envPath)

	try {
		const stat = await f.stat(path)
		const perms = stat.mode & 0o777
		if (perms !== 0o600) {
			await f.chmod(path, 0o600)
			return true
		}
		return false
	} catch {
		return false
	}
}

export function applyEnvOverrides(
	config: OpenCodeNotifyConfig,
	env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): OpenCodeNotifyConfig {
	const result = deepMerge(
		{} as Record<string, unknown>,
		config as unknown as Record<string, unknown>,
	) as unknown as OpenCodeNotifyConfig

	const relayUrl = env.OPENCODE_NOTIFY_RELAY_URL
	if (relayUrl !== undefined && relayUrl.trim()) {
		if (!isValidUrl(relayUrl.trim())) {
			throw new ValidationError("OPENCODE_NOTIFY_RELAY_URL must be a valid https:// or wss:// URL")
		}
		if (!result.relay) result.relay = {}
		result.relay.url = relayUrl.trim()
	}

	const clientToken = env.OPENCODE_NOTIFY_CLIENT_TOKEN
	if (clientToken !== undefined && clientToken.trim()) {
		if (!result.relay) result.relay = {}
		result.relay.clientToken = clientToken.trim()
	}

	const enabled = env.OPENCODE_NOTIFY_RELAY_ENABLED
	if (enabled !== undefined && enabled.trim()) {
		if (!result.relay) result.relay = {}
		result.relay.enabled = enabled.trim() === "true" || enabled.trim() === "1"
	}

	return result
}
