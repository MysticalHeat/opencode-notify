import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import type {
	NotifyPluginConfig,
	PluginEventType,
	NotifyEventType,
	EventLike,
	SessionMetadata,
	NotifyDeps,
	TerminalDetectDeps,
} from "./types.js"
import { canUseCmuxNotification, sendCmuxNotification, sendDesktopNotification, sendNotificationWithFallback } from "./backend.js"
import { detectTerminalInfo } from "./focus.js"
import { resolveNotificationDelays } from "./config.js"

const DEDUPE_WINDOW_MS = 1500

const DEFAULT_CONFIG: NotifyPluginConfig = {
	notifyChildSessions: false,
	sounds: { idle: "default", error: "basso", permission: "ping", question: "default" },
	quietHours: { enabled: false, start: "22:00", end: "08:00" },
}

// ─── HELPERS ─────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object"
}

function toText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function getProps(event: EventLike): Record<string, unknown> | undefined {
	return isRecord(event.properties) ? event.properties : undefined
}

function getSessionID(props: Record<string, unknown>): string {
	return toText(props.sessionID) ?? toText(props.sessionId) ?? toText(props.id) ?? "unknown"
}

function getRequestID(props: Record<string, unknown>): string | undefined {
	return toText(props.requestID) ?? toText(props.requestId) ?? toText(props.permissionID) ?? toText(props.permissionId) ?? toText(props.id) ?? undefined
}

function getCallID(props: Record<string, unknown>): string | undefined {
	return isRecord(props.tool) ? toText(props.tool.callID) ?? toText(props.tool.messageID) : undefined
}

function getTextFromQuestionProps(props: Record<string, unknown>): string | undefined {
	return toText(props.question) ?? (Array.isArray(props.questions) ? toText((props.questions[0] as Record<string, unknown> | undefined)?.question) : undefined)
}

function getTextFromPermissionProps(props: Record<string, unknown>): string | undefined {
	return toText(props.permission) ?? toText(props.prompt) ?? toText(props.message) ?? toText((props.tool as Record<string, unknown> | undefined)?.name) ?? toText((props.tool as Record<string, unknown> | undefined)?.description)
}

function getErrorText(props: Record<string, unknown>): string | undefined {
	return toText(props.message) ?? toText((props.error as Record<string, unknown> | undefined)?.message) ?? toText((props.error as Record<string, unknown> | undefined)?.name)
}

function getTitle(props: Record<string, unknown>): string {
	return toText(props.title) ?? toText(props.summary) ?? toText(props.question) ?? `Session ${getSessionID(props).slice(0, 8)}`
}

function mergeConfig(input: NotifyPluginConfig | undefined): NotifyPluginConfig {
	return {
		notifyChildSessions: input?.notifyChildSessions ?? DEFAULT_CONFIG.notifyChildSessions,
		sounds: { ...DEFAULT_CONFIG.sounds, ...input?.sounds },
		quietHours: { ...DEFAULT_CONFIG.quietHours, ...input?.quietHours },
		delays: resolveNotificationDelays(input?.delays),
	}
}

// ─── NORMALIZATION ───────────────────────────────────────

export function normalizeEventType(
	event: EventLike,
): PluginEventType | undefined {
	const eventType = (event as { type?: string }).type as NotifyEventType | undefined
	if (!eventType) return undefined

	if (eventType === "tool.execute.before") {
		const tool = getProps(event)?.tool as Record<string, unknown> | undefined
		if (toText(tool?.name) !== "question") return undefined
		return "question.asked"
	}
	if ((event as { type?: string }).type === "question.v2.asked") return "question.asked"
	if ((event as { type?: string }).type === "permission.v2.asked") return "permission.asked"

	if (
		eventType === "question.asked" ||
		eventType === "permission.asked" ||
		eventType === "permission.updated" ||
		eventType === "session.error" ||
		eventType === "session.idle"
	) {
		return eventType
	}

	if (eventType === "session.status") {
		const status = getProps(event)?.status as { type?: string } | undefined
		if (status?.type !== "idle") return undefined
		return "session.idle"
	}

	return undefined
}

// ─── QUIET HOURS ─────────────────────────────────────────

export function inQuietHours(range: { start: string; end: string }): boolean {
	const now = new Date()
	const mins = now.getHours() * 60 + now.getMinutes()
	const [sh, sm] = range.start.split(":").map(Number)
	const [eh, em] = range.end.split(":").map(Number)
	const start = (sh ?? 0) * 60 + (sm ?? 0)
	const end = (eh ?? 0) * 60 + (em ?? 0)
	return start <= end ? mins >= start && mins < end : mins >= start || mins < end
}

// ─── DEDUPLICATION ───────────────────────────────────────

export function dedupeKey(eventType: PluginEventType, event: EventLike): string | null {
	const props = getProps(event)
	if (!props) return null
	const sessionID = getSessionID(props)
	if (eventType === "question.asked") return `question:${sessionID}:${getCallID(props) ?? getRequestID(props) ?? "unknown"}`
	if (eventType === "permission.asked" || eventType === "permission.updated") return `permission:${getRequestID(props) ?? sessionID}`
	if (eventType === "session.idle") return `idle:${sessionID}`
	if (eventType === "session.error") return `error:${sessionID}`
	return null
}

export function createDedupeTracker() {
	const recent = new Map<string, number>()

	return {
		shouldSend(key: string | null): boolean {
			const now = Date.now()
			if (!key) return true
			for (const [k, at] of recent) {
				if (now - at > DEDUPE_WINDOW_MS) recent.delete(k)
			}
			if ((recent.get(key) ?? 0) + DEDUPE_WINDOW_MS > now) return false
			recent.set(key, now)
			return true
		},
		reset(): void {
			recent.clear()
		},
	}
}

// ─── SESSION METADATA ────────────────────────────────────

export async function getSessionMetadata(
	client: PluginInput["client"] | undefined,
	sessionID: string,
): Promise<SessionMetadata> {
	try {
		const result = await client?.session.get({ path: { id: sessionID } })
		const raw = result as unknown
		const data = (() => {
			if (!isRecord(raw)) return undefined
			const maybeData = (raw as Record<string, unknown>).data
			if ("data" in (raw as Record<string, unknown>)) return isRecord(maybeData) ? maybeData : undefined
			return raw as Record<string, unknown>
		})()
		const parent = isRecord(data?.parent) ? data.parent : undefined
		return {
			title: toText(data?.title),
			parentID: toText(data?.parentID),
			parentTitle: toText(parent?.title) ?? toText((data as Record<string, unknown> | undefined)?.parentTitle),
		}
	} catch {
		return {}
	}
}

// ─── SUMAMRIZE EVENT ─────────────────────────────────────

export function buildContext(
	eventType: PluginEventType,
	props: Record<string, unknown>,
	session: SessionMetadata,
): string | undefined {
	const parentLabel = session.parentTitle
		? `Parent: ${session.parentTitle}`
		: session.parentID
			? `Parent: ${session.parentID}`
			: undefined
	const context = toText(props.context) ?? toText(props.message)
	if (eventType === "session.idle") return [context, parentLabel].filter(Boolean).join(" · ") || parentLabel
	return context ?? parentLabel
}

export function summarizeEvent(
	eventType: PluginEventType,
	event: EventLike,
	config: NotifyPluginConfig,
	session: SessionMetadata,
): {
	title: string
	context?: string
	message: string
	sessionID: string
	sound?: string
} {
	const props = getProps(event) ?? {}
	const sessionID = getSessionID(props)
	const sessionTitle = session.title ?? getTitle(props)
	const context = buildContext(eventType, props, session)
	const sessionContext = context ? `${sessionTitle} · ${context}` : sessionTitle

	switch (eventType) {
		case "question.asked":
			return {
				sessionID,
				title: "Need answer",
				context: sessionContext,
				message: getTextFromQuestionProps(props) ?? "Please answer this question.",
				sound: config.sounds?.question ?? DEFAULT_CONFIG.sounds?.question,
			}
		case "permission.asked":
			return {
				sessionID,
				title: "Approval needed",
				context: sessionContext,
				message: getTextFromPermissionProps(props) ?? "Please approve this request.",
				sound: config.sounds?.permission ?? DEFAULT_CONFIG.sounds?.permission,
			}
		case "permission.updated":
			return {
				sessionID,
				title: "Approval needed",
				context: sessionContext,
				message: "Permission updated.",
				sound: config.sounds?.permission ?? DEFAULT_CONFIG.sounds?.permission,
			}
		case "session.error":
			return {
				sessionID,
				title: "Failed",
				context: sessionContext,
				message: getErrorText(props) ? `Error: ${getErrorText(props)}` : "The session failed.",
				sound: config.sounds?.error ?? DEFAULT_CONFIG.sounds?.error,
			}
		case "session.idle":
			return {
				sessionID,
				title: "Ready for review",
				context: sessionContext,
				message: "Finished and ready for review.",
				sound: config.sounds?.idle ?? DEFAULT_CONFIG.sounds?.idle,
			}
		default:
			return { sessionID, title: "Session update", context: sessionContext, message: "Session update" }
	}
}

// ─── CHILD SESSION CHECK ─────────────────────────────────

export async function shouldSkipChildSession(
	eventType: PluginEventType,
	event: EventLike,
	config: NotifyPluginConfig,
	client: PluginInput["client"] | undefined,
): Promise<{ skip: boolean; session: SessionMetadata }> {
	if (eventType === "question.asked" || eventType === "permission.asked" || eventType === "permission.updated") {
		return { skip: false, session: {} }
	}
	const props = getProps(event)
	if (!props) return { skip: false, session: {} }
	const session = await getSessionMetadata(client, getSessionID(props))
	if (!config.notifyChildSessions && session.parentID) return { skip: true, session }
	return { skip: false, session }
}

// ─── PLUGIN FACTORY ──────────────────────────────────────

function defaultTerminalDeps(terminalOverrides?: TerminalDetectDeps): TerminalDetectDeps {
	if (terminalOverrides) return terminalOverrides
	return {
		platform: typeof process !== "undefined" ? (process.platform ?? "linux") : "linux",
		env: typeof process !== "undefined"
			? (process.env as Record<string, string | undefined>)
			: {},
		runCommand: async () => {
			throw new Error("runCommand not provided; inject via deps.terminal.runCommand")
		},
	}
}

function isDarwin(platform: string): boolean {
	return platform === "darwin"
}

export function createNotifyPlugin(
	configInput?: NotifyPluginConfig,
	deps?: NotifyDeps,
): Plugin {
	const config = mergeConfig(configInput)
	const delays = resolveNotificationDelays(config.delays)
	const env = deps?.env ?? (typeof process !== "undefined" ? (process.env as Record<string, string | undefined>) : {})
	const terminalDeps = defaultTerminalDeps(deps?.terminal)

	return async (input: PluginInput) => {
		const tracker = createDedupeTracker()
		const terminalInfo = await detectTerminalInfo(terminalDeps)
		const relayBridge = deps?.relayBridge

		relayBridge?.start?.()
		const pending = new Map<string, { event: EventLike; timer: ReturnType<typeof setTimeout>; started: number; type: PluginEventType; sessionID: string }>()
		const delivered = new Map<string, object>()
		const aliases = new Map<string, string>()
		let disposed = false
		const clearPending = (key: string) => {
			const item = pending.get(key)
			if (item) clearTimeout(item.timer)
			pending.delete(key)
		}

		async function deliverDesktop(event: EventLike, normalizedType: PluginEventType, valid: () => boolean = () => true): Promise<void> {
			if (config.quietHours?.enabled && inQuietHours({ start: config.quietHours.start ?? "22:00", end: config.quietHours.end ?? "08:00" })) return
			const { skip, session } = await shouldSkipChildSession(normalizedType, event, config, input.client)
			if (skip || disposed || !valid()) return

			const info = summarizeEvent(normalizedType, event, config, session)

			await sendNotificationWithFallback({
				preferCmux: canUseCmuxNotification(env, deps?.resolveExecutable),
				tryCmuxNotify: () =>
					sendCmuxNotification(
						{ title: info.title, subtitle: info.context, body: info.message },
						{ spawnProcess: deps?.spawnProcess },
					),
				sendNodeNotify: () =>
					sendDesktopNotification({
						title: info.title,
						subtitle: info.context,
						body: info.message,
						sound: info.sound,
						activate: isDarwin(terminalDeps.platform) && Boolean(terminalInfo.bundleId),
						bundleId: isDarwin(terminalDeps.platform) ? terminalInfo.bundleId : undefined,
					}),
			})
		}

		function handleEvent(event: EventLike): void {
			if (disposed) return
			const props = getProps(event) ?? {}
			const rawType = (event as { type?: string }).type ?? ""
			const info = isRecord(props.info) ? props.info : undefined
			const sessionID = info ? getSessionID(info) : getSessionID(props)
			if ((rawType === "session.status" && isRecord(props.status) && props.status.type === "busy") ||
				(rawType === "message.updated" && info?.role === "user")) {
				clearPending(`idle:${sessionID}`)
				delivered.delete(`idle:${sessionID}`)
			}
			const resolved = /^(question|permission)(?:\.v2)?\.(replied|rejected)$/.exec(rawType)
			if (resolved) {
				const requestID = getRequestID(props)
				if (requestID) {
					const alias = `${resolved[1]}:${sessionID}:${requestID}`
					const key = aliases.get(alias) ?? alias
					clearPending(key)
					delivered.delete(key)
					for (const [name, target] of aliases) if (target === key) aliases.delete(name)
				}
				relayBridge?.handleEvent(event)
				return
			}
			const type = normalizeEventType(event)
			if (!type) return
			const requestKind = type === "question.asked" ? "question" : type === "permission.asked" || type === "permission.updated" ? "permission" : undefined
			const requestID = getRequestID(props)
			const callID = getCallID(props)
			const names = requestKind ? [...new Set([requestID, callID].filter((id): id is string => !!id))].map(id => `${requestKind}:${sessionID}:${id}`) : []
			const key = requestKind ? names.map(name => aliases.get(name)).find(Boolean) ?? names[0] ?? `${requestKind}:${sessionID}:unknown` : `${type === "session.idle" ? "idle" : "error"}:${sessionID}`
			for (const name of names) aliases.set(name, key)
			if (type === "session.error") {
				if (tracker.shouldSend(key)) void deliverDesktop(event, type)
				return
			}
			const existing = pending.get(key)
			if (existing) {
				// Keep the original deadline while allowing richer repeated request data.
				existing.event = { ...existing.event, ...event, type: rawType === "permission.updated" ? existing.event.type : event.type, properties: { ...getProps(existing.event), ...props } } as EventLike
				return
			}
			if (requestKind && delivered.has(key)) return
			const started = Date.now()
			const run = () => {
				const item = pending.get(key)
				if (!item || disposed) return
				let active = false
				try { active = deps?.presence?.isActive(item.sessionID) === true } catch { /* unknown */ }
				if (!requestKind && active) {
					pending.delete(key)
					return
				}
				if (requestKind && active && Date.now() - item.started < delays.activeMaxMs) {
					item.timer = setTimeout(run, Math.min(1000, delays.activeMaxMs - (Date.now() - item.started)))
					return
				}
				pending.delete(key)
				const delivery = {}
				delivered.set(key, delivery)
				relayBridge?.handleEvent(item.event)
				void deliverDesktop(item.event, item.type, () => delivered.get(key) === delivery).finally(() => {
					if (!requestKind && delivered.get(key) === delivery) delivered.delete(key)
				})
			}
			const timer = setTimeout(run, requestKind ? delays.requestMs : delays.idleMs)
			pending.set(key, { event, timer, started, type, sessionID })
		}

		return {
			dispose: async () => {
				disposed = true
				for (const key of pending.keys()) clearPending(key)
				delivered.clear()
				aliases.clear()
			},
			event: async ({ event }) => {
				await handleEvent(event as EventLike)
			},

			"tool.execute.before": async (hookInput) => {
				if (hookInput.tool !== "question") return
				const event: EventLike = {
					type: "question.asked",
					properties: {
						sessionID: hookInput.sessionID,
						requestID: hookInput.callID,
						tool: { callID: hookInput.callID, name: hookInput.tool },
					},
				} as EventLike
				await handleEvent(event)
			},
		}
	}
}
