import type { RequestUpsertMessage, RequestCancelMessage } from "@repo/protocol"

const EXPIRE_WINDOW_MS = 5 * 60 * 1000

function buildExpiresAt(): string {
	return new Date(Date.now() + EXPIRE_WINDOW_MS).toISOString()
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v)
}

function toText(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() ? v.trim() : undefined
}

function getProps(event: { properties?: unknown }): Record<string, unknown> | undefined {
	return isRecord(event.properties) ? event.properties : undefined
}

function getSessionID(props: Record<string, unknown>): string {
	return toText(props.sessionID) ?? toText(props.sessionId) ?? "unknown"
}

function getRequestID(props: Record<string, unknown>): string | undefined {
	return toText(props.requestID) ?? toText(props.requestId) ?? toText(props.id) ?? undefined
}

export interface UpsertEvent {
	readonly requestId: string
	readonly clientId: string
	readonly sessionId: string
	readonly expiresAt: string
	readonly question?: {
		text: string
		options: Array<{ label: string; value: string }>
		multiSelect?: boolean
	}
	readonly permission?: {
		action: string
		patterns: string[]
		display: string
	}
}

export interface CancelEvent {
	readonly requestId: string
	readonly clientId: string
	readonly sessionId: string
}

function extractQuestion(props: Record<string, unknown>): UpsertEvent["question"] | undefined {
	const questions = props.questions as Array<Record<string, unknown>> | undefined
	if (!questions || questions.length === 0) return undefined

	const q = questions[0]!
	const text = toText(q.question) ?? toText(q.prompt) ?? "Question"
	const options = (q.options ?? q.choices ?? []) as Array<Record<string, unknown>>
	const mapped = options.map((o: Record<string, unknown>) => ({
		label: toText(o.label) ?? toText(o.value) ?? "",
		value: toText(o.value) ?? toText(o.label) ?? "",
	}))

	return {
		text,
		options: mapped.length > 0 ? mapped : [{ label: "OK", value: "ok" }],
		multiSelect: typeof q.multiSelect === "boolean" ? q.multiSelect : false,
	}
}

function extractPermissionV2(props: Record<string, unknown>): UpsertEvent["permission"] | undefined {
	const action = toText(props.action) ?? "unknown"
	const resources = (Array.isArray(props.resources) ? props.resources : []) as string[]
	const save = (Array.isArray(props.save) ? props.save : []) as string[]
	const allPatterns = [...resources, ...save]
	return {
		action,
		patterns: allPatterns.length > 0 ? allPatterns : ["*"],
		display: toText(props.action) ?? action,
	}
}

function extractPermissionLegacy(props: Record<string, unknown>): UpsertEvent["permission"] | undefined {
	const action = toText(props.permission) ?? "unknown"
	const patterns = (Array.isArray(props.patterns) ? props.patterns : []) as string[]
	return {
		action,
		patterns: patterns.length > 0 ? patterns : ["*"],
		display: toText(props.permission) ?? action,
	}
}

export function eventToUpsert(
	event: { type?: string; properties?: unknown },
	clientId: string,
): UpsertEvent | null {
	const props = getProps(event)
	if (!props) return null

	const sessionID = getSessionID(props)
	const requestID = getRequestID(props) ?? (props.id as string | undefined)
	if (!requestID) return null

	const base: Omit<UpsertEvent, "question" | "permission"> = {
		requestId: String(requestID),
		clientId,
		sessionId: sessionID,
		expiresAt: buildExpiresAt(),
	}

	const eventType = event.type

	switch (eventType) {
		case "question.v2.asked":
		case "question.asked": {
			const question = extractQuestion(props)
			if (!question) return null
			return { ...base, question }
		}
		case "permission.v2.asked": {
			const permission = extractPermissionV2(props)
			if (!permission) return null
			return { ...base, permission }
		}
		case "permission.asked": {
			const permission = extractPermissionLegacy(props)
			if (!permission) return null
			return { ...base, permission }
		}
		default:
			return null
	}
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
	const result: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) result[k] = v
	}
	return result as T
}

export function buildUpsertMessage(
	event: UpsertEvent,
	messageId: string,
	clientId = event.clientId,
): RequestUpsertMessage {
	return {
		protocolVersion: 1,
		messageId,
		type: "request_upsert",
		sentAt: new Date().toISOString(),
		payload: stripUndefined({
			clientId,
			sessionId: event.sessionId,
			requestId: event.requestId,
			expiresAt: event.expiresAt,
			question: event.question,
			permission: event.permission,
		}),
	}
}

export function buildCancelMessage(
	event: CancelEvent,
	messageId: string,
	clientId = event.clientId,
): RequestCancelMessage {
	return {
		protocolVersion: 1,
		messageId,
		type: "request_cancel",
		sentAt: new Date().toISOString(),
		payload: {
			clientId,
			sessionId: event.sessionId,
			requestId: event.requestId,
		},
	}
}

export function shouldRelayEvent(type: string | undefined): boolean {
	switch (type) {
		case "question.asked":
		case "question.v2.asked":
		case "permission.asked":
		case "permission.v2.asked":
			return true
		default:
			return false
	}
}
