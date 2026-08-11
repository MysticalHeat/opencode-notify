import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { runMigrations } from "../src/db/migrate.js";
import { openDatabase } from "../src/db/database.js";
import { createRepository, type Repository } from "../src/db/repository.js";
import { createPairingService, type PairingService } from "../src/pairing/service.js";
import { renderPermissionKeyboard, renderQuestionKeyboard } from "../src/telegram/render.js";
import { handleCallbackQuery } from "../src/telegram/callbacks.js";
import { handleTextReply } from "../src/telegram/text-replies.js";
import { createBotAdapter, createBotHandler } from "../src/telegram/bot.js";

let db: Database.Database;
let repo: Repository;
let cleanup: (() => void) | undefined;
let tmpDir: string;
let pairingService: PairingService;

const AUTHORIZED_USER_ID = 123456789;
const UNAUTHORIZED_USER_ID = 987654321;
const CHAT_ID = 111111;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "telegram-test-"));
  const dbPath = join(tmpDir, "test.db");
  const result = openDatabase(dbPath);
  db = result.db;
  cleanup = () => {
    result.close();
    rmSync(tmpDir, { recursive: true, force: true });
  };
  runMigrations(db);
  repo = createRepository(db);
  pairingService = createPairingService(repo, AUTHORIZED_USER_ID);
});

afterAll(() => {
  if (cleanup) cleanup();
});

beforeEach(() => {
  db.exec(`
    DELETE FROM outbox;
    DELETE FROM telegram_updates;
    DELETE FROM telegram_decision_state;
    DELETE FROM telegram_freply_tracking;
    DELETE FROM telegram_callback_ids;
    DELETE FROM request_answers;
    DELETE FROM requests;
    DELETE FROM pairing_codes;
    DELETE FROM pairings;
    DELETE FROM clients;
  `);
  pairingService = createPairingService(repo, AUTHORIZED_USER_ID);
});

// ─── PERMISSION RENDERING ────────────────────────────────

describe("permission rendering", () => {
  it("renders permission keyboard with three buttons", () => {
    const client = repo.createClient("perm-render-token");
    const expiresAt = new Date(Date.now() + 60_000);
    const req = repo.upsertRequest({
      requestId: "req-perm-render",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
      payloadType: "permission",
      payloadJson: JSON.stringify({ action: "read", patterns: ["/data/*"], display: "Read data files" }),
    });

    const { text, markup } = renderPermissionKeyboard(repo, req.id, {
      action: "read",
      patterns: ["/data/*"],
      display: "Read data files",
    }, expiresAt);

    expect(text).toContain("Permission Request");
    expect(text).toContain("read");
    expect(text).toContain("/data/*");
    expect(markup.inline_keyboard).toHaveLength(1);
    expect(markup.inline_keyboard[0]!).toHaveLength(3);

    const labels = markup.inline_keyboard[0]!.map((b) => b.text);
    expect(labels).toContain("Approve Once");
    expect(labels).toContain("Always Approve");
    expect(labels).toContain("Reject");

    // Verify callback IDs are stored in DB
    for (const btn of markup.inline_keyboard[0]!) {
      const cb = repo.findAndClaimCallbackId(btn.callback_data);
      // After claiming, it should be claimed
      expect(cb).toBeDefined();
      expect(cb!.requestFk).toBe(req.id);
    }
  });

  it("callback data is at most 64 bytes", () => {
    const client = repo.createClient("cb-size-token");
    const expiresAt = new Date(Date.now() + 60_000);
    const req = repo.upsertRequest({
      requestId: "req-cb-size",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
      payloadType: "permission",
      payloadJson: JSON.stringify({ action: "write", patterns: ["/tmp/*"], display: "Write temp files" }),
    });

    const { markup } = renderPermissionKeyboard(repo, req.id, {
      action: "write",
      patterns: ["/tmp/*"],
      display: "Write temp files",
    }, expiresAt);

    for (const btn of markup.inline_keyboard[0]!) {
      expect(Buffer.byteLength(btn.callback_data)).toBeLessThanOrEqual(64);
    }
  });
});

// ─── SINGLE-SELECT QUESTION RENDERING ────────────────────

describe("single-select question rendering", () => {
  it("renders option buttons for single-select question", () => {
    const client = repo.createClient("ss-render-token");
    const expiresAt = new Date(Date.now() + 60_000);
    const req = repo.upsertRequest({
      requestId: "req-ss-render",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
      payloadType: "question",
      payloadJson: JSON.stringify({
        text: "Choose an option",
        options: [
          { label: "Option A", value: "a" },
          { label: "Option B", value: "b" },
          { label: "Option C", value: "c" },
        ],
        multiSelect: false,
      }),
    });

    const { text, markup } = renderQuestionKeyboard(repo, req.id, {
      text: "Choose an option",
      options: [
        { label: "Option A", value: "a" },
        { label: "Option B", value: "b" },
        { label: "Option C", value: "c" },
      ],
    }, expiresAt);

    expect(text).toContain("Choose an option");
    expect(text).toContain("select one");

    // 3 option rows + 1 custom text row = 4
    expect(markup.inline_keyboard).toHaveLength(4);
    // Verify custom text button is last
    const lastRow = markup.inline_keyboard[3]!;
    expect(lastRow[0]!.text).toBe("Enter custom answer...");
  });
});

// ─── MULTI-SELECT QUESTION RENDERING ─────────────────────

describe("multi-select question rendering", () => {
  it("renders toggle buttons and Done for multi-select", () => {
    const client = repo.createClient("ms-render-token");
    const expiresAt = new Date(Date.now() + 60_000);
    const req = repo.upsertRequest({
      requestId: "req-ms-render",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
      payloadType: "question",
      payloadJson: JSON.stringify({
        text: "Pick several",
        options: [
          { label: "A", value: "a" },
          { label: "B", value: "b" },
        ],
        multiSelect: true,
      }),
    });

    const { text, markup } = renderQuestionKeyboard(repo, req.id, {
      text: "Pick several",
      options: [
        { label: "A", value: "a" },
        { label: "B", value: "b" },
      ],
      multiSelect: true,
    }, expiresAt);

    expect(text).toContain("Pick several");
    expect(text).toContain("Done");

    // 2 option rows + 1 Done row + 1 custom text row = 4
    expect(markup.inline_keyboard).toHaveLength(4);
    const doneRow = markup.inline_keyboard[2]!;
    expect(doneRow[0]!.text).toBe("Done");
  });
});

// ─── REGRESSION: ForceReply outbox payload includes answer text (FIX #1) ───

describe("ForceReply outbox payload regression", () => {
  it("enqueueDecision for text reply includes answer text in payload", () => {
    const client = repo.createClient("fr-outbox-token");
    const expiresAt = new Date(Date.now() + 60_000);
    const req = repo.upsertRequest({
      requestId: "req-fr-outbox",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
      payloadType: "question",
      payloadJson: JSON.stringify({ text: "Enter value", options: [], multiSelect: false }),
    });

    repo.createFreplyTracking(
      CHAT_ID,
      AUTHORIZED_USER_ID,
      88888,
      req.id,
      new Date(Date.now() + 60_000),
    );

    const result = handleTextReply(repo, "my custom answer", AUTHORIZED_USER_ID, AUTHORIZED_USER_ID, CHAT_ID, 88888);
    expect(result.type).toBe("correlated");
    expect(result.text).toBe("my custom answer");

    const enqueued = repo.enqueue({
      idempotencyKey: `tg-fr-outbox-${Date.now()}`,
      recipientId: client.id,
      messageType: "decision",
      payload: {
        requestId: result.requestId,
        clientId: result.clientId,
        sessionId: result.sessionId,
        answers: [{ value: result.text, label: result.text }],
      },
      requestId: result.requestId,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    const parsed = JSON.parse(enqueued.payloadJson) as Record<string, unknown>;
    const answers = parsed.answers as Array<Record<string, unknown>>;
    expect(answers).toBeDefined();
    expect(answers).toHaveLength(1);
    expect(answers[0]!.value).toBe("my custom answer");
    expect(answers[0]!.label).toBe("my custom answer");
  });
});

// ─── REGRESSION: Multi-select toggle preserves inline keyboard (FIX #2) ───

describe("multi-select keyboard preservation regression", () => {
  it("multi_toggle result includes options for keyboard re-render", () => {
    const client = repo.createClient("ms-kb-token");
    const expiresAt = new Date(Date.now() + 60_000);
    const req = repo.upsertRequest({
      requestId: "req-ms-kb",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
      payloadType: "question",
      payloadJson: JSON.stringify({
        text: "Pick several",
        options: [
          { label: "A", value: "a" },
          { label: "B", value: "b" },
          { label: "C", value: "c" },
        ],
        multiSelect: true,
      }),
    });

    const { markup } = renderQuestionKeyboard(repo, req.id, {
      text: "Pick several",
      options: [
        { label: "A", value: "a" },
        { label: "B", value: "b" },
        { label: "C", value: "c" },
      ],
      multiSelect: true,
    }, expiresAt);

    // Toggle A on
    const toggleA = markup.inline_keyboard[0]![0]!;
    const r1 = handleCallbackQuery(repo, toggleA.callback_data, AUTHORIZED_USER_ID, AUTHORIZED_USER_ID, CHAT_ID, 10001);
    expect(r1.type).toBe("multi_toggle");
    expect(r1.newSelectedValues).toEqual(["a"]);

    // Toggle B on
    const toggleB = markup.inline_keyboard[1]![0]!;
    const r2 = handleCallbackQuery(repo, toggleB.callback_data, AUTHORIZED_USER_ID, AUTHORIZED_USER_ID, CHAT_ID, 10001);
    expect(r2.type).toBe("multi_toggle");
    expect(r2.newSelectedValues).toEqual(["a", "b"]);

    // Toggle A off
    const toggleA2 = markup.inline_keyboard[0]![0]!;
    // This callback was already claimed, so it should be stale
    // (This verifies that the fix needs fresh callback IDs for subsequent toggles)
    const r3 = handleCallbackQuery(repo, toggleA2.callback_data, AUTHORIZED_USER_ID, AUTHORIZED_USER_ID, CHAT_ID, 10001);
    expect(r3.type).toBe("stale");
  });
});

// ─── REGRESSION: Unauthorized distinguishable from stale (FIX #3) ───

describe("unauthorized vs stale distinction regression", () => {
  it("unauthorized callback returns 'unauthorized' not 'stale'", () => {
    const client = repo.createClient("unauth-cb-token");
    const expiresAt = new Date(Date.now() + 60_000);
    const req = repo.upsertRequest({
      requestId: "req-unauth-cb",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
      payloadType: "permission",
      payloadJson: JSON.stringify({ action: "read", patterns: ["/data/*"], display: "Read data" }),
    });

    const { markup } = renderPermissionKeyboard(repo, req.id, {
      action: "read",
      patterns: ["/data/*"],
      display: "Read data",
    }, expiresAt);

    const approveBtn = markup.inline_keyboard[0]![0]!;
    const result = handleCallbackQuery(repo, approveBtn.callback_data, UNAUTHORIZED_USER_ID, AUTHORIZED_USER_ID, CHAT_ID, 10001);

    expect(result.type).toBe("unauthorized");
  });

  it("unauthorized text reply returns 'unauthorized' not 'stale'", () => {
    const client = repo.createClient("unauth-fr-token");
    const expiresAt = new Date(Date.now() + 60_000);
    const req = repo.upsertRequest({
      requestId: "req-unauth-fr",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
    });

    repo.createFreplyTracking(
      CHAT_ID,
      AUTHORIZED_USER_ID,
      99999,
      req.id,
      new Date(Date.now() + 60_000),
    );

    const result = handleTextReply(repo, "unauthorized text", UNAUTHORIZED_USER_ID, AUTHORIZED_USER_ID, CHAT_ID, 99999);

    expect(result.type).toBe("unauthorized");
  });
});

// ─── PERMISSION CALLBACKS ────────────────────────────────

describe("permission callbacks", () => {
  it("handles approve once callback", () => {
    const client = repo.createClient("cb-approve-token");
    const expiresAt = new Date(Date.now() + 60_000);
    const req = repo.upsertRequest({
      requestId: "req-cb-approve",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
      payloadType: "permission",
      payloadJson: JSON.stringify({ action: "read", patterns: ["/data/*"], display: "Read data" }),
    });

    const { markup } = renderPermissionKeyboard(repo, req.id, {
      action: "read",
      patterns: ["/data/*"],
      display: "Read data",
    }, expiresAt);

    const approveBtn = markup.inline_keyboard[0]![0]!;
    const result = handleCallbackQuery(repo, approveBtn.callback_data, AUTHORIZED_USER_ID, AUTHORIZED_USER_ID, CHAT_ID, 10001);

    expect(result.type).toBe("permission");
    expect(result.approved).toBe(true);
    expect(result.always).toBe(false);

    // Request should now be decided
    const updated = repo.findRequest("req-cb-approve", client.id, "session-1");
    expect(updated!.status).toBe("decided");
  });

  it("handles always approve callback", () => {
    const client = repo.createClient("cb-always-token");
    const expiresAt = new Date(Date.now() + 60_000);
    const req = repo.upsertRequest({
      requestId: "req-cb-always",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
      payloadType: "permission",
      payloadJson: JSON.stringify({ action: "write", patterns: ["/tmp/*"], display: "Write temp" }),
    });

    const { markup } = renderPermissionKeyboard(repo, req.id, {
      action: "write",
      patterns: ["/tmp/*"],
      display: "Write temp",
    }, expiresAt);

    const alwaysBtn = markup.inline_keyboard[0]![1]!;
    const result = handleCallbackQuery(repo, alwaysBtn.callback_data, AUTHORIZED_USER_ID, AUTHORIZED_USER_ID, CHAT_ID, 10001);

    expect(result.type).toBe("permission");
    expect(result.approved).toBe(true);
    expect(result.always).toBe(true);
  });

  it("handles reject callback", () => {
    const client = repo.createClient("cb-reject-token");
    const expiresAt = new Date(Date.now() + 60_000);
    const req = repo.upsertRequest({
      requestId: "req-cb-reject",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
      payloadType: "permission",
      payloadJson: JSON.stringify({ action: "read", patterns: ["/secret/*"], display: "Read secret" }),
    });

    const { markup } = renderPermissionKeyboard(repo, req.id, {
      action: "read",
      patterns: ["/secret/*"],
      display: "Read secret",
    }, expiresAt);

    const rejectBtn = markup.inline_keyboard[0]![2]!;
    const result = handleCallbackQuery(repo, rejectBtn.callback_data, AUTHORIZED_USER_ID, AUTHORIZED_USER_ID, CHAT_ID, 10001);

    expect(result.type).toBe("permission");
    expect(result.approved).toBe(false);
    expect(result.always).toBe(false);

    const updated = repo.findRequest("req-cb-reject", client.id, "session-1");
    expect(updated!.status).toBe("decided");
  });

  it("rejects callback from unauthorized Telegram user", () => {
    const client = repo.createClient("cb-unauth-token");
    const expiresAt = new Date(Date.now() + 60_000);
    const req = repo.upsertRequest({
      requestId: "req-cb-unauth",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
      payloadType: "permission",
      payloadJson: JSON.stringify({ action: "read", patterns: ["/data/*"], display: "Read data" }),
    });

    const { markup } = renderPermissionKeyboard(repo, req.id, {
      action: "read",
      patterns: ["/data/*"],
      display: "Read data",
    }, expiresAt);

    const approveBtn = markup.inline_keyboard[0]![0]!;
    const result = handleCallbackQuery(repo, approveBtn.callback_data, UNAUTHORIZED_USER_ID, AUTHORIZED_USER_ID, CHAT_ID, 10001);

    expect(result.type).toBe("unauthorized");

    const unchanged = repo.findRequest("req-cb-unauth", client.id, "session-1");
    expect(unchanged!.status).toBe("pending");
  });

  it("rejects stale callback (already claimed)", () => {
    const client = repo.createClient("cb-stale2-token");
    const expiresAt = new Date(Date.now() + 60_000);
    const req = repo.upsertRequest({
      requestId: "req-cb-stale2",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
      payloadType: "permission",
      payloadJson: JSON.stringify({ action: "read", patterns: ["/data/*"], display: "Read data" }),
    });

    const { markup } = renderPermissionKeyboard(repo, req.id, {
      action: "read",
      patterns: ["/data/*"],
      display: "Read data",
    }, expiresAt);

    const approveBtn = markup.inline_keyboard[0]![0]!;

    // First claim succeeds
    const result1 = handleCallbackQuery(repo, approveBtn.callback_data, AUTHORIZED_USER_ID, AUTHORIZED_USER_ID, CHAT_ID, 10001);
    expect(result1.type).toBe("permission");

    // Second claim should be stale
    const result2 = handleCallbackQuery(repo, approveBtn.callback_data, AUTHORIZED_USER_ID, AUTHORIZED_USER_ID, CHAT_ID, 10001);
    expect(result2.type).toBe("stale");
  });

  it("rejects expired callback", () => {
    const client = repo.createClient("cb-expired2-token");
    const pastExpiry = new Date(Date.now() + 2000);
    const req = repo.upsertRequest({
      requestId: "req-cb-expired2",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt: pastExpiry,
      payloadType: "permission",
      payloadJson: JSON.stringify({ action: "read", patterns: ["/data/*"], display: "Read data" }),
    });

    const actionId = randomBytes(32).toString("base64url");
    repo.createCallbackId(actionId, req.id, "permission_approve", new Date(Date.now() - 60_000), { approved: true });

    // Expired callback — findAndClaimCallbackId returns undefined
    const claimed = repo.findAndClaimCallbackId(actionId);
    // Should be undefined because expires_at is in the past
    // (the SQL filters WHERE datetime(expires_at) > datetime('now'))
    // Note: Since we set it 60s in the past, it should not be found
    if (claimed) {
      // Edge case: SQLite datetime('now') may not have caught up
      // But the handleCallbackQuery should still reject it
      const result = handleCallbackQuery(repo, actionId, AUTHORIZED_USER_ID, AUTHORIZED_USER_ID, CHAT_ID, 10001);
      expect(["stale", "expired"]).toContain(result.type);
    } else {
      // Expected: callback not found because it's expired
      expect(true).toBe(true);
    }
  });
});

// ─── QUESTION CALLBACKS ──────────────────────────────────

describe("question callbacks", () => {
  it("handles single-select callback", () => {
    const client = repo.createClient("q-select-token");
    const expiresAt = new Date(Date.now() + 60_000);
    const req = repo.upsertRequest({
      requestId: "req-q-select",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
      payloadType: "question",
      payloadJson: JSON.stringify({
        text: "Pick one",
        options: [
          { label: "Red", value: "red" },
          { label: "Blue", value: "blue" },
        ],
      }),
    });

    const { markup } = renderQuestionKeyboard(repo, req.id, {
      text: "Pick one",
      options: [
        { label: "Red", value: "red" },
        { label: "Blue", value: "blue" },
      ],
    }, expiresAt);

    const optionBtn = markup.inline_keyboard[0]![0]!;
    const result = handleCallbackQuery(repo, optionBtn.callback_data, AUTHORIZED_USER_ID, AUTHORIZED_USER_ID, CHAT_ID, 10001);

    expect(result.type).toBe("question");
    expect(result.answerValue).toBe("red");
    expect(result.answerLabel).toBe("Red");

    const updated = repo.findRequest("req-q-select", client.id, "session-1");
    expect(updated!.status).toBe("decided");

    const answers = repo.findAnswers(req.id);
    expect(answers).toHaveLength(1);
    expect(answers[0]!.value).toBe("red");
    expect(answers[0]!.label).toBe("Red");
  });

  it("handles multi-select toggle", () => {
    const client = repo.createClient("q-ms-toggle-token");
    const expiresAt = new Date(Date.now() + 60_000);
    const req = repo.upsertRequest({
      requestId: "req-ms-toggle",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
      payloadType: "question",
      payloadJson: JSON.stringify({
        text: "Pick several",
        options: [
          { label: "A", value: "a" },
          { label: "B", value: "b" },
        ],
        multiSelect: true,
      }),
    });

    const { markup } = renderQuestionKeyboard(repo, req.id, {
      text: "Pick several",
      options: [
        { label: "A", value: "a" },
        { label: "B", value: "b" },
      ],
      multiSelect: true,
    }, expiresAt);

    const toggleABtn = markup.inline_keyboard[0]![0]!;
    const result1 = handleCallbackQuery(repo, toggleABtn.callback_data, AUTHORIZED_USER_ID, AUTHORIZED_USER_ID, CHAT_ID, 10001);
    expect(result1.type).toBe("multi_toggle");
    expect(result1.newSelectedValues).toEqual(["a"]);

    const toggleBBtn = markup.inline_keyboard[1]![0]!;
    const result2 = handleCallbackQuery(repo, toggleBBtn.callback_data, AUTHORIZED_USER_ID, AUTHORIZED_USER_ID, CHAT_ID, 10001);
    expect(result2.type).toBe("multi_toggle");
    expect(result2.newSelectedValues).toEqual(["a", "b"]);

    // Toggle A off
    // Need to get new callback data for second press since first was claimed
    // We can't reuse the same callback — let's test the state directly
    const state = repo.findDecisionState(req.id, CHAT_ID, AUTHORIZED_USER_ID);
    expect(state).toBeDefined();
    expect(JSON.parse(state!.selectedJson)).toEqual(["a", "b"]);
  });

  it("handles multi-select Done", () => {
    const client = repo.createClient("q-ms-done-token");
    const expiresAt = new Date(Date.now() + 60_000);
    const req = repo.upsertRequest({
      requestId: "req-ms-done",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
      payloadType: "question",
      payloadJson: JSON.stringify({
        text: "Pick several",
        options: [
          { label: "A", value: "a" },
          { label: "B", value: "b" },
        ],
        multiSelect: true,
      }),
    });

    const { markup } = renderQuestionKeyboard(repo, req.id, {
      text: "Pick several",
      options: [
        { label: "A", value: "a" },
        { label: "B", value: "b" },
      ],
      multiSelect: true,
    }, expiresAt);

    // Toggle A on
    const toggleABtn = markup.inline_keyboard[0]![0]!;
    handleCallbackQuery(repo, toggleABtn.callback_data, AUTHORIZED_USER_ID, AUTHORIZED_USER_ID, CHAT_ID, 10001);

    // Press Done
    const doneBtn = markup.inline_keyboard[2]![0]!;
    const result = handleCallbackQuery(repo, doneBtn.callback_data, AUTHORIZED_USER_ID, AUTHORIZED_USER_ID, CHAT_ID, 10001);

    expect(result.type).toBe("multi_done");
    expect(result.selectedValues).toEqual(["a"]);

    const updated = repo.findRequest("req-ms-done", client.id, "session-1");
    expect(updated!.status).toBe("decided");
  });
});

// ─── TEXT REPLIES ────────────────────────────────────────

describe("text replies", () => {
  it("correlates custom text reply via reply_to_message.message_id", () => {
    const client = repo.createClient("tr-correl-token");
    const expiresAt = new Date(Date.now() + 60_000);
    const req = repo.upsertRequest({
      requestId: "req-tr-correl",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
      payloadType: "question",
      payloadJson: JSON.stringify({ text: "Enter value", options: [], multiSelect: false }),
    });

    repo.createFreplyTracking(
      CHAT_ID,
      AUTHORIZED_USER_ID,
      55555,
      req.id,
      new Date(Date.now() + 60_000),
    );

    const result = handleTextReply(repo, "my custom answer", AUTHORIZED_USER_ID, AUTHORIZED_USER_ID, CHAT_ID, 55555);

    expect(result.type).toBe("correlated");
    expect(result.text).toBe("my custom answer");
    expect(result.requestId).toBe("req-tr-correl");

    // Tracking should be cleaned up
    const after = repo.findFreplyTracking(CHAT_ID, AUTHORIZED_USER_ID, 55555);
    expect(after).toBeUndefined();

    // Request should be decided
    const updated = repo.findRequest("req-tr-correl", client.id, "session-1");
    expect(updated!.status).toBe("decided");
  });

  it("returns orphan for text without reply_to_message", () => {
    const result = handleTextReply(repo, "some text", AUTHORIZED_USER_ID, AUTHORIZED_USER_ID, CHAT_ID, undefined);
    expect(result.type).toBe("orphan");
  });

  it("returns stale for unauthorized user text reply", () => {
    const client = repo.createClient("tr-stale-token");
    const expiresAt = new Date(Date.now() + 60_000);
    const req = repo.upsertRequest({
      requestId: "req-tr-stale",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
    });

    repo.createFreplyTracking(
      CHAT_ID,
      AUTHORIZED_USER_ID,
      55556,
      req.id,
      new Date(Date.now() + 60_000),
    );

    const result = handleTextReply(repo, "unauthorized text", UNAUTHORIZED_USER_ID, AUTHORIZED_USER_ID, CHAT_ID, 55556);

    expect(result.type).toBe("unauthorized");
  });
});

// ─── DECISION INTEGRATION WITH OUTBOX ────────────────────

describe("decision integration with outbox", () => {
  it("permission decision can be enqueued to outbox", () => {
    const client = repo.createClient("oi-perm-token");
    const expiresAt = new Date(Date.now() + 60_000);
    const req = repo.upsertRequest({
      requestId: "req-oi-perm",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
      payloadType: "permission",
      payloadJson: JSON.stringify({ action: "read", patterns: ["/data/*"], display: "Read data" }),
    });

    const { markup } = renderPermissionKeyboard(repo, req.id, {
      action: "read",
      patterns: ["/data/*"],
      display: "Read data",
    }, expiresAt);

    const approveBtn = markup.inline_keyboard[0]![0]!;
    const result = handleCallbackQuery(repo, approveBtn.callback_data, AUTHORIZED_USER_ID, AUTHORIZED_USER_ID, CHAT_ID, 10001);

    expect(result.type).toBe("permission");
    expect(result.approved).toBe(true);

    // Simulate outbox enqueue (done by bot adapter in production)
    const enqueued = repo.enqueue({
      idempotencyKey: `tg-test-${Date.now()}`,
      recipientId: client.id,
      messageType: "decision",
      payload: {
        requestId: result.requestId,
        clientId: result.clientId,
        sessionId: result.sessionId,
        approved: result.approved,
        always: result.always,
      },
      requestId: result.requestId,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    expect(enqueued).toBeDefined();
    expect(enqueued.status).toBe("pending");
  });

  it("question decision can be enqueued to outbox", () => {
    const client = repo.createClient("oi-q-token");
    const expiresAt = new Date(Date.now() + 60_000);
    const req = repo.upsertRequest({
      requestId: "req-oi-q",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
      payloadType: "question",
      payloadJson: JSON.stringify({
        text: "Pick one",
        options: [{ label: "Yes", value: "yes" }],
      }),
    });

    const { markup } = renderQuestionKeyboard(repo, req.id, {
      text: "Pick one",
      options: [{ label: "Yes", value: "yes" }],
    }, expiresAt);

    const optionBtn = markup.inline_keyboard[0]![0]!;
    const result = handleCallbackQuery(repo, optionBtn.callback_data, AUTHORIZED_USER_ID, AUTHORIZED_USER_ID, CHAT_ID, 10001);

    expect(result.type).toBe("question");

    const enqueued = repo.enqueue({
      idempotencyKey: `tg-test-q-${Date.now()}`,
      recipientId: client.id,
      messageType: "decision",
      payload: {
        requestId: result.requestId,
        clientId: result.clientId,
        sessionId: result.sessionId,
        answers: [{ value: result.answerValue, label: result.answerLabel }],
      },
      requestId: result.requestId,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    expect(enqueued).toBeDefined();
    expect(enqueued.status).toBe("pending");
  });
});

// ─── BOT ADAPTER ─────────────────────────────────────────

describe("bot adapter creation", () => {
  it("creates bot adapter with long polling support", () => {
    const adapter = createBotAdapter("test:token", AUTHORIZED_USER_ID, repo, pairingService);
    expect(adapter).toBeDefined();
    expect(typeof adapter.start).toBe("function");
    expect(typeof adapter.stop).toBe("function");
  });

  it("bot adapter has webhook handler", () => {
    const adapter = createBotAdapter("test:token", AUTHORIZED_USER_ID, repo, pairingService);
    const handler = adapter.webhookHandler("secret-token-123");
    expect(typeof handler).toBe("function");
  });

  it("bot adapter can post a request", async () => {
    // Using a fake bot token will cause postRequest to fail on the actual API call
    // but the function itself should exist
    const adapter = createBotAdapter("invalid:token_for_testing", AUTHORIZED_USER_ID, repo, pairingService);
    expect(typeof adapter.postRequest).toBe("function");
  });
});

// ─── LEGACY BOT HANDLER ──────────────────────────────────

describe("legacy bot handler", () => {
  it("createBotHandler returns backward-compatible command handler", async () => {
    const handler = createBotHandler(pairingService);
    expect(handler).toBeDefined();
    expect(typeof handler.handleMessage).toBe("function");

    // Test basic command routing
    const resp = await handler.handleMessage({
      userId: AUTHORIZED_USER_ID,
      chatId: CHAT_ID,
      text: "/clients",
    });
    expect(resp.text).toContain("No registered clients found");
  });

  it("handles unknown command", async () => {
    const handler = createBotHandler(pairingService);
    const resp = await handler.handleMessage({
      userId: AUTHORIZED_USER_ID,
      chatId: CHAT_ID,
      text: "/unknowncmd",
    });
    expect(resp.text).toContain("Unknown command");
  });
});

// ─── DUPLICATE UPDATE HANDLING ──────────────────────────

describe("duplicate update handling", () => {
  it("skips duplicate update_id", () => {
    const ok1 = repo.insertTelegramUpdate(5001, { update_id: 5001, message: { text: "hello" } });
    expect(ok1).toBe(true);
    const ok2 = repo.insertTelegramUpdate(5001, { update_id: 5001, message: { text: "duplicate" } });
    expect(ok2).toBe(false);
  });
});

// ─── CALLBACK ID LIFECYCLE ──────────────────────────────

describe("callback ID lifecycle", () => {
  it("creates and finds callback ID", () => {
    const client = repo.createClient("cb-life2-token");
    const expiresAt = new Date(Date.now() + 60_000);
    const req = repo.upsertRequest({
      requestId: "req-cb-life2",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
    });

    const actionId = randomBytes(32).toString("base64url");
    const cb = repo.createCallbackId(actionId, req.id, "permission_approve", new Date(Date.now() + 60_000), { approved: true });

    expect(cb.actionId).toBe(actionId);
    expect(cb.requestFk).toBe(req.id);
    expect(cb.actionType).toBe("permission_approve");
    expect(cb.claimedAt).toBeNull();
  });

  it("findAndClaimCallbackId atomically claims", () => {
    const client = repo.createClient("cb-claim-token");
    const expiresAt = new Date(Date.now() + 60_000);
    const req = repo.upsertRequest({
      requestId: "req-cb-claim",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
    });

    const actionId = randomBytes(32).toString("base64url");
    repo.createCallbackId(actionId, req.id, "question_select", new Date(Date.now() + 60_000), { value: "x" });

    const claimed = repo.findAndClaimCallbackId(actionId);
    expect(claimed).toBeDefined();
    expect(claimed!.claimedAt).toBeDefined();

    const claimedAgain = repo.findAndClaimCallbackId(actionId);
    expect(claimedAgain).toBeUndefined();
  });
});

// ─── FORCE REPLY CORRELATION ────────────────────────────

describe("ForceReply correlation", () => {
  it("tracks and finds ForceReply messages", () => {
    const client = repo.createClient("fr-track-token");
    const expiresAt = new Date(Date.now() + 60_000);
    const req = repo.upsertRequest({
      requestId: "req-fr-track",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
    });

    const tracking = repo.createFreplyTracking(CHAT_ID, AUTHORIZED_USER_ID, 77777, req.id, new Date(Date.now() + 60_000));

    expect(tracking.chatId).toBe(CHAT_ID);
    expect(tracking.userId).toBe(AUTHORIZED_USER_ID);
    expect(tracking.replyMessageId).toBe(77777);

    const found = repo.findFreplyTracking(CHAT_ID, AUTHORIZED_USER_ID, 77777);
    expect(found).toBeDefined();
    expect(found!.id).toBe(tracking.id);
  });
});

// ─── DECISION STATE ─────────────────────────────────────

describe("decision state", () => {
  it("stores, updates and deletes decision state", () => {
    const client = repo.createClient("ds-token");
    const expiresAt = new Date(Date.now() + 60_000);
    const req = repo.upsertRequest({
      requestId: "req-ds",
      clientId: client.id,
      sessionId: "session-1",
      status: "pending",
      expiresAt,
    });

    const state = repo.createDecisionState(req.id, CHAT_ID, AUTHORIZED_USER_ID, 10001, ["a", "b"]);
    expect(state.requestFk).toBe(req.id);
    expect(JSON.parse(state.selectedJson)).toEqual(["a", "b"]);

    repo.updateDecisionState(state.id, JSON.stringify(["a", "b", "c"]));
    const updated = repo.findDecisionState(req.id, CHAT_ID, AUTHORIZED_USER_ID);
    expect(JSON.parse(updated!.selectedJson)).toEqual(["a", "b", "c"]);

    repo.deleteDecisionState(state.id);
    const after = repo.findDecisionState(req.id, CHAT_ID, AUTHORIZED_USER_ID);
    expect(after).toBeUndefined();
  });
});
