import { describe, it, expect, vi, beforeEach } from "vitest"
import { RelayBridge } from "../src/relay-bridge.js"
import type { IRelayBridge, IRelayClient } from "../src/relay-bridge.js"
import type { OpenCodeNotifyConfig, RelayConfig } from "../src/config.js"
import type { UpsertEvent } from "../src/events.js"
import type { OpencodeClient } from "../src/opencode-client.js"
import type { DecisionMessage } from "@repo/protocol"
import { createNotifyPlugin } from "../src/notify.js"
import type { PluginInput } from "@opencode-ai/plugin"

let applyQuestionMod: typeof import("../src/opencode-client.js")
let applyPermissionMod: typeof import("../src/opencode-client.js")

vi.mock("../src/opencode-client.js", async () => {
	const actual = await vi.importActual("../src/opencode-client.js")
	return {
		...actual,
		applyQuestion: vi.fn().mockResolvedValue("applied"),
		rejectQuestion: vi.fn().mockResolvedValue("applied"),
		applyPermission: vi.fn().mockResolvedValue("applied"),
	}
})

function relayConfig(overrides?: Partial<RelayConfig>): OpenCodeNotifyConfig {
	return {
		relay: {
			enabled: true,
			url: "wss://relay.example/ws",
			clientToken: "test-token",
			...overrides,
		},
		version: 1,
	}
}

function disabledConfig(): OpenCodeNotifyConfig {
	return {
		relay: { enabled: false },
		version: 1,
	}
}

function fakeRelayClient(overrides?: Partial<IRelayClient>): IRelayClient {
	return {
		connect: vi.fn(),
		shutdown: vi.fn(),
		sendUpsert: vi.fn(),
		sendCancel: vi.fn(),
		sendApplyResult: vi.fn().mockResolvedValue(undefined),
		...overrides,
	}
}

function fakeOpencodeClient(): OpencodeClient {
	return {} as OpencodeClient
}

function factoryWithState(): { client: IRelayClient } {
	const client = fakeRelayClient()
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const factory = vi.fn((_o: unknown) => client)
	return { client }
}

function decisionMessage(overrides: Partial<DecisionMessage["payload"]> & { requestId: string }): DecisionMessage {
	return {
		protocolVersion: 1,
		messageId: `srv-dec-${Date.now()}`,
		type: "decision",
		sentAt: new Date().toISOString(),
		payload: {
			clientId: "client-001",
			sessionId: "session-abc",
			...overrides,
		},
	} as DecisionMessage
}

describe("RelayBridge", () => {
	beforeEach(async () => {
		vi.clearAllMocks()
		applyQuestionMod = await import("../src/opencode-client.js")
		applyPermissionMod = await import("../src/opencode-client.js")
		vi.mocked(applyQuestionMod.applyQuestion).mockResolvedValue("applied")
		vi.mocked(applyQuestionMod.rejectQuestion).mockResolvedValue("applied")
		vi.mocked(applyPermissionMod.applyPermission).mockResolvedValue("applied")
	})

	describe("start/stop", () => {
		it("does not create RelayClient when relay is disabled", () => {
			const { client } = factoryWithState()
			const factory = vi.fn(() => client)

			const bridge = new RelayBridge({
				config: disabledConfig(),
				opencodeClient: fakeOpencodeClient(),
				clientId: "client-001",
				sessionId: "session-abc",
				relayClientFactory: factory,
			})
			bridge.start()

			expect(factory).not.toHaveBeenCalled()
			expect(client.connect).not.toHaveBeenCalled()
		})

		it("creates RelayClient and connects when relay is enabled", () => {
			const { client } = factoryWithState()
			const factory = vi.fn(() => client)

			const bridge = new RelayBridge({
				config: relayConfig(),
				opencodeClient: fakeOpencodeClient(),
				clientId: "client-001",
				sessionId: "session-abc",
				relayClientFactory: factory,
			})
			bridge.start()

			expect(factory).toHaveBeenCalledOnce()
			expect(client.connect).toHaveBeenCalledOnce()
		})

		it("creates RelayClient with a pairing code when no token exists", () => {
			const { client } = factoryWithState()
			const factory = vi.fn(() => client)

			const bridge = new RelayBridge({
				config: relayConfig({ clientToken: undefined }),
				opencodeClient: fakeOpencodeClient(),
				clientId: "client-001",
				sessionId: "session-abc",
				pairingCode: "ABCD-1234",
				relayClientFactory: factory,
			})
			bridge.start()

			expect(factory).toHaveBeenCalledWith(expect.objectContaining({
				clientToken: undefined,
				pairingCode: "ABCD-1234",
			}))
			expect(client.connect).toHaveBeenCalledOnce()
		})

		it("passes relay config to factory", () => {
			const { client } = factoryWithState()
			const factory = vi.fn(() => client)

			const bridge = new RelayBridge({
				config: relayConfig({ url: "wss://custom.example/ws", clientToken: "tok" }),
				opencodeClient: fakeOpencodeClient(),
				clientId: "client-001",
				sessionId: "session-abc",
				relayClientFactory: factory,
			})
			bridge.start()

			expect(factory).toHaveBeenCalledWith(
				expect.objectContaining({
					url: "wss://custom.example/ws",
					clientToken: "tok",
					clientId: "client-001",
					sessionId: "session-abc",
				}),
			)
		})

		it("shutdowns relay client on stop", () => {
			const { client } = factoryWithState()
			const factory = vi.fn(() => client)

			const bridge = new RelayBridge({
				config: relayConfig(),
				opencodeClient: fakeOpencodeClient(),
				clientId: "client-001",
				sessionId: "session-abc",
				relayClientFactory: factory,
			})
			bridge.start()
			bridge.stop()

			expect(client.shutdown).toHaveBeenCalledOnce()
		})

		it("reconnects with a replacement pairing code", () => {
			const first = fakeRelayClient()
			const replacement = fakeRelayClient()
			const factory = vi.fn()
				.mockReturnValueOnce(first)
				.mockReturnValueOnce(replacement)
			const bridge = new RelayBridge({
				config: relayConfig({ clientToken: undefined }),
				opencodeClient: fakeOpencodeClient(),
				clientId: "client-001",
				sessionId: "session-abc",
				pairingCode: "ABCD-1234",
				relayClientFactory: factory,
			})

			bridge.start()
			bridge.replacePairingCode("WXYZ-9876")

			expect(first.shutdown).toHaveBeenCalledOnce()
			expect(factory).toHaveBeenLastCalledWith(expect.objectContaining({ pairingCode: "WXYZ-9876" }))
			expect(replacement.connect).toHaveBeenCalledOnce()
		})

		it("stop is safe when relay was never started", () => {
			const { client } = factoryWithState()
			const factory = vi.fn(() => client)

			const bridge = new RelayBridge({
				config: disabledConfig(),
				opencodeClient: fakeOpencodeClient(),
				clientId: "client-001",
				sessionId: "session-abc",
				relayClientFactory: factory,
			})
			expect(() => bridge.stop()).not.toThrow()
		})
	})

	describe("handleEvent", () => {
		it("sends upsert for question.asked events", () => {
			const { client } = factoryWithState()
			const factory = vi.fn(() => client)

			const bridge = new RelayBridge({
				config: relayConfig(),
				opencodeClient: fakeOpencodeClient(),
				clientId: "client-001",
				sessionId: "session-abc",
				relayClientFactory: factory,
			})
			bridge.start()

			bridge.handleEvent({
				type: "question.asked",
				properties: {
					sessionID: "s1",
					requestID: "req-1",
					questions: [{ question: "Are you sure?", options: [{ label: "Yes", value: "yes" }] }],
				},
			})

			expect(client.sendUpsert).toHaveBeenCalledOnce()
			const upsert = (client.sendUpsert as ReturnType<typeof vi.fn>).mock.calls[0][0] as UpsertEvent
			expect(upsert.requestId).toBe("req-1")
			expect(upsert.question?.text).toBe("Are you sure?")
		})

		it("sends upsert for permission.asked events", () => {
			const { client } = factoryWithState()
			const factory = vi.fn(() => client)

			const bridge = new RelayBridge({
				config: relayConfig(),
				opencodeClient: fakeOpencodeClient(),
				clientId: "client-001",
				sessionId: "session-abc",
				relayClientFactory: factory,
			})
			bridge.start()

			bridge.handleEvent({
				type: "permission.asked",
				properties: {
					sessionID: "s1",
					requestID: "req-p1",
					permission: "bash",
					patterns: ["*"],
				},
			})

			expect(client.sendUpsert).toHaveBeenCalledOnce()
			const upsert = (client.sendUpsert as ReturnType<typeof vi.fn>).mock.calls[0][0] as UpsertEvent
			expect(upsert.requestId).toBe("req-p1")
			expect(upsert.permission?.action).toBe("bash")
		})

		it("does nothing for non-relay events", () => {
			const { client } = factoryWithState()
			const factory = vi.fn(() => client)

			const bridge = new RelayBridge({
				config: relayConfig(),
				opencodeClient: fakeOpencodeClient(),
				clientId: "client-001",
				sessionId: "session-abc",
				relayClientFactory: factory,
			})
			bridge.start()

			bridge.handleEvent({ type: "session.idle", properties: { sessionID: "s1" } })

			expect(client.sendUpsert).not.toHaveBeenCalled()
		})

		it("does nothing when relay is not started", () => {
			const { client } = factoryWithState()
			const factory = vi.fn(() => client)

			const bridge = new RelayBridge({
				config: disabledConfig(),
				opencodeClient: fakeOpencodeClient(),
				clientId: "client-001",
				sessionId: "session-abc",
				relayClientFactory: factory,
			})

			bridge.handleEvent({ type: "question.asked", properties: { sessionID: "s1", requestID: "req-1", questions: [{ question: "Q", options: [{ label: "A", value: "a" }] }] } })

			expect(client.sendUpsert).not.toHaveBeenCalled()
		})
	})

	describe("decision mapping", () => {
		it("permission approved=false maps to reject", async () => {
			const { client } = factoryWithState()
			let onDecisionCb: ((d: DecisionMessage) => void) | null = null
			const factory = vi.fn((opts: unknown) => {
				onDecisionCb = (opts as { onDecision: (d: DecisionMessage) => void }).onDecision
				return client
			})

			const bridge = new RelayBridge({
				config: relayConfig(),
				opencodeClient: fakeOpencodeClient(),
				clientId: "client-001",
				sessionId: "session-abc",
				relayClientFactory: factory,
			})
			bridge.start()

			expect(onDecisionCb).not.toBeNull()
			await onDecisionCb!(decisionMessage({
				requestId: "req-p1",
				approved: false,
				always: false,
			}))

			await vi.waitFor(() => {
				expect(applyPermissionMod.applyPermission).toHaveBeenCalledWith(
					expect.objectContaining({
						sessionID: "session-abc",
						requestID: "req-p1",
						reply: "reject",
					}),
				)
				expect(client.sendApplyResult).toHaveBeenCalledWith("req-p1", true, undefined)
			}, { timeout: 500 })
		})

		it("permission approved=true & always=true maps to always", async () => {
			const { client } = factoryWithState()
			let onDecisionCb: ((d: DecisionMessage) => void) | null = null
			const factory = vi.fn((opts: unknown) => {
				onDecisionCb = (opts as { onDecision: (d: DecisionMessage) => void }).onDecision
				return client
			})

			const bridge = new RelayBridge({
				config: relayConfig(),
				opencodeClient: fakeOpencodeClient(),
				clientId: "client-001",
				sessionId: "session-abc",
				relayClientFactory: factory,
			})
			bridge.start()

			await onDecisionCb!(decisionMessage({
				requestId: "req-p2",
				approved: true,
				always: true,
			}))

			await vi.waitFor(() => {
				expect(applyPermissionMod.applyPermission).toHaveBeenCalledWith(
					expect.objectContaining({
						requestID: "req-p2",
						reply: "always",
					}),
				)
			}, { timeout: 500 })
		})

		it("permission approved=true without always maps to once", async () => {
			const { client } = factoryWithState()
			let onDecisionCb: ((d: DecisionMessage) => void) | null = null
			const factory = vi.fn((opts: unknown) => {
				onDecisionCb = (opts as { onDecision: (d: DecisionMessage) => void }).onDecision
				return client
			})

			const bridge = new RelayBridge({
				config: relayConfig(),
				opencodeClient: fakeOpencodeClient(),
				clientId: "client-001",
				sessionId: "session-abc",
				relayClientFactory: factory,
			})
			bridge.start()

			await onDecisionCb!(decisionMessage({
				requestId: "req-p3",
				approved: true,
			}))

			await vi.waitFor(() => {
				expect(applyPermissionMod.applyPermission).toHaveBeenCalledWith(
					expect.objectContaining({
						requestID: "req-p3",
						reply: "once",
					}),
				)
			}, { timeout: 500 })
		})

		it("permission approved=true & always=false maps to once", async () => {
			const { client } = factoryWithState()
			let onDecisionCb: ((d: DecisionMessage) => void) | null = null
			const factory = vi.fn((opts: unknown) => {
				onDecisionCb = (opts as { onDecision: (d: DecisionMessage) => void }).onDecision
				return client
			})

			const bridge = new RelayBridge({
				config: relayConfig(),
				opencodeClient: fakeOpencodeClient(),
				clientId: "client-001",
				sessionId: "session-abc",
				relayClientFactory: factory,
			})
			bridge.start()

			await onDecisionCb!(decisionMessage({
				requestId: "req-p4",
				approved: true,
				always: false,
			}))

			await vi.waitFor(() => {
				expect(applyPermissionMod.applyPermission).toHaveBeenCalledWith(
					expect.objectContaining({
						requestID: "req-p4",
						reply: "once",
					}),
				)
			}, { timeout: 500 })
		})

		it("question decision applies answers via applyQuestion", async () => {
			const { client } = factoryWithState()
			let onDecisionCb: ((d: DecisionMessage) => void) | null = null
			const factory = vi.fn((opts: unknown) => {
				onDecisionCb = (opts as { onDecision: (d: DecisionMessage) => void }).onDecision
				return client
			})

			const bridge = new RelayBridge({
				config: relayConfig(),
				opencodeClient: fakeOpencodeClient(),
				clientId: "client-001",
				sessionId: "session-abc",
				relayClientFactory: factory,
			})
			bridge.start()

			await onDecisionCb!(decisionMessage({
				requestId: "req-q1",
				answers: [{ value: "opt-a", label: "Option A" }],
			}))

			await vi.waitFor(() => {
				expect(applyQuestionMod.applyQuestion).toHaveBeenCalledWith(
					expect.objectContaining({
						sessionID: "session-abc",
						requestID: "req-q1",
						answers: [{ value: "opt-a", label: "Option A" }],
					}),
				)
			}, { timeout: 500 })
		})

		it("sends apply_result with failure status when apply fails", async () => {
			const { client } = factoryWithState()
			let onDecisionCb: ((d: DecisionMessage) => void) | null = null
			const factory = vi.fn((opts: unknown) => {
				onDecisionCb = (opts as { onDecision: (d: DecisionMessage) => void }).onDecision
				return client
			})

			const mockApplyPerm = vi.fn().mockResolvedValue("failed")
			vi.mocked(applyPermissionMod.applyPermission).mockImplementation(mockApplyPerm)

			const bridge = new RelayBridge({
				config: relayConfig(),
				opencodeClient: fakeOpencodeClient(),
				clientId: "client-001",
				sessionId: "session-abc",
				relayClientFactory: factory,
			})
			bridge.start()

			await onDecisionCb!(decisionMessage({
				requestId: "req-fail",
				approved: true,
			}))

			await vi.waitFor(() => {
				expect(client.sendApplyResult).toHaveBeenCalledWith("req-fail", false, "failed")
			}, { timeout: 500 })
		})

		it("sends apply_result with expired status on 404", async () => {
			const { client } = factoryWithState()
			let onDecisionCb: ((d: DecisionMessage) => void) | null = null
			const factory = vi.fn((opts: unknown) => {
				onDecisionCb = (opts as { onDecision: (d: DecisionMessage) => void }).onDecision
				return client
			})

			const mockApplyPerm = vi.fn().mockResolvedValue("expired")
			vi.mocked(applyPermissionMod.applyPermission).mockImplementation(mockApplyPerm)

			const bridge = new RelayBridge({
				config: relayConfig(),
				opencodeClient: fakeOpencodeClient(),
				clientId: "client-001",
				sessionId: "session-abc",
				relayClientFactory: factory,
			})
			bridge.start()

			await onDecisionCb!(decisionMessage({
				requestId: "req-expired",
				approved: true,
			}))

			await vi.waitFor(() => {
				expect(client.sendApplyResult).toHaveBeenCalledWith("req-expired", false, "expired")
			}, { timeout: 500 })
		})

		it("handles errors in decision processing gracefully", async () => {
			const { client } = factoryWithState()
			let onDecisionCb: ((d: DecisionMessage) => void) | null = null
			const factory = vi.fn((opts: unknown) => {
				onDecisionCb = (opts as { onDecision: (d: DecisionMessage) => void }).onDecision
				return client
			})

			const mockApplyPerm = vi.fn().mockRejectedValue(new Error("boom"))
			vi.mocked(applyPermissionMod.applyPermission).mockImplementation(mockApplyPerm)

			const bridge = new RelayBridge({
				config: relayConfig(),
				opencodeClient: fakeOpencodeClient(),
				clientId: "client-001",
				sessionId: "session-abc",
				relayClientFactory: factory,
			})
			bridge.start()

			expect(() => {
				onDecisionCb!(decisionMessage({
					requestId: "req-boom",
					approved: true,
				}))
			}).not.toThrow()
		})
	})

	describe("eventToUpsert integration", () => {
		it("sends upsert for permission.v2.asked events", () => {
			const { client } = factoryWithState()
			const factory = vi.fn(() => client)

			const bridge = new RelayBridge({
				config: relayConfig(),
				opencodeClient: fakeOpencodeClient(),
				clientId: "client-001",
				sessionId: "session-abc",
				relayClientFactory: factory,
			})
			bridge.start()

			bridge.handleEvent({
				type: "permission.v2.asked",
				properties: {
					sessionID: "s1",
					requestID: "req-v2",
					action: "bash",
					resources: ["/usr/bin/*"],
				},
			})

			expect(client.sendUpsert).toHaveBeenCalledOnce()
			const upsert = (client.sendUpsert as ReturnType<typeof vi.fn>).mock.calls[0][0] as UpsertEvent
			expect(upsert.requestId).toBe("req-v2")
			expect(upsert.permission?.patterns).toContain("/usr/bin/*")
		})

		it("sends upsert for question.v2.asked events", () => {
			const { client } = factoryWithState()
			const factory = vi.fn(() => client)

			const bridge = new RelayBridge({
				config: relayConfig(),
				opencodeClient: fakeOpencodeClient(),
				clientId: "client-001",
				sessionId: "session-abc",
				relayClientFactory: factory,
			})
			bridge.start()

			bridge.handleEvent({
				type: "question.v2.asked",
				properties: {
					sessionID: "s1",
					requestID: "req-v2-q",
					questions: [{ question: "Confirm?", options: [{ label: "OK", value: "ok" }] }],
				},
			})

			expect(client.sendUpsert).toHaveBeenCalledOnce()
			const upsert = (client.sendUpsert as ReturnType<typeof vi.fn>).mock.calls[0][0] as UpsertEvent
			expect(upsert.question?.text).toBe("Confirm?")
		})
	})
})

describe("plugin-level relay bridge integration", () => {
	function makeFakeRealBridge(): IRelayBridge & { relayClient: IRelayClient } {
		const relayClient = fakeRelayClient()
		const bridge = new RelayBridge({
			config: relayConfig(),
			opencodeClient: fakeOpencodeClient(),
			clientId: "client-001",
			sessionId: "session-abc",
			relayClientFactory: () => relayClient,
		})
		return Object.assign(bridge, { relayClient })
	}

	function buildPluginInput(overrides: Partial<PluginInput> = {}): PluginInput {
		return {
			client: overrides.client ?? ({} as PluginInput["client"]),
			tool: overrides.tool ?? "",
			sessionID: overrides.sessionID ?? "",
			callID: overrides.callID ?? "",
		} as PluginInput
	}

	it("routes question.asked through relay bridge via plugin", async () => {
		const bridge = makeFakeRealBridge()
		bridge.start()

		const plugin = createNotifyPlugin(undefined, { relayBridge: bridge })
		const instance = await plugin(buildPluginInput())

		await instance.event({
			event: {
				type: "question.asked",
				properties: {
					sessionID: "s1",
					requestID: "req-int-1",
					questions: [{ question: "Confirm integration?", options: [{ label: "Y", value: "y" }] }],
				},
			},
		} as Parameters<PluginInput["event"]>[0])

		await vi.waitFor(() => {
			expect(bridge.relayClient.sendUpsert).toHaveBeenCalledWith(
				expect.objectContaining({
					requestId: "req-int-1",
				}),
			)
		}, { timeout: 500 })
	})

	it("routes permission.asked through relay bridge via plugin", async () => {
		const bridge = makeFakeRealBridge()
		bridge.start()

		const plugin = createNotifyPlugin(undefined, { relayBridge: bridge })
		const instance = await plugin(buildPluginInput())

		await instance.event({
			event: {
				type: "permission.asked",
				properties: {
					sessionID: "s1",
					requestID: "req-int-p1",
					permission: "bash",
					patterns: ["*"],
				},
			},
		} as Parameters<PluginInput["event"]>[0])

		await vi.waitFor(() => {
			expect(bridge.relayClient.sendUpsert).toHaveBeenCalledWith(
				expect.objectContaining({
					requestId: "req-int-p1",
				}),
			)
		}, { timeout: 500 })
	})

	it("does not block desktop notifications when relay is active", async () => {
		const bridge = makeFakeRealBridge()
		bridge.start()

		const plugin = createNotifyPlugin(undefined, { relayBridge: bridge })
		const instance = await plugin(buildPluginInput())

		await expect(
			instance.event({
				event: {
					type: "question.asked",
					properties: {
						sessionID: "s1",
						requestID: "req-nb-1",
						questions: [{ question: "Nonblocking test?", options: [{ label: "Y", value: "y" }] }],
					},
				},
			} as Parameters<PluginInput["event"]>[0]),
		).resolves.toBeUndefined()
	})

	it("non-relay events still go through plugin normally when relay bridge is present", async () => {
		const bridge = makeFakeRealBridge()
		bridge.start()

		const plugin = createNotifyPlugin(undefined, { relayBridge: bridge })
		const instance = await plugin(buildPluginInput())

		await expect(
			instance.event({
				event: {
					type: "session.idle",
					properties: {
						sessionID: "s1",
						title: "Done",
					},
				},
			} as Parameters<PluginInput["event"]>[0]),
		).resolves.toBeUndefined()
	})

	it("bridge is started when plugin initializes", async () => {
		const bridge: IRelayBridge = {
			start: vi.fn(),
			stop: vi.fn(),
			handleEvent: vi.fn(),
		}

		const plugin = createNotifyPlugin(undefined, { relayBridge: bridge })
		const instance = await plugin(buildPluginInput())

		expect(bridge.start).toHaveBeenCalledOnce()
		expect(instance.event).toBeDefined()
	})

	it("plugin works without relay bridge (disabled by default)", async () => {
		const plugin = createNotifyPlugin()
		const instance = await plugin(buildPluginInput())

		await expect(
			instance.event({
				event: {
					type: "question.asked",
					properties: {
						sessionID: "s1",
						requestID: "req-norel-1",
						questions: [{ question: "No relay?", options: [{ label: "Y", value: "y" }] }],
					},
				},
			} as Parameters<PluginInput["event"]>[0]),
		).resolves.toBeUndefined()
	})

	it("handles permission decision apply cycle through real bridge", async () => {
		const relayClient = fakeRelayClient()
		let onDecisionCb: ((d: DecisionMessage) => void) | null = null
		const relayFactory = vi.fn((opts: unknown) => {
			onDecisionCb = (opts as { onDecision: (d: DecisionMessage) => void }).onDecision
			return relayClient
		})

		const bridge = new RelayBridge({
			config: relayConfig(),
			opencodeClient: fakeOpencodeClient(),
			clientId: "client-001",
			sessionId: "session-abc",
			relayClientFactory: relayFactory,
		})
		bridge.start()

		expect(onDecisionCb).not.toBeNull()

		await onDecisionCb!(decisionMessage({
			requestId: "req-integration-perm",
			approved: true,
			always: true,
		}))

		await vi.waitFor(() => {
			expect(applyPermissionMod.applyPermission).toHaveBeenCalledWith(
				expect.objectContaining({
					requestID: "req-integration-perm",
					reply: "always",
				}),
			)
			expect(relayClient.sendApplyResult).toHaveBeenCalledWith("req-integration-perm", true, undefined)
		}, { timeout: 500 })
	})

	it("handles question decision apply cycle through real bridge", async () => {
		const relayClient = fakeRelayClient()
		let onDecisionCb: ((d: DecisionMessage) => void) | null = null
		const relayFactory = vi.fn((opts: unknown) => {
			onDecisionCb = (opts as { onDecision: (d: DecisionMessage) => void }).onDecision
			return relayClient
		})

		const bridge = new RelayBridge({
			config: relayConfig(),
			opencodeClient: fakeOpencodeClient(),
			clientId: "client-001",
			sessionId: "session-abc",
			relayClientFactory: relayFactory,
		})
		bridge.start()

		expect(onDecisionCb).not.toBeNull()

		await onDecisionCb!(decisionMessage({
			requestId: "req-integration-q",
			answers: [{ value: "yes", label: "Yes" }],
		}))

		await vi.waitFor(() => {
			expect(applyQuestionMod.applyQuestion).toHaveBeenCalledWith(
				expect.objectContaining({
					requestID: "req-integration-q",
					answers: [{ value: "yes", label: "Yes" }],
				}),
			)
			expect(relayClient.sendApplyResult).toHaveBeenCalledWith("req-integration-q", true, undefined)
		}, { timeout: 500 })
	})
})
