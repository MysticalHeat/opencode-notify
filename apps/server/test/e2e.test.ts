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
import { handleCallbackQuery, type CallbackResult } from "../src/telegram/callbacks.js";
import { enqueueDecision } from "../src/telegram/bot.js";

const AUTHORIZED_USER_ID = 123456789;
const CHAT_ID = 111111;

// ─── Fake Bot ──────────────────────────────────────────

type SimCallbackParams = {
  actionType: "question_select" | "permission_approve" | "permission_always" | "permission_reject";
  requestId: string;
  clientId: string;
  sessionId: string;
  value?: string;
  label?: string;
};

class FakeBotAdapter implements BotAdapter {
  private requests: RequestRow[] = [];
  private repo: Repository;
  private messageIdCounter = 100;

  constructor(repo: Repository) {
    this.repo = repo;
  }

  async start(): Promise<void> {}

  webhookHandler(_expectedToken: string) {
    return async (_req: unknown, _res: unknown) => {};
  }

  async postRequest(requestRow: RequestRow): Promise<{ messageId: number } | undefined> {
    this.requests.push(requestRow);
    return { messageId: this.messageIdCounter++ };
  }

  get pendingCount(): number {
    return this.requests.length;
  }

  reset(): void {
    this.requests = [];
  }

  /**
   * Drive a callback through the SAME handleCallbackQuery + enqueueDecision
   * code path that production uses.  Creates a callback ID, claims it,
   * transitions the request, and enqueues the decision for outbox dispatch.
   */
  simulateCallback(params: SimCallbackParams): void {
    const req = this.repo.findRequestByRequestIdAndClient(params.requestId, params.clientId);
    if (!req) throw new Error(`Request not found: ${params.requestId}`);

    const actionId = `e2e-cb-${params.actionType}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const expiresAt = new Date(Date.now() + 60_000);

    const cbPayload: Record<string, unknown> = {};
    if (params.value) cbPayload.value = params.value;
    if (params.label) cbPayload.label = params.label;

    this.repo.createCallbackId(actionId, req.id, params.actionType, expiresAt, cbPayload);

    const result: CallbackResult = handleCallbackQuery(
      this.repo,
      actionId,
      AUTHORIZED_USER_ID,
      AUTHORIZED_USER_ID,
      CHAT_ID,
      this.messageIdCounter++,
    );

    if (result.type === "unauthorized" || result.type === "stale" || result.type === "expired") {
      throw new Error(`Callback failed: ${result.type}`);
    }

    enqueueDecision(this.repo, {
      requestId: result.requestId ?? params.requestId,
      clientId: result.clientId ?? params.clientId,
      sessionId: result.sessionId ?? params.sessionId,
      approved: result.approved,
      always: result.always,
      answerValue: result.answerValue,
      answerLabel: result.answerLabel,
      selectedValues: result.selectedValues,
    }, req);
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
    heartbeatIntervalMs: 300,
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
    botAdapter: fakeBot,
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
  fakeBot.reset();
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

    // Verify request persisted + bot received it
    const req = repo.findRequest(requestId, client.id, sessionId);
    expect(req).toBeDefined();
    expect(req!.status).toBe("pending");
    expect(fakeBot.pendingCount).toBe(1);

    // Drive the callback through handleCallbackQuery + enqueueDecision (production path)
    fakeBot.simulateCallback({
      actionType: "question_select",
      requestId,
      clientId: client.id,
      sessionId,
      value: "src-index",
      label: "src/index.ts",
    });

    // Dispatch service transitions decided→dispatching and delivers to WebSocket
    const decision = await waitForMessageType(ws, "decision", 5000);
    expect(decision).toBeDefined();
    expect(decision.type).toBe("decision");
    const dp = decision.payload as Record<string, unknown>;
    expect(dp.requestId).toBe(requestId);

    // Plugin sends apply_result → dispatching→applied
    ws.send(JSON.stringify(clientMsg("apply_result", {
      requestId,
      clientId: client.id,
      sessionId,
      success: true,
    })));

    const ack2 = await waitForMessage(ws, 3000);
    expect(ack2).toBeDefined();

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
    expect(fakeBot.pendingCount).toBe(1);

    fakeBot.simulateCallback({
      actionType: "permission_approve",
      requestId,
      clientId: client.id,
      sessionId,
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

    fakeBot.simulateCallback({
      actionType: "permission_always",
      requestId,
      clientId: client.id,
      sessionId,
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

    fakeBot.simulateCallback({
      actionType: "permission_reject",
      requestId,
      clientId: client.id,
      sessionId,
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

    // Create an already-decided+dispatching+enqueued request (simulated prior session)
    const req = repo.upsertRequest({
      requestId: "req-e2e-offline",
      clientId: client.id,
      sessionId,
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
    });
    repo.updateRequestStatus(req.id, "decided");
    repo.updateRequestStatus(req.id, "dispatching");

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

    // Connect client — dispatchPending on connect delivers the pending decision
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
  it("rejects a callback for an expired request via handleCallbackQuery", async () => {
    const client = repo.createClient("e2e-stale-token");
    const requestId = "req-e2e-stale";
    const sessionId = "session-e2e-1";

    // Insert already-expired request
    const req = repo.upsertRequest({
      requestId,
      clientId: client.id,
      sessionId,
      status: "pending",
      expiresAt: new Date(Date.now() - 60_000),
    });

    const actionId = "stale-expired-cb";
    const expiresAt = new Date(Date.now() + 60_000);
    repo.createCallbackId(actionId, req.id, "question_select", expiresAt, { value: "x", label: "X" });

    // handleCallbackQuery should detect the request expired via state machine
    const result = handleCallbackQuery(
      repo,
      actionId,
      AUTHORIZED_USER_ID,
      AUTHORIZED_USER_ID,
      CHAT_ID,
      200,
    );
    expect(result.type).toBe("expired");
  });

  it("stale callback for non-pending request returns stale via handleCallbackQuery", async () => {
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

    const actionId = "stale-nonpending-cb";
    repo.createCallbackId(actionId, req.id, "question_select", new Date(Date.now() + 60_000), { value: "test", label: "Test" });

    // Transition request away from pending before callback is processed
    repo.updateRequestStatus(req.id, "decided");

    // handleCallbackQuery should detect stale via state machine
    const result = handleCallbackQuery(
      repo,
      actionId,
      AUTHORIZED_USER_ID,
      AUTHORIZED_USER_ID,
      CHAT_ID,
      201,
    );
    expect(result.type).toBe("stale");
  });
});

// ─── E2E: Server restart with persisted SQLite ─────────

describe("E2E: server restart with persisted SQLite", () => {
  it("preserves requests and outbox across server restart", async () => {
    const client = repo.createClient("e2e-restart-token");
    const requestId = "req-e2e-restart";
    const sessionId = "session-e2e-1";

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
  it("handles duplicate callback query idempotently via handleCallbackQuery", async () => {
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

    const actionId = "dup-action-id-real";
    repo.createCallbackId(actionId, req.id, "question_select", new Date(Date.now() + 60_000), { value: "opt-a", label: "Option A" });

    // First callback succeeds through real handler
    const result1 = handleCallbackQuery(
      repo,
      actionId,
      AUTHORIZED_USER_ID,
      AUTHORIZED_USER_ID,
      CHAT_ID,
      300,
    );
    expect(result1.type).toBe("question");
    expect(result1.requestId).toBe(requestId);

    // Second callback with same actionId is stale (already claimed)
    const result2 = handleCallbackQuery(
      repo,
      actionId,
      AUTHORIZED_USER_ID,
      AUTHORIZED_USER_ID,
      CHAT_ID,
      301,
    );
    expect(result2.type).toBe("stale");
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
      999999999,
      async () => {},
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("unauthorized");
  });
});
