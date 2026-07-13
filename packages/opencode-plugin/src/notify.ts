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
import { detectTerminalInfo, shouldSuppressForFocus } from "./focus.js"

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
	return toText(props.requestID) ?? toText(props.requestId) ?? toText(props.id) ?? undefined
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
	const env = deps?.env ?? (typeof process !== "undefined" ? (process.env as Record<string, string | undefined>) : {})
	const terminalDeps = defaultTerminalDeps(deps?.terminal)

	return async (input: PluginInput) => {
		const tracker = createDedupeTracker()
		const terminalInfo = await detectTerminalInfo(terminalDeps)

		async function handleEvent(event: EventLike): Promise<void> {
			const normalizedType = normalizeEventType(event)
			if (!normalizedType) return

			if (config.quietHours?.enabled && inQuietHours({ start: config.quietHours.start ?? "22:00", end: config.quietHours.end ?? "08:00" })) return

			if (shouldSuppressForFocus(normalizedType, terminalInfo)) return

			const { skip, session } = await shouldSkipChildSession(normalizedType, event, config, input.client)
			if (skip) return

			const key = dedupeKey(normalizedType, event)
			if (!tracker.shouldSend(key)) return

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

		return {
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
