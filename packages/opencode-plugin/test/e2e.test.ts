import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RelayClient } from "../src/relay-client.js";
import type { DecisionMessage } from "@repo/protocol";
import type { OpencodeClient } from "../src/opencode-client.js";

// ─── Fake WebSocket Server ─────────────────────────────

class FakeWsServer {
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  readyState = 1; // OPEN
  url: string;

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(event: string, fn: (...args: unknown[]) => void) {
    (this.listeners[event] ??= []).push(fn);
  }

  removeEventListener(event: string, fn: (...args: unknown[]) => void) {
    const arr = this.listeners[event];
    if (arr) {
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    }
  }

  emit(event: string, ...args: unknown[]) {
    for (const fn of this.listeners[event] ?? []) {
      try {
        if (event === "message") {
          fn({ data: args[0] } as MessageEvent);
        } else {
          fn(...args);
        }
      } catch { /* */ }
    }
  }

  sentMessages: string[] = [];

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = 3; // CLOSED
  }
}

// ─── Fake OpenCode Client ─────────────────────────────

function makeFakeOpencodeClient(): OpencodeClient {
  const reply = vi.fn().mockResolvedValue({ data: {} });
  const reject = vi.fn().mockResolvedValue({ data: {} });
  const permReply = vi.fn().mockResolvedValue({ data: {} });

  return {
    v2: {
      session: {
        question: { reply, reject },
        permission: { reply: permReply },
      },
    },
  } as unknown as OpencodeClient;
}

// ─── Test helpers ──────────────────────────────────────

function makePairingResponse(paired: boolean) {
  return JSON.stringify({
    protocolVersion: 1,
    messageId: `srv-pair-${Date.now()}`,
    type: "pairing",
    sentAt: new Date().toISOString(),
    payload: {
      clientId: "client-opencode-001",
      sessionId: "session-abc123",
      paired,
    },
  });
}

function makeDecision(requestId: string, approved = true): DecisionMessage {
  return {
    protocolVersion: 1,
    messageId: `srv-dec-${requestId}`,
    type: "decision",
    sentAt: new Date().toISOString(),
    payload: {
      requestId,
      clientId: "client-opencode-001",
      sessionId: "session-abc123",
      approved,
    },
  };
}

function makeAnswersDecision(requestId: string, answers: Array<{ value: string; label: string }>): DecisionMessage {
  return {
    protocolVersion: 1,
    messageId: `srv-dec-${requestId}`,
    type: "decision",
    sentAt: new Date().toISOString(),
    payload: {
      requestId,
      clientId: "client-opencode-001",
      sessionId: "session-abc123",
      answers,
    },
  };
}

// ─── Tests ─────────────────────────────────────────────

describe("E2E: plugin end-to-end with fake server and fake OpenCode", () => {
  let fakeServer: FakeWsServer | null = null;
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    fakeServer = null;
    originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = function (url: string) {
      fakeServer = new FakeWsServer(url);
      // Simulate async open
      queueMicrotask(() => {
        if (fakeServer) fakeServer.emit("open", {});
      });
      return fakeServer as unknown as WebSocket;
    } as unknown as typeof WebSocket;
    (globalThis.WebSocket as unknown as Record<string, unknown>).OPEN = 1;
    (globalThis.WebSocket as unknown as Record<string, unknown>).CLOSED = 3;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    vi.restoreAllMocks();
  });

  function createPlugin(options?: { onDecision?: (d: DecisionMessage) => void }) {
    return new RelayClient({
      url: "wss://fake-relay/ws",
      clientToken: "fake-pairing-token",
      clientId: "client-opencode-001",
      sessionId: "session-abc123",
      onDecision: options?.onDecision ?? vi.fn(),
      onStatusChange: vi.fn(),
      heartbeatIntervalMs: 50,
      maxReconnectDelayMs: 100,
    });
  }

  it("connects, pairs, receives decision, applies via fake OpenCode, sends apply_result", async () => {
    const fakeCodeClient = makeFakeOpencodeClient();

    let resolvedDecision: DecisionMessage | null = null;
    const decisionPromise = new Promise<DecisionMessage>((resolve) => {
      const relay = createPlugin({
        onDecision: async (d) => {
          // Simulate applying via fake OpenCode
          const result = await (fakeCodeClient as unknown as {
            v2: { session: { question: { reply: ReturnType<typeof vi.fn> } } }
          }).v2.session.question.reply({
            sessionID: d.payload.sessionId,
            requestID: d.payload.requestId,
            questionV2Reply: { answers: [{ answer: "opt-a" }] },
          });
          expect(result.data).toBeDefined();

          // Send apply_result
          await relay.sendApplyResult(d.payload.requestId, true);
          resolve(d);
        },
      });
      relay.connect();
    });

    await vi.waitFor(() => { expect(fakeServer).not.toBeNull(); }, { timeout: 200 });

    // Server sends pairing success
    fakeServer!.emit("message", makePairingResponse(true));

    await vi.waitFor(() => {
      // Client sends its identity after the authenticated WebSocket opens.
      const msgs = fakeServer!.sentMessages;
      expect(msgs.some((m) => m.includes('"hello"'))).toBe(true);
    }, { timeout: 500 });

    // Server sends a decision
    const dec = makeAnswersDecision("req-e2e-plugin", [{ value: "opt-a", label: "Option A" }]);
    fakeServer!.emit("message", JSON.stringify(dec));

    resolvedDecision = await decisionPromise;
    expect(resolvedDecision).toBeDefined();
    expect(resolvedDecision!.payload.requestId).toBe("req-e2e-plugin");

    // Verify apply_result was sent
    await vi.waitFor(() => {
      const hasApplyResult = fakeServer!.sentMessages.some(
        (m) => m.includes('"apply_result"') && m.includes("req-e2e-plugin"),
      );
      expect(hasApplyResult).toBe(true);
    }, { timeout: 500 });
  }, 10_000);

  it("receives permission decision and applies with reject", async () => {
    const fakeCodeClient = makeFakeOpencodeClient();

    let resolvedDecision: DecisionMessage | null = null;
    const decisionPromise = new Promise<DecisionMessage>((resolve) => {
      const relay = createPlugin({
        onDecision: async (d) => {
          const permReply = (fakeCodeClient as unknown as {
            v2: { session: { permission: { reply: ReturnType<typeof vi.fn> } } }
          }).v2.session.permission.reply;
          await permReply({
            sessionID: d.payload.sessionId,
            requestID: d.payload.requestId,
            reply: "reject",
          });
          await relay.sendApplyResult(d.payload.requestId, true);
          resolve(d);
        },
      });
      relay.connect();
    });

    await vi.waitFor(() => { expect(fakeServer).not.toBeNull(); }, { timeout: 200 });

    fakeServer!.emit("message", makePairingResponse(true));

    await vi.waitFor(() => {
      expect(fakeServer!.sentMessages.some((m) => m.includes('"hello"'))).toBe(true);
    }, { timeout: 500 });

    const dec = makeDecision("req-e2e-perm", false);
    fakeServer!.emit("message", JSON.stringify(dec));

    resolvedDecision = await decisionPromise;
    expect(resolvedDecision).toBeDefined();
    expect(resolvedDecision!.payload.approved).toBe(false);

    await vi.waitFor(() => {
      expect(fakeServer!.sentMessages.some((m) => m.includes("req-e2e-perm"))).toBe(true);
    }, { timeout: 500 });
  }, 10_000);

  it("sends hello after connecting", async () => {
    const relay = createPlugin();
    relay.connect();

    await vi.waitFor(() => { expect(fakeServer).not.toBeNull(); }, { timeout: 200 });

    fakeServer!.emit("message", makePairingResponse(true));

    await vi.waitFor(() => {
      expect(relay.currentStatus).toBe("paired");
    }, { timeout: 500 });

    // Authentication is part of the WebSocket URL; hello carries session identity.
    expect(fakeServer!.sentMessages.join("\n")).toContain('"hello"');
  }, 10_000);

  it("buffers upserts while not paired and flushes after pairing", async () => {
    const relay = createPlugin();
    relay.connect();

    await vi.waitFor(() => { expect(fakeServer).not.toBeNull(); }, { timeout: 200 });

    // Send upsert before paired
    relay.sendUpsert({
      requestId: "req-buffered",
      clientId: "client-opencode-001",
      sessionId: "session-abc123",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      question: {
        text: "Buffered?",
        options: [{ label: "Yes", value: "yes" }],
      },
    });

    // Not yet paired, so no upsert sent
    const prePair = fakeServer!.sentMessages.join("\n");
    expect(prePair).not.toContain("req-buffered");

    // Now pair
    fakeServer!.emit("message", makePairingResponse(true));

    await vi.waitFor(() => {
      const postPair = fakeServer!.sentMessages.join("\n");
      expect(postPair).toContain("req-buffered");
    }, { timeout: 500 });
  }, 10_000);
});
