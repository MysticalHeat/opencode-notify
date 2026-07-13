import { describe, it, expect, vi } from "vitest"
import { applyQuestion, rejectQuestion, applyPermission } from "../src/opencode-client.js"
import type { OpencodeClient } from "../src/opencode-client.js"

function makeFakeClient(options?: { hasV2?: boolean; hasLegacy?: boolean }): OpencodeClient {
	const v2Reply = vi.fn().mockResolvedValue({ data: {} })
	const v2Reject = vi.fn().mockResolvedValue({ data: {} })
	const v2PermReply = vi.fn().mockResolvedValue({ data: {} })

	const legacyQReply = vi.fn().mockResolvedValue({ data: {} })
	const legacyQReject = vi.fn().mockResolvedValue({ data: {} })
	const legacyPermReply = vi.fn().mockResolvedValue({ data: {} })
	const legacyPermRespond = vi.fn().mockResolvedValue({ data: {} })

	const client = {} as Record<string, unknown>

	if (options?.hasV2 !== false) {
		(client as Record<string, unknown>).v2 = {
			session: {
				question: {
					reply: v2Reply,
					reject: v2Reject,
				},
				permission: {
					reply: v2PermReply,
				},
			},
		}
	}

	if (options?.hasLegacy !== false) {
		Object.assign(client, {
			question: {
				reply: legacyQReply,
				reject: legacyQReject,
			},
			permission: {
				reply: legacyPermReply,
				respond: legacyPermRespond,
			},
		})
	}

	return client as unknown as OpencodeClient
}

function makeFakeNotFoundClient(): OpencodeClient {
	const v2Reply = vi.fn().mockResolvedValue({ error: { status: 404 } })
	const v2Reject = vi.fn().mockResolvedValue({ error: { status: 404 } })
	const v2PermReply = vi.fn().mockResolvedValue({ error: { status: 404 } })

	return {
		v2: {
			session: {
				question: { reply: v2Reply, reject: v2Reject },
				permission: { reply: v2PermReply },
			},
		},
	} as unknown as OpencodeClient
}

describe("applyQuestion", () => {
	it("returns applied for successful v2 question reply", async () => {
		const client = makeFakeClient()
		const result = await applyQuestion({
			sessionID: "s1",
			requestID: "req-1",
			answers: [{ value: "opt-a", label: "Option A" }],
			client,
		})
		expect(result).toBe("applied")
	})

	it("returns expired when v2 returns 404", async () => {
		const client = makeFakeNotFoundClient()
		const result = await applyQuestion({
			sessionID: "s1",
			requestID: "req-1",
			answers: [{ value: "opt-a", label: "Option A" }],
			client,
		})
		expect(result).toBe("expired")
	})

	it("returns failed when v2 throws non-404", async () => {
		const client = {
			v2: {
				session: {
					question: {
						reply: vi.fn().mockRejectedValue(new Error("Internal error")),
						reject: vi.fn(),
					},
				},
			},
		} as unknown as OpencodeClient
		const result = await applyQuestion({
			sessionID: "s1",
			requestID: "req-1",
			answers: [{ value: "opt-a", label: "Option A" }],
			client,
		})
		expect(result).toBe("failed")
	})

	it("falls back to legacy question.reply when v2 is not available", async () => {
		const client = makeFakeClient({ hasV2: false })
		const result = await applyQuestion({
			sessionID: "s1",
			requestID: "req-1",
			answers: [{ value: "opt-a", label: "Option A" }],
			client,
		})
		expect(result).toBe("applied")
	})
})

describe("rejectQuestion", () => {
	it("returns applied for successful v2 question reject", async () => {
		const client = makeFakeClient()
		const result = await rejectQuestion({
			sessionID: "s1",
			requestID: "req-1",
			client,
		})
		expect(result).toBe("applied")
	})

	it("returns expired when v2 returns 404", async () => {
		const client = makeFakeNotFoundClient()
		const result = await rejectQuestion({
			sessionID: "s1",
			requestID: "req-1",
			client,
		})
		expect(result).toBe("expired")
	})

	it("falls back to legacy question.reject", async () => {
		const client = makeFakeClient({ hasV2: false })
		const result = await rejectQuestion({
			sessionID: "s1",
			requestID: "req-1",
			client,
		})
		expect(result).toBe("applied")
	})
})

describe("applyPermission", () => {
	it("returns applied for v2 permission reply (once)", async () => {
		const client = makeFakeClient()
		const result = await applyPermission({
			sessionID: "s1",
			requestID: "req-1",
			reply: "once",
			client,
		})
		expect(result).toBe("applied")
	})

	it("returns applied for v2 permission reply (always)", async () => {
		const client = makeFakeClient()
		const result = await applyPermission({
			sessionID: "s1",
			requestID: "req-1",
			reply: "always",
			client,
		})
		expect(result).toBe("applied")
	})

	it("returns applied for v2 permission reply (reject)", async () => {
		const client = makeFakeClient()
		const result = await applyPermission({
			sessionID: "s1",
			requestID: "req-1",
			reply: "reject",
			client,
		})
		expect(result).toBe("applied")
	})

	it("returns expired for 404 permission response", async () => {
		const client = makeFakeNotFoundClient()
		const result = await applyPermission({
			sessionID: "s1",
			requestID: "req-1",
			reply: "once",
			client,
		})
		expect(result).toBe("expired")
	})

	it("falls back to legacy permission.reply", async () => {
		const client = makeFakeClient({ hasV2: false })
		const result = await applyPermission({
			sessionID: "s1",
			requestID: "req-1",
			reply: "once",
			client,
		})
		expect(result).toBe("applied")
	})

	it("falls back to legacy permission.respond when reply is not available", async () => {
		const client = {
			permission: {
				respond: vi.fn().mockResolvedValue({ data: {} }),
			},
		} as unknown as OpencodeClient
		const result = await applyPermission({
			sessionID: "s1",
			requestID: "req-1",
			reply: "reject",
			client,
		})
		expect(result).toBe("applied")
	})

	it("returns failed when no client API is available", async () => {
		const client = {} as unknown as OpencodeClient
		const result = await applyPermission({
			sessionID: "s1",
			requestID: "req-1",
			reply: "once",
			client,
		})
		expect(result).toBe("failed")
	})
})

describe("integration: question + permission full flow", () => {
	it("completes a question-answer then permission-approve cycle", async () => {
		const client = makeFakeClient()

		const qResult = await applyQuestion({
			sessionID: "s-full",
			requestID: "req-q-full",
			answers: [{ value: "yes", label: "Yes" }],
			client,
		})
		expect(qResult).toBe("applied")

		const pResult = await applyPermission({
			sessionID: "s-full",
			requestID: "req-p-full",
			reply: "once",
			client,
		})
		expect(pResult).toBe("applied")
	})

	it("handles expired question followed by expired permission", async () => {
		const client = makeFakeNotFoundClient()

		const qResult = await applyQuestion({
			sessionID: "s-exp",
			requestID: "req-exp-q",
			answers: [{ value: "yes", label: "Yes" }],
			client,
		})
		expect(qResult).toBe("expired")

		const pResult = await applyPermission({
			sessionID: "s-exp",
			requestID: "req-exp-p",
			reply: "once",
			client,
		})
		expect(pResult).toBe("expired")
	})
})
