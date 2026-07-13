import {
	createOpencodeClient as createV2Client,
} from "@opencode-ai/sdk/v2"
import type { OpencodeClient as OpencodeClientType } from "@opencode-ai/sdk/v2"

export type OpencodeClient = OpencodeClientType

export function createOpencodeClient(serverUrl: URL): OpencodeClient {
	return createV2Client({ baseUrl: serverUrl.toString() }) as unknown as OpencodeClient
}

export type ApplyResult = "applied" | "expired" | "failed"

export interface ApplyQuestionParams {
	sessionID: string
	requestID: string
	answers: Array<{ value: string; label: string }>
	client: OpencodeClient
	directory?: string
	workspace?: string
}

export interface RejectQuestionParams {
	sessionID: string
	requestID: string
	client: OpencodeClient
}

export interface ApplyPermissionParams {
	sessionID: string
	requestID: string
	reply: "once" | "always" | "reject"
	message?: string
	client: OpencodeClient
}

async function isNotFoundError(err: unknown): Promise<boolean> {
	if (!err || typeof err !== "object") return false
	const e = err as Record<string, unknown>
	if (e.status === 404 || e.statusCode === 404) return true
	if (e.code === 404) return true
	const msg = String(e.message ?? e.body ?? "")
	return msg.includes("404") || msg.includes("not found") || msg.includes("Not Found")
}

export async function applyQuestion(params: ApplyQuestionParams): Promise<ApplyResult> {
	const { sessionID, requestID, answers, client, directory, workspace } = params

	try {
		const clientV2 = client as unknown as {
			v2?: {
				session?: {
					question?: {
						reply(args: Record<string, unknown>): Promise<{ data?: unknown; error?: unknown }>
						reject(args: Record<string, unknown>): Promise<{ data?: unknown; error?: unknown }>
					}
				}
			}
		}

		if (clientV2.v2?.session?.question?.reply) {
			const result = await clientV2.v2.session.question.reply({
				sessionID,
				requestID,
				questionV2Reply: { answers: answers.map((a) => ({ answer: a.value })) },
			})
			const resp = result as { data?: unknown; error?: unknown }
			if (resp.error) {
				if (await isNotFoundError(resp.error)) return "expired"
				return "failed"
			}
			return "applied"
		}

		const legacyClient = client as unknown as {
			question?: {
				reply(args: Record<string, unknown>): Promise<{ data?: unknown; error?: unknown }>
				reject(args: Record<string, unknown>): Promise<{ data?: unknown; error?: unknown }>
			}
		}

		if (legacyClient.question?.reply) {
			const result = await legacyClient.question.reply({
				requestID,
				directory,
				workspace,
				answers,
			})
			const resp = result as { data?: unknown; error?: unknown }
			if (resp.error) {
				if (await isNotFoundError(resp.error)) return "expired"
				return "failed"
			}
			return "applied"
		}
	} catch (err) {
		if (await isNotFoundError(err)) return "expired"
		return "failed"
	}

	return "failed"
}

export async function rejectQuestion(params: RejectQuestionParams): Promise<ApplyResult> {
	const { sessionID, requestID, client } = params

	try {
		const clientV2 = client as unknown as {
			v2?: {
				session?: {
					question?: {
						reject(args: Record<string, unknown>): Promise<{ data?: unknown; error?: unknown }>
					}
				}
			}
		}

		if (clientV2.v2?.session?.question?.reject) {
			const result = await clientV2.v2.session.question.reject({ sessionID, requestID })
			const resp = result as { data?: unknown; error?: unknown }
			if (resp.error) {
				if (await isNotFoundError(resp.error)) return "expired"
				return "failed"
			}
			return "applied"
		}

		const legacyClient = client as unknown as {
			question?: {
				reject(args: Record<string, unknown>): Promise<{ data?: unknown; error?: unknown }>
			}
		}

		if (legacyClient.question?.reject) {
			const result = await legacyClient.question.reject({ requestID })
			const resp = result as { data?: unknown; error?: unknown }
			if (resp.error) {
				if (await isNotFoundError(resp.error)) return "expired"
				return "failed"
			}
			return "applied"
		}
	} catch (err) {
		if (await isNotFoundError(err)) return "expired"
		return "failed"
	}

	return "failed"
}

export async function applyPermission(params: ApplyPermissionParams): Promise<ApplyResult> {
	const { sessionID, requestID, reply, message, client } = params

	try {
		const clientV2 = client as unknown as {
			v2?: {
				session?: {
					permission?: {
						reply(args: Record<string, unknown>): Promise<{ data?: unknown; error?: unknown }>
					}
				}
			}
		}

		if (clientV2.v2?.session?.permission?.reply) {
			const result = await clientV2.v2.session.permission.reply({
				sessionID,
				requestID,
				reply,
				message,
			})
			const resp = result as { data?: unknown; error?: unknown }
			if (resp.error) {
				if (await isNotFoundError(resp.error)) return "expired"
				return "failed"
			}
			return "applied"
		}

		const legacyClient = client as unknown as {
			permission?: {
				reply(args: Record<string, unknown>): Promise<{ data?: unknown; error?: unknown }>
				respond(args: Record<string, unknown>): Promise<{ data?: unknown; error?: unknown }>
			}
		}

		if (legacyClient.permission?.reply) {
			const result = await legacyClient.permission.reply({
				requestID,
				reply,
				message,
			})
			const resp = result as { data?: unknown; error?: unknown }
			if (resp.error) {
				if (await isNotFoundError(resp.error)) return "expired"
				return "failed"
			}
			return "applied"
		}

		if (legacyClient.permission?.respond) {
			const result = await legacyClient.permission.respond({
				sessionID,
				permissionID: requestID,
				response: reply,
			})
			const resp = result as { data?: unknown; error?: unknown }
			if (resp.error) {
				if (await isNotFoundError(resp.error)) return "expired"
				return "failed"
			}
			return "applied"
		}
	} catch (err) {
		if (await isNotFoundError(err)) return "expired"
		return "failed"
	}

	return "failed"
}
