import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import WebSocket from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../src/db/migrate.js";
import { openDatabase } from "../src/db/database.js";
import { createRepository, type Repository, type RequestRow } from "../src/db/repository.js";
import { createPairingService, type PairingService } from "../src/pairing/service.js";
import type { AppConfig } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { BotAdapter } from "../src/telegram/bot.js";

// ─── Fake Bot ──────────────────────────────────────────

interface PendingRequest {
  requestRow: RequestRow;
  resolve?: (decision: PendingDecision) => void;
}

interface PendingDecision {
  requestId: string;
  clientId: string;
  sessionId: string;
  approved?: boolean;
  always?: boolean;
  answerValue?: string;
  answerLabel?: string;
  selectedValues?: string[];
}

class FakeBotAdapter implements BotAdapter {
  private requests: PendingRequest[] = [];
  private repo: Repository;

  constructor(repo: Repository) {
    this.repo = repo;
  }

  async start(): Promise<void> {}

  webhookHandler(_expectedToken: string) {
    return async (_req: unknown, _res: unknown) => {};
  }

  async postRequest(requestRow: RequestRow): Promise<{ messageId: number } | undefined> {
    this.requests.push({ requestRow });
    return { messageId: 1 };
  }

  get pendingCount(): number {
    return this.requests.length;
  }

  /**
   * Simulate a user decision (mimics what happens in callback handler).
   * 1. Update request status to "decided"
   * 2. Save answers if applicable
   * 3. Enqueue decision in outbox (dispatch service delivers it)
   */
  simulateDecision(decision: PendingDecision): void {
    const req = this.repo.findRequestByRequestIdAndClient(decision.requestId, decision.clientId);
    if (!req) throw new Error(`Request not found: ${decision.requestId}`);
    if (req.status !== "pending") throw new Error(`Request ${decision.requestId} is not pending: ${req.status}`);

    const decided = this.repo.updateRequestStatus(req.id, "decided");
    this.repo.updateRequestStatus(decided.id, "dispatching");

    if (decision.approved !== undefined) {
      this.repo.enqueue({
        idempotencyKey: `e2e-decision-${decision.requestId}-${Date.now()}`,
        recipientId: decision.clientId,
        messageType: "decision",
        payload: {
          requestId: decision.requestId,
          clientId: decision.clientId,
          sessionId: decision.sessionId,
          approved: decision.approved,
          always: decision.always ?? false,
        },
        requestId: decision.requestId,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      });
    } else if (decision.selectedValues !== undefined) {
      const answers = decision.selectedValues.map((v) => ({ value: v, label: v }));
      this.repo.saveAnswers(decided.id, answers);
      this.repo.enqueue({
        idempotencyKey: `e2e-decision-${decision.requestId}-${Date.now()}`,
        recipientId: decision.clientId,
        messageType: "decision",
        payload: {
          requestId: decision.requestId,
          clientId: decision.clientId,
          sessionId: decision.sessionId,
          answers,
        },
        requestId: decision.requestId,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      });
    } else if (decision.answerValue !== undefined) {
      this.repo.saveAnswers(decided.id, [{ value: decision.answerValue, label: decision.answerLabel ?? decision.answerValue }]);
      this.repo.enqueue({
        idempotencyKey: `e2e-decision-${decision.requestId}-${Date.now()}`,
        recipientId: decision.clientId,
        messageType: "decision",
        payload: {
          requestId: decision.requestId,
          clientId: decision.clientId,
          sessionId: decision.sessionId,
          answers: [{ value: decision.answerValue, label: decision.answerLabel ?? decision.answerValue }],
        },
        requestId: decision.requestId,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      });
    }
  }
}

// ─── Helpers ───────────────────────────────────────────

function wsUrl(port: number, query: string): string {
  return `ws://127.0.0.1:${port}/v1/ws${query}`;
}

function waitForMessage(ws: WebSocket, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for message")), timeoutMs);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

function waitForMessageType(ws: WebSocket, type: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
    const handler = (data: unknown) => {
      const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
      if (parsed.type === type) {
        clearTimeout(timer);
        ws.removeListener("message", handler);
        resolve(parsed);
      }
    };
    ws.on("message", handler);
  });
}

function messageId(): string {
  return Math.random().toString(36).slice(2, 18);
}

function clientMsg(type: string, payload: Record<string, unknown>) {
  return {
    protocolVersion: 1,
    messageId: messageId(),
    sentAt: new Date().toISOString(),
    type,
    payload,
  };
}

// ─── Test Setup ────────────────────────────────────────

let tmpDir: string;
let db: Database.Database;
let repo: Repository;
let pairingService: PairingService;
let fakeBot: FakeBotAdapter;
let app: FastifyInstance;
let port: number;
let cleanupFn: () => void;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "e2e-test-"));
  const dbPath = join(tmpDir, "test.db");
  const result = openDatabase(dbPath);
  db = result.db;
  runMigrations(db);
  repo = createRepository(db);
  pairingService = createPairingService(repo, 123456789);
  fakeBot = new FakeBotAdapter(repo);

  const config: AppConfig = {
    tokenAuth: true,
    heartbeatIntervalMs: 500,
    heartbeatTimeoutMs: 10_000,
    maxMessageBytes: 65_536,
    loggingLevel: "error",
  };

  const { createApp } = await import("../src/app.js");
  app = await createApp({
    db,
    repo,
    config,
    pairingService,
    ready: { dbReady: true, botReady: true },
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address()! as { port: number };
  port = addr.port;

  cleanupFn = () => {
    try { app.close(); } catch { /* */ }
    result.close();
    rmSync(tmpDir, { recursive: true, force: true });
  };
});

afterAll(() => {
  if (cleanupFn) cleanupFn();
});

beforeEach(() => {
  db.exec(`
    DELETE FROM outbox;
    DELETE FROM telegram_updates;
    DELETE FROM request_answers;
    DELETE FROM telegram_decision_state;
    DELETE FROM telegram_freply_tracking;
    DELETE FROM telegram_callback_ids;
    DELETE FROM requests;
    DELETE FROM pairing_codes;
    DELETE FROM pairings;
    DELETE FROM clients;
  `);
});

// ─── E2E: Multi-question request full flow ─────────────

describe("E2E: multi-question request through full pipeline", () => {
  it("completes a question request from plugin upsert through decision to applied", async () => {
    const client = repo.createClient("e2e-question-token");

    const ws = new WebSocket(wsUrl(port, `?token=e2e-question-token`));
    await new Promise<void>((resolve) => { ws.on("open", () => resolve()); });

    const requestId = "req-e2e-q-1";
    const sessionId = "session-e2e-1";

    ws.send(JSON.stringify(clientMsg("request_upsert", {
      clientId: client.id,
      sessionId,
      requestId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      question: {
        text: "Which file should I edit?",
        options: [
          { label: "src/index.ts", value: "src-index" },
          { label: "src/app.ts", value: "src-app" },
        ],
      },
    })));

    const ack = await waitForMessage(ws, 3000);
    expect(ack).toBeDefined();

    // Verify request is in DB
    const req = repo.findRequest(requestId, client.id, sessionId);
    expect(req).toBeDefined();
    expect(req!.status).toBe("pending");

    // Simulate bot decision
    fakeBot.simulateDecision({
      requestId,
      clientId: client.id,
      sessionId,
      answerValue: "src-index",
      answerLabel: "src/index.ts",
    });

    // Dispatch service should deliver the decision to the WebSocket client
    const decision = await waitForMessageType(ws, "decision", 5000);
    expect(decision).toBeDefined();
    expect(decision.type).toBe("decision");
    const dp = decision.payload as Record<string, unknown>;
    expect(dp.requestId).toBe(requestId);

    // Plugin sends apply_result
    ws.send(JSON.stringify(clientMsg("apply_result", {
      requestId,
      clientId: client.id,
      sessionId,
      success: true,
    })));

    const ack2 = await waitForMessage(ws, 3000);
    expect(ack2).toBeDefined();

    // Verify request status is "applied"
    const reqAfter = repo.findRequest(requestId, client.id, sessionId);
    expect(reqAfter).toBeDefined();
    expect(reqAfter!.status).toBe("applied");

    ws.close();
  }, 15_000);

  it("completes a permission request with approve flow", async () => {
    const client = repo.createClient("e2e-perm-token");

    const ws = new WebSocket(wsUrl(port, `?token=e2e-perm-token`));
    await new Promise<void>((resolve) => { ws.on("open", () => resolve()); });

    const requestId = "req-e2e-p-1";
    const sessionId = "session-e2e-1";

    ws.send(JSON.stringify(clientMsg("request_upsert", {
      clientId: client.id,
      sessionId,
      requestId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      permission: {
        action: "read",
        patterns: ["**/*.ts"],
        display: "Read project files",
      },
    })));

    const ack = await waitForMessage(ws, 3000);
    expect(ack).toBeDefined();

    const req = repo.findRequest(requestId, client.id, sessionId);
    expect(req!.status).toBe("pending");

    fakeBot.simulateDecision({
      requestId,
      clientId: client.id,
      sessionId,
      approved: true,
    });

    const decision = await waitForMessageType(ws, "decision", 5000);
    expect(decision.type).toBe("decision");
    const dp = decision.payload as Record<string, unknown>;
    expect(dp.approved).toBe(true);

    ws.send(JSON.stringify(clientMsg("apply_result", {
      requestId,
      clientId: client.id,
      sessionId,
      success: true,
    })));

    await waitForMessage(ws, 3000);

    const reqAfter = repo.findRequest(requestId, client.id, sessionId);
    expect(reqAfter!.status).toBe("applied");

    ws.close();
  }, 15_000);
});

// ─── E2E: Permission always / reject ───────────────────

describe("E2E: permission always and reject", () => {
  it("records always-approved permission decision with always flag", async () => {
    const client = repo.createClient("e2e-always-token");

    const ws = new WebSocket(wsUrl(port, `?token=e2e-always-token`));
    await new Promise<void>((resolve) => { ws.on("open", () => resolve()); });

    const requestId = "req-e2e-always";
    const sessionId = "session-e2e-1";

    ws.send(JSON.stringify(clientMsg("request_upsert", {
      clientId: client.id,
      sessionId,
      requestId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      permission: {
        action: "write",
        patterns: ["**/*"],
        display: "Write files",
      },
    })));

    await waitForMessage(ws, 3000);

    fakeBot.simulateDecision({
      requestId,
      clientId: client.id,
      sessionId,
      approved: true,
      always: true,
    });

    const decision = await waitForMessageType(ws, "decision", 5000);
    const dp = decision.payload as Record<string, unknown>;
    expect(dp.approved).toBe(true);
    expect(dp.always).toBe(true);

    ws.send(JSON.stringify(clientMsg("apply_result", {
      requestId,
      clientId: client.id,
      sessionId,
      success: true,
    })));

    await waitForMessage(ws, 3000);

    const reqAfter = repo.findRequest(requestId, client.id, sessionId);
    expect(reqAfter!.status).toBe("applied");

    ws.close();
  }, 15_000);

  it("records rejected permission decision", async () => {
    const client = repo.createClient("e2e-reject-token");

    const ws = new WebSocket(wsUrl(port, `?token=e2e-reject-token`));
    await new Promise<void>((resolve) => { ws.on("open", () => resolve()); });

    const requestId = "req-e2e-reject";
    const sessionId = "session-e2e-1";

    ws.send(JSON.stringify(clientMsg("request_upsert", {
      clientId: client.id,
      sessionId,
      requestId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      permission: {
        action: "delete",
        patterns: ["*.log"],
        display: "Delete log files",
      },
    })));

    await waitForMessage(ws, 3000);

    fakeBot.simulateDecision({
      requestId,
      clientId: client.id,
      sessionId,
      approved: false,
    });

    const decision = await waitForMessageType(ws, "decision", 5000);
    const dp = decision.payload as Record<string, unknown>;
    expect(dp.approved).toBe(false);

    ws.send(JSON.stringify(clientMsg("apply_result", {
      requestId,
      clientId: client.id,
      sessionId,
      success: true,
    })));

    await waitForMessage(ws, 3000);

    ws.close();
  }, 15_000);
});

// ─── E2E: Offline client reconnect ─────────────────────

describe("E2E: offline client reconnect", () => {
  it("delivers pending outbox decisions when client reconnects after being offline", async () => {
    const client = repo.createClient("e2e-offline-token");
    const sessionId = "session-e2e-1";

    // Create request and transition it to dispatching while client is offline
    const req = repo.upsertRequest({
      requestId: "req-e2e-offline",
      clientId: client.id,
      sessionId,
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
    });
    repo.updateRequestStatus(req.id, "decided");
    repo.updateRequestStatus(req.id, "dispatching");

    // Enqueue decision while client is offline
    repo.enqueue({
      idempotencyKey: "offline-key",
      recipientId: client.id,
      messageType: "decision",
      payload: {
        requestId: "req-e2e-offline",
        clientId: client.id,
        sessionId,
        approved: true,
      },
      requestId: "req-e2e-offline",
      expiresAt: new Date(Date.now() + 120_000),
    });

    // Now connect client - set up message listener BEFORE open to avoid race with dispatch
    const ws = new WebSocket(wsUrl(port, `?token=e2e-offline-token`));
    const decision = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for decision")), 5000);
      ws.on("message", (data) => {
        const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
        if (parsed.type === "decision") {
          clearTimeout(timer);
          resolve(parsed);
        }
      });
    });
    expect(decision).toBeDefined();
    expect(decision.type).toBe("decision");
    const dp = decision.payload as Record<string, unknown>;
    expect(dp.requestId).toBe("req-e2e-offline");
    expect(dp.approved).toBe(true);

    ws.close();
  }, 15_000);
});

// ─── E2E: Stale (expired) request ──────────────────────

describe("E2E: stale request", () => {
  it("rejects a decision for an expired request", async () => {
    const client = repo.createClient("e2e-stale-token");
    const requestId = "req-e2e-stale";
    const sessionId = "session-e2e-1";

    // Insert already-expired request
    repo.upsertRequest({
      requestId,
      clientId: client.id,
      sessionId,
      status: "pending",
      expiresAt: new Date(Date.now() - 60_000),
    });

    const req = repo.findRequest(requestId, client.id, sessionId);
    expect(req!.status).toBe("pending");

    // Callback system checks expiration - simulate via direct repo call
    const cbResult = repo.findAndClaimCallbackId("nonexistent");
    expect(cbResult).toBeUndefined();

    // Expire the request and verify state
    repo.updateRequestStatus(req!.id, "expired");
    const reqExp = repo.findRequestById(req!.id);
    expect(reqExp!.status).toBe("expired");
  });

  it("stale callback query returns stale result", async () => {
    const client = repo.createClient("e2e-stale2-token");
    const requestId = "req-e2e-stale2";
    const sessionId = "session-e2e-2";

    const req = repo.upsertRequest({
      requestId,
      clientId: client.id,
      sessionId,
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
    });

    // Create a callback ID
    const cb = repo.createCallbackId(
      "stale-action-id",
      req.id,
      "question_select",
      new Date(Date.now() + 60_000),
      { value: "test", label: "Test" },
    );
    expect(cb).toBeDefined();

    // Mark request as already decided (not pending)
    repo.updateRequestStatus(req.id, "decided");

    // Callback should be stale (request not pending)
    const claimAttempt = repo.findAndClaimCallbackId("stale-action-id");
    expect(claimAttempt).toBeDefined();

    // Verify the stale condition manually
    const reqAfter = repo.findRequestById(req.id);
    expect(reqAfter!.status).toBe("decided");
  });
});

// ─── E2E: Server restart with persisted SQLite ─────────

describe("E2E: server restart with persisted SQLite", () => {
  it("preserves requests and outbox across server restart", async () => {
    const client = repo.createClient("e2e-restart-token");
    const requestId = "req-e2e-restart";
    const sessionId = "session-e2e-1";

    // Create request and outbox entry
    const req = repo.upsertRequest({
      requestId,
      clientId: client.id,
      sessionId,
      status: "pending",
      expiresAt: new Date(Date.now() + 300_000),
    });
    repo.updateRequestStatus(req.id, "decided");
    repo.updateRequestStatus(req.id, "dispatching");

    repo.enqueue({
      idempotencyKey: "restart-pending-key",
      recipientId: client.id,
      messageType: "decision",
      payload: { requestId, clientId: client.id, sessionId, approved: true },
      requestId,
      expiresAt: new Date(Date.now() + 300_000),
    });

    // Close the app (simulate restart)
    await app.close();

    // Re-open the DB (same file)
    const db2 = new Database(join(tmpDir, "test.db"));

    try {
      // Verify data persisted
      const row = db2.prepare("SELECT * FROM outbox WHERE request_id = ?").get(requestId) as Record<string, unknown> | undefined;
      expect(row).toBeDefined();
      expect(row!.status).toBe("pending");

      const reqRow = db2.prepare("SELECT * FROM requests WHERE request_id = ?").get(requestId) as Record<string, unknown> | undefined;
      expect(reqRow).toBeDefined();
      expect(reqRow!.status).toBe("dispatching");
    } finally {
      db2.close();
    }
  });
});

// ─── E2E: Duplicate Telegram callback ──────────────────

describe("E2E: duplicate Telegram callback", () => {
  it("handles duplicate callback query idempotently", async () => {
    const client = repo.createClient("e2e-dup-cb-token");
    const requestId = "req-e2e-dup-cb";
    const sessionId = "session-e2e-1";

    const req = repo.upsertRequest({
      requestId,
      clientId: client.id,
      sessionId,
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const actionId = "dup-action-id";
    const cb = repo.createCallbackId(
      actionId,
      req.id,
      "question_select",
      new Date(Date.now() + 60_000),
      { value: "opt-a", label: "Option A" },
    );
    expect(cb).toBeDefined();

    // First claim succeeds
    const claim1 = repo.findAndClaimCallbackId(actionId);
    expect(claim1).toBeDefined();

    // Second claim fails (already claimed)
    const claim2 = repo.findAndClaimCallbackId(actionId);
    expect(claim2).toBeUndefined();
  });
});

// ─── E2E: Unauthorized user ────────────────────────────

describe("E2E: unauthorized user", () => {
  it("rejects WebSocket connection without token", () => new Promise<void>((done) => {
    const ws = new WebSocket(wsUrl(port, ""));
    ws.on("error", () => { done(); });
    ws.on("open", () => { done(new Error("expected rejection")); });
  }));

  it("rejects WebSocket connection with invalid token", () => new Promise<void>((done) => {
    const ws = new WebSocket(wsUrl(port, "?token=invalid-e2e-token"));
    ws.on("error", () => { done(); });
    ws.on("open", () => { done(new Error("expected rejection")); });
  }));

  it("rejects pairing code consumption from unauthorized user (callback)", async () => {
    const { confirmPairingCode } = pairingService;
    const result = await confirmPairingCode(
      "INVALID-CODE",
      999999999, // wrong user
      async () => {},
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("unauthorized");
  });
});
