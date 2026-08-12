import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import WebSocket from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../src/db/migrate.js";
import { openDatabase } from "../src/db/database.js";
import { createRepository, type Repository } from "../src/db/repository.js";
import { createPairingService, type PairingService } from "../src/pairing/service.js";
import type { AppConfig } from "../src/app.js";
import type { FastifyInstance } from "fastify";

// ─── Helpers ──────────────────────────────────────────────

function wsUrl(port: number, query: string): string {
  return `ws://127.0.0.1:${port}/v1/ws${query}`;
}

async function connectWaitMessage(
  ws: WebSocket,
  timeoutMs = 5000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for message")), timeoutMs);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

async function sendAndWait(
  ws: WebSocket,
  msg: unknown,
  timeoutMs = 5000,
): Promise<unknown> {
  const result = connectWaitMessage(ws, timeoutMs);
  ws.send(JSON.stringify(msg));
  return result;
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

let tmpDir: string;
let db: Database.Database;
let repo: Repository;
let pairingService: PairingService;
let app: FastifyInstance;
let port: number;
let cleanupFn: () => void;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "relay-test-"));
  const dbPath = join(tmpDir, "test.db");
  const result = openDatabase(dbPath);
  db = result.db;
  runMigrations(db);
  repo = createRepository(db);
  pairingService = createPairingService(repo, 123456789);

  const config: AppConfig = {
    tokenAuth: true,
    heartbeatIntervalMs: 1_000,
    heartbeatTimeoutMs: 3_000,
    maxMessageBytes: 65_536,
    loggingLevel: "info",
  };

  const { createApp } = await import("../src/app.js");
  app = await createApp({ db, repo, config, pairingService, ready: { dbReady: true, botReady: true } });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address()! as { port: number };
  port = addr.port;

  cleanupFn = () => {
    app.close();
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
    DELETE FROM requests;
    DELETE FROM pairing_codes;
    DELETE FROM pairings;
    DELETE FROM clients;
  `);
});

// ─── RED: Tests will fail because app.ts / relay modules don't exist yet ───

describe("WebSocket gateway authentication", () => {
  it("rejects relay messages sent before authentication", () => new Promise<void>((done) => {
    const ws = new WebSocket(wsUrl(port, ""));
    ws.on("close", () => { done(); });
    ws.on("open", () => ws.send(JSON.stringify(clientMsg("hello", { clientId: "client", sessionId: "session" }))));
  }));

  it("rejects connection with invalid token", () => new Promise<void>((done) => {
    const ws = new WebSocket(wsUrl(port, "?token=invalid-token"));
    ws.on("error", () => { done(); });
    ws.on("open", () => { done(new Error("expected connection to be rejected")); });
  }));

  it("rejects connection with revoked token", () => new Promise<void>((done) => {
    const client = repo.createClient("revoked-token");
    repo.revokeClient(client.id);
    const ws = new WebSocket(wsUrl(port, `?token=revoked-token`));
    ws.on("error", () => { done(); });
    ws.on("open", () => { done(new Error("expected connection to be rejected")); });
  }));

  it("accepts connection with valid token", () => new Promise<void>((done) => {
    const _client = repo.createClient("valid-token");
    const ws = new WebSocket(wsUrl(port, `?token=valid-token`));
    ws.on("open", () => {
      ws.close();
      done();
    });
    ws.on("error", (err) => { done(new Error(`unexpected error: ${err.message}`)); });
  }));

  it("authenticates an in-band token without exposing it in the URL", async () => {
    const client = repo.createClient("in-band-token");
    const ws = new WebSocket(wsUrl(port, ""));
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    const response = connectWaitMessage(ws);
    ws.send(JSON.stringify(clientMsg("auth", { token: "in-band-token" })));
    const message = await response as { type: string; payload: { clientId: string; token?: string } };
    expect(message.type).toBe("pairing");
    expect(message.payload.clientId).toBe(client.id);
    expect(message.payload.token).toBeUndefined();
    ws.close();
  });
});

describe("WebSocket pairing", () => {
  it("client receives token via pairing message over WebSocket", async () => {
    const { code } = pairingService.generatePairingCode(60_000);

    const ws = new WebSocket(wsUrl(port, ""));
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    ws.send(JSON.stringify(clientMsg("auth", { pairingCode: code })));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(repo.listAllClients()).toHaveLength(0);
    const response = connectWaitMessage(ws, 5000);
    await pairingService.confirmPairingForConnectedClient(code, 123456789);
    const msg = await response;
    expect(msg).toBeDefined();
    const parsed = msg as Record<string, unknown>;
    expect(parsed.type).toBe("pairing");
    const payload = parsed.payload as Record<string, unknown>;
    expect(payload.clientId).toBeDefined();
    expect(payload.sessionId).toBeDefined();
    expect(payload.paired).toBe(true);
    expect(payload.token).toBeDefined();
    expect((payload.token as string).length).toBeGreaterThanOrEqual(32);
    ws.close();
  });

  it("rejects duplicate pairing code use", async () => {
    const { code } = pairingService.generatePairingCode(60_000);

    const ws1 = new WebSocket(wsUrl(port, ""));
    await new Promise<void>((resolve) => ws1.on("open", () => resolve()));
    ws1.send(JSON.stringify(clientMsg("auth", { pairingCode: code })));
    await new Promise((resolve) => setTimeout(resolve, 25));
    const firstResponse = connectWaitMessage(ws1, 5000);
    await pairingService.confirmPairingForConnectedClient(code, 123456789);
    const msg1 = await firstResponse;
    expect((msg1 as Record<string, unknown>).type).toBe("pairing");
    ws1.close();

    // Wait for ws1 to fully close before reusing code
    await new Promise<void>((resolve) => {
      ws1.on("close", () => resolve());
      if (ws1.readyState === WebSocket.CLOSED) resolve();
    });

    // Second connection should be rejected (server closes with 4003)
    await new Promise<void>((resolve, reject) => {
      const ws2 = new WebSocket(wsUrl(port, ""));
      const timer = setTimeout(() => reject(new Error("timeout waiting for rejection")), 5000);
      ws2.on("open", () => ws2.send(JSON.stringify(clientMsg("auth", { pairingCode: code }))));
      ws2.on("close", (code) => {
        clearTimeout(timer);
        if (code === 4003) resolve();
        else reject(new Error(`expected close code 4003, got ${code}`));
      });
      ws2.on("error", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  });

  it("plaintext token is never exposed in error responses during pairing", async () => {
    // Authenticate with a non-existent pairing code.
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl(port, ""));
      const timer = setTimeout(() => reject(new Error("timeout")), 5000);
      ws.on("error", () => { clearTimeout(timer); resolve(); });
      ws.on("open", () => {
        ws.send(JSON.stringify(clientMsg("auth", { pairingCode: "INVALID" })));
        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          expect(msg.type).toBe("error");
          const payload = msg.payload as Record<string, unknown>;
          // Payload must not contain token-like base64url strings (no hyphens)
          expect(JSON.stringify(payload)).not.toMatch(/[A-Za-z0-9_]{32,}/);
        });
        ws.on("close", () => { clearTimeout(timer); resolve(); });
      });
    });
  });
});

describe("WebSocket connection management", () => {
  it("replaces duplicate connection for same client ID", async () => {
    const _client = repo.createClient("dup-token");

    const ws1 = new WebSocket(wsUrl(port, `?token=dup-token`));
    await new Promise<void>((resolve) => { ws1.on("open", () => resolve()); });

    // Connect second client with same token
    const ws2 = new WebSocket(wsUrl(port, `?token=dup-token`));
    await new Promise<void>((resolve) => { ws2.on("open", () => resolve()); });

    // First connection should be closed (replaced)
    await new Promise<void>((resolve) => {
      if (ws1.readyState === WebSocket.CLOSED) { resolve(); return; }
      ws1.on("close", () => resolve());
    });

    expect(ws1.readyState).toBe(WebSocket.CLOSED);
    expect(ws2.readyState).toBe(WebSocket.OPEN);

    ws2.close();
  });

  it("cleans up connection on heartbeat timeout", async () => {
    const _client = repo.createClient("heartbeat-token");
    const ws = new WebSocket(wsUrl(port, `?token=heartbeat-token`));
    await new Promise<void>((resolve) => { ws.on("open", () => resolve()); });

    // Do NOT send any heartbeat — the server should close the connection after timeout
    // with heartbeatIntervalMs=1s and heartbeatTimeoutMs=3s, it should close within ~4s
    await new Promise<void>((resolve) => {
      ws.on("close", () => resolve());
    });

    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});

describe("request ingestion", () => {
  it("accepts request_upsert from authenticated client", async () => {
    const client = repo.createClient("upsert-token");
    const ws = new WebSocket(wsUrl(port, `?token=upsert-token`));
    await new Promise<void>((resolve) => { ws.on("open", () => resolve()); });

    const msg = await sendAndWait(ws, clientMsg("request_upsert", {
      clientId: client.id,
      sessionId: "session-1",
      requestId: "req-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      question: {
        text: "Are you sure?",
        options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
      },
    }), 3000);

    // Server should acknowledge (heartbeat or ack message)
    expect(msg).toBeDefined();
    ws.close();
  });

  it("rejects request_upsert from unauthenticated client", () => new Promise<void>((done) => {
    const ws = new WebSocket(wsUrl(port, ""));
    ws.on("error", () => { done(); });
    ws.on("open", () => { done(new Error("expected unauthenticated connection to be rejected")); });
  }));
});

describe("request cancellation", () => {
  it("cancels a pending request", async () => {
    const client = repo.createClient("cancel-token");
    const ws = new WebSocket(wsUrl(port, `?token=cancel-token`));
    await new Promise<void>((resolve) => { ws.on("open", () => resolve()); });

    // Upsert
    await sendAndWait(ws, clientMsg("request_upsert", {
      clientId: client.id,
      sessionId: "session-1",
      requestId: "req-cancel",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      question: {
        text: "Cancel me?",
        options: [{ label: "Y", value: "y" }],
      },
    }), 3000);

    // Cancel
    const msg = await sendAndWait(ws, clientMsg("request_cancel", {
      clientId: client.id,
      sessionId: "session-1",
      requestId: "req-cancel",
    }), 3000);

    expect(msg).toBeDefined();

    // Verify request status is cancelled
    const req = repo.findRequest("req-cancel", client.id, "session-1");
    expect(req!.status).toBe("cancelled");

    ws.close();
  });
});

describe("offline outbox and reconnect delivery", () => {
  it("queues decision to offline client in outbox", async () => {
    const client = repo.createClient("offline-token");
    const expiresAt = new Date(Date.now() + 60_000);
    const req = repo.upsertRequest({
      requestId: "req-offline",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
    });

    // Transition to decided (simulates a decision being made while client is offline)
    const decided = repo.updateRequestStatus(req.id, "decided");
    expect(decided.status).toBe("decided");

    // Transition to dispatching
    repo.updateRequestStatus(req.id, "dispatching");

    // Enqueue to outbox (simulates dispatch service)
    const outboxEntry = repo.enqueue({
      idempotencyKey: "offline-key",
      recipientId: client.id,
      messageType: "decision",
      payload: {
        requestId: "req-offline",
        clientId: client.id,
        sessionId: "session-1",
        approved: true,
      },
      requestId: "req-offline",
      expiresAt,
    });
    expect(outboxEntry.status).toBe("pending");
  });

  it("delivers pending outbox messages on reconnect", async () => {
    const client = repo.createClient("reconnect-token");
    const expiresAt = new Date(Date.now() + 60_000);

    // Create request
    const req = repo.upsertRequest({
      requestId: "req-reconnect",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
    });
    repo.updateRequestStatus(req.id, "decided");
    repo.updateRequestStatus(req.id, "dispatching");

    // Enqueue decision message
    repo.enqueue({
      idempotencyKey: "reconnect-key",
      recipientId: client.id,
      messageType: "decision",
      payload: {
        requestId: "req-reconnect",
        clientId: client.id,
        sessionId: "session-1",
        approved: true,
      },
      requestId: "req-reconnect",
      expiresAt,
    });

    // Connect client — register listener before connection opens
    const ws = new WebSocket(wsUrl(port, `?token=reconnect-token`));

    // Collect the first non-heartbeat message
    const msg = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for message")), 5000);
      ws.on("message", (data) => {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === "decision") {
          clearTimeout(timer);
          resolve(parsed);
        }
      });
      ws.on("open", () => {});
    });

    expect(msg).toBeDefined();
    const parsed = msg as Record<string, unknown>;
    expect(parsed.type).toBe("decision");

    ws.close();
  });

  it("acknowledges apply_result removes from outbox", async () => {
    const client = repo.createClient("apply-token");
    const expiresAt = new Date(Date.now() + 60_000);

    const req = repo.upsertRequest({
      requestId: "req-apply",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
    });
    repo.updateRequestStatus(req.id, "decided");
    repo.updateRequestStatus(req.id, "dispatching");

    // Enqueue decision
    repo.enqueue({
      idempotencyKey: "apply-key",
      recipientId: client.id,
      messageType: "decision",
      payload: {
        requestId: "req-apply",
        clientId: client.id,
        sessionId: "session-1",
        approved: true,
      },
      requestId: "req-apply",
      expiresAt,
    });

    const ws = new WebSocket(wsUrl(port, `?token=apply-token`));

    // Drain initial messages (heartbeats and outbox) by collecting until we see nothing for a bit
    let consumeResolve: (() => void) | undefined;
    ws.on("message", (data) => {
      const parsed = JSON.parse(data.toString());
      if (parsed.type === "decision") {
        // Consumed the decision, now send apply_result
        consumeResolve?.();
      }
    });

    // Wait for the decision to arrive
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for decision")), 5000);
      consumeResolve = () => { clearTimeout(timer); resolve(); };
    });

    // Now send apply_result
    const ackPromise = connectWaitMessage(ws, 3000);
    ws.send(JSON.stringify(clientMsg("apply_result", {
      requestId: "req-apply",
      clientId: client.id,
      sessionId: "session-1",
      success: true,
    })));

    const ack = await ackPromise;
    expect(ack).toBeDefined();

    // Outbox should now be empty (or at least the decision message is gone)
    const pending = repo.dequeuePending(10);
    expect(pending.length).toBe(0);

    ws.close();
  });

  it("handles duplicate apply_result idempotently", async () => {
    const client = repo.createClient("dupapply-token");
    const expiresAt = new Date(Date.now() + 60_000);

    const req = repo.upsertRequest({
      requestId: "req-dupapply",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
    });
    repo.updateRequestStatus(req.id, "decided");
    repo.updateRequestStatus(req.id, "dispatching");

    repo.enqueue({
      idempotencyKey: "dupapply-key",
      recipientId: client.id,
      messageType: "decision",
      payload: {
        requestId: "req-dupapply",
        clientId: client.id,
        sessionId: "session-1",
        approved: true,
      },
      requestId: "req-dupapply",
      expiresAt,
    });

    const ws = new WebSocket(wsUrl(port, `?token=dupapply-token`));

    // Drain until we see the decision message
    let consumeResolve: (() => void) | undefined;
    ws.on("message", (data) => {
      const parsed = JSON.parse(data.toString());
      if (parsed.type === "decision") {
        consumeResolve?.();
      }
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 5000);
      consumeResolve = () => { clearTimeout(timer); resolve(); };
    });

    // First apply_result
    await sendAndWait(ws, clientMsg("apply_result", {
      requestId: "req-dupapply",
      clientId: client.id,
      sessionId: "session-1",
      success: true,
    }), 3000);

    // Second apply_result should not error (idempotent)
    const result = await sendAndWait(ws, clientMsg("apply_result", {
      requestId: "req-dupapply",
      clientId: client.id,
      sessionId: "session-1",
      success: true,
    }), 3000);

    expect(result).toBeDefined();
    ws.close();
  });
});

describe("message size bounding", () => {
  it("rejects oversized messages", async () => {
    const client = repo.createClient("size-token");
    const ws = new WebSocket(wsUrl(port, `?token=size-token`));
    await new Promise<void>((resolve) => { ws.on("open", () => resolve()); });

    // Send a large payload
    const huge = clientMsg("request_upsert", {
      clientId: client.id,
      sessionId: "session-1",
      requestId: "req-big",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      question: {
        text: "x".repeat(1_000_000), // 1MB text
        options: [{ label: "Yes", value: "yes" }],
      },
    });

    ws.send(JSON.stringify(huge));

    // Server should close the connection or send an error
    await new Promise<void>((resolve) => {
      ws.on("close", () => resolve());
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "error") {
          resolve();
        }
      });
    });

    ws.close();
  });
});

describe("health endpoints", () => {
  it("/health/live returns 200 when running", async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/health/live`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("ok");
  });

  it("/health/ready returns 200 when DB migrations succeeded", async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/health/ready`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("ok");
  });
});

describe("dispatch expiry and terminal guards (H1)", () => {
  it("does not dispatch expired outbox messages", async () => {
    const client = repo.createClient("expired-outbox-token");
    const pastExpiry = new Date(Date.now() - 60_000);

    repo.enqueue({
      idempotencyKey: "expired-outbox-key",
      recipientId: client.id,
      messageType: "decision",
      payload: {
        requestId: "req-expired",
        clientId: client.id,
        sessionId: "session-1",
        approved: true,
      },
      requestId: "req-expired",
      expiresAt: pastExpiry,
    });

    const ws = new WebSocket(wsUrl(port, `?token=expired-outbox-token`));

    const received = await new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => resolve(null), 2000);
      ws.on("message", (data) => {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === "decision") {
          clearTimeout(timer);
          resolve(parsed);
        }
      });
    });

    expect(received).toBeNull();
    ws.close();
  });

  it("does not dispatch for terminal request status", async () => {
    const client = repo.createClient("terminal-dispatch-token");
    const expiresAt = new Date(Date.now() + 60_000);

    const req = repo.upsertRequest({
      requestId: "req-terminal",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
    });
    repo.updateRequestStatus(req.id, "decided");
    repo.updateRequestStatus(req.id, "dispatching");

    repo.enqueue({
      idempotencyKey: "terminal-outbox-key",
      recipientId: client.id,
      messageType: "decision",
      payload: {
        requestId: "req-terminal",
        clientId: client.id,
        sessionId: "session-1",
        approved: true,
      },
      requestId: "req-terminal",
      expiresAt,
    });

    repo.updateRequestStatus(req.id, "applied");

    const ws = new WebSocket(wsUrl(port, `?token=terminal-dispatch-token`));

    const received = await new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => resolve(null), 2000);
      ws.on("message", (data) => {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === "decision") {
          clearTimeout(timer);
          resolve(parsed);
        }
      });
    });

    expect(received).toBeNull();
    ws.close();
  });

  it("still dispatches nonterminal decision on reconnect", async () => {
    const client = repo.createClient("valid-dispatch-token");
    const expiresAt = new Date(Date.now() + 60_000);

    const req = repo.upsertRequest({
      requestId: "req-valid",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
    });
    repo.updateRequestStatus(req.id, "decided");
    repo.updateRequestStatus(req.id, "dispatching");

    repo.enqueue({
      idempotencyKey: "valid-outbox-key",
      recipientId: client.id,
      messageType: "decision",
      payload: {
        requestId: "req-valid",
        clientId: client.id,
        sessionId: "session-1",
        approved: true,
      },
      requestId: "req-valid",
      expiresAt,
    });

    const ws = new WebSocket(wsUrl(port, `?token=valid-dispatch-token`));

    const msg = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 3000);
      ws.on("message", (data) => {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === "decision") {
          clearTimeout(timer);
          resolve(parsed);
        }
      });
    });

    expect(msg).toBeDefined();
    const parsed = msg as Record<string, unknown>;
    expect(parsed.type).toBe("decision");
    ws.close();
  });
});

describe("readiness reflects real state (M3)", () => {
  it("/health/ready returns 503 when DB is not ready", async () => {
    const { setDbReady, setBotReady } = await import("../src/health.js");
    setDbReady(false);
    setBotReady(false);

    const resp = await fetch(`http://127.0.0.1:${port}/health/ready`);
    expect(resp.status).toBe(503);
    const body = await resp.json();
    expect(body.status).toBe("error");
    expect(body.dbReady).toBe(false);

    setDbReady(true);
    setBotReady(true);
  });

  it("/health/ready returns 503 when bot is not ready", async () => {
    const { setDbReady, setBotReady } = await import("../src/health.js");
    setDbReady(true);
    setBotReady(false);

    const resp = await fetch(`http://127.0.0.1:${port}/health/ready`);
    expect(resp.status).toBe(503);
    const body = await resp.json();
    expect(body.status).toBe("error");
    expect(body.botReady).toBe(false);

    setDbReady(true);
    setBotReady(true);
  });
});

describe("apply_result idempotency (H2)", () => {
  it("handleApplyAcknowledgement cleans up pending outbox without dead code path", async () => {
    const client = repo.createClient("cleanup-ack-token");
    const expiresAt = new Date(Date.now() + 60_000);

    const req = repo.upsertRequest({
      requestId: "req-cleanup",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
    });
    repo.updateRequestStatus(req.id, "decided");
    repo.updateRequestStatus(req.id, "dispatching");

    repo.enqueue({
      idempotencyKey: "cleanup-ack-key-1",
      recipientId: client.id,
      messageType: "decision",
      payload: {
        requestId: "req-cleanup",
        clientId: client.id,
        sessionId: "session-1",
        approved: true,
      },
      requestId: "req-cleanup",
      expiresAt,
    });

    repo.enqueue({
      idempotencyKey: "cleanup-ack-key-2",
      recipientId: client.id,
      messageType: "decision",
      payload: {
        requestId: "req-cleanup",
        clientId: client.id,
        sessionId: "session-1",
        approved: false,
      },
      requestId: "req-cleanup",
      expiresAt,
    });

    const ws = new WebSocket(wsUrl(port, `?token=cleanup-ack-token`));

    let _decisionCount = 0;
    let ackSent = false;
    ws.on("message", (raw) => {
      const parsed = JSON.parse(raw.toString());
      if (parsed.type === "decision" && !ackSent) {
        _decisionCount++;
        ackSent = true;
        ws.send(JSON.stringify(clientMsg("apply_result", {
          requestId: "req-cleanup",
          clientId: client.id,
          sessionId: "session-1",
          success: true,
        })));
      }
    });

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 3000);
      ws.on("close", () => { clearTimeout(timer); resolve(); });
      ws.on("open", () => {});
    });

    // Both outbox entries should be cleaned up
    const pending = repo.dequeuePending(10);
    const stillPending = pending.filter(
      (p) => p.recipientId === client.id,
    );
    expect(stillPending.length).toBe(0);
    ws.close();
  });
});

describe("WSS max frame payload (M1)", () => {
  it("rejects oversized frame before JSON parsing at configured limit", async () => {
    const client = repo.createClient("frame-limit-token");
    const ws = new WebSocket(wsUrl(port, `?token=frame-limit-token`));
    await new Promise<void>((resolve) => { ws.on("open", () => resolve()); });

    const huge = clientMsg("request_upsert", {
      clientId: client.id,
      sessionId: "session-1",
      requestId: "req-framelimit",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      question: {
        text: "x".repeat(200_000),
        options: [{ label: "Yes", value: "yes" }],
      },
    });

    ws.send(JSON.stringify(huge));

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 5000);
      ws.on("close", () => { clearTimeout(timer); resolve(); });
      ws.on("message", () => {});
    });

    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});
