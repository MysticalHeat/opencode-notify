import Database from "better-sqlite3";
import { GrammyError } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRepository, type Repository } from "../src/db/repository.js";
import { runMigrations } from "../src/db/migrate.js";
import { createNoticeService } from "../src/telegram/notices.js";
import { handleCallbackQuery } from "../src/telegram/callbacks.js";
import { createGatewayHandler } from "../src/relay/gateway.js";
import { createConnectionRegistry } from "../src/relay/connections.js";
import { createDispatchService } from "../src/relay/dispatch.js";
import type { BotAdapter } from "../src/telegram/bot.js";

let db: Database.Database;
let repo: Repository;
let clientId: string;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  repo = createRepository(db);
  clientId = repo.createClient("token").id;
});
afterEach(() => db.close());

function upsert(requestId = "request", text = "Original") {
  return repo.upsertRequest({ requestId, clientId, sessionId: "session", status: "pending",
    expiresAt: new Date(Date.now() + 60_000), payloadType: "question",
    payloadJson: JSON.stringify({ text, options: [{ label: "Yes", value: "yes" }] }) });
}

describe("Telegram notices", () => {
  it("routes duplicate upserts and cancellation through the gateway to one notice", async () => {
    const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }), editMessageText: vi.fn().mockResolvedValue(true) };
    const notices = createNoticeService(repo, api, 123);
    const bot: BotAdapter = { ...notices, start: async () => {}, stop: async () => {}, webhookHandler: () => async () => {} };
    const registry = createConnectionRegistry(1000, 3000);
    const dispatch = createDispatchService(repo, registry, 1000);
    const handler = createGatewayHandler({ repo, registry, dispatch, botAdapter: bot,
      config: { maxMessageBytes: 65536, heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 3000 } });
    const listeners = new Map<string, (arg: unknown) => void>();
    handler({ send: vi.fn(), close: vi.fn(), on: (event, listener) => { listeners.set(event, listener); } }, { url: "/?token=token" });
    const payload = { clientId, sessionId: "session", requestId: "request", expiresAt: new Date(Date.now() + 60_000).toISOString(),
      question: { text: "Question", options: [{ label: "Yes", value: "yes" }] } };
    const send = (type: string, value: object) => listeners.get("message")!(JSON.stringify({ protocolVersion: 1, messageId: crypto.randomUUID(), sentAt: new Date().toISOString(), type, payload: value }));
    send("request_upsert", payload);
    send("request_upsert", payload);
    await vi.waitFor(() => expect(repo.findTelegramNotice(repo.findRequest("request", clientId, "session")!.id)).toBe(42));
    send("request_cancel", { clientId, sessionId: "session", requestId: "request" });
    await vi.waitFor(() => expect(api.editMessageText).toHaveBeenCalledWith(123, 42, expect.stringContaining("cancelled")));
    send("request_upsert", payload);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    listeners.get("close")!(undefined);
    registry.destroy();
  });

  it("claims across repository instances and suppresses concurrent and later upserts", async () => {
    let finish!: (value: { message_id: number }) => void;
    const api = { sendMessage: vi.fn(() => new Promise<{ message_id: number }>((resolve) => { finish = resolve; })), editMessageText: vi.fn() };
    const first = createNoticeService(repo, api, 123);
    const second = createNoticeService(createRepository(db), api, 123);
    const row = upsert();
    const sending = first.postRequest(row);
    const duplicate = upsert("request", "Changed");
    await second.postRequest(duplicate);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(JSON.parse(duplicate.payloadJson!).text).toBe("Original");
    finish({ message_id: 42 });
    await sending;
    await second.postRequest(upsert());
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(repo.findTelegramNotice(row.id)).toBe(42);
  });

  it("retries a confirmed Telegram rejection but not an ambiguous network failure", async () => {
    const rejection = new GrammyError("rejected", { ok: false, error_code: 429, description: "rate limited" }, "sendMessage", {});
    const api = { sendMessage: vi.fn().mockRejectedValueOnce(rejection).mockResolvedValueOnce({ message_id: 42 }), editMessageText: vi.fn() };
    const service = createNoticeService(repo, api, 123);
    const row = upsert();
    await service.postRequest(row);
    await service.postRequest(upsert());
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    const ambiguous = upsert("unknown");
    api.sendMessage.mockRejectedValueOnce(new Error("connection lost"));
    await service.postRequest(ambiguous);
    await service.postRequest(upsert("unknown"));
    expect(api.sendMessage).toHaveBeenCalledTimes(3);
    const serverError = upsert("server-error");
    api.sendMessage.mockRejectedValueOnce(new GrammyError("failed", { ok: false, error_code: 500, description: "server error" }, "sendMessage", {}));
    await service.postRequest(serverError);
    await service.postRequest(upsert("server-error"));
    expect(api.sendMessage).toHaveBeenCalledTimes(4);
  });

  it("releases the claim when reading or rendering fails before sending", async () => {
    const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }), editMessageText: vi.fn() };
    const service = createNoticeService(repo, api, 123);
    const row = upsert();
    const read = vi.spyOn(repo, "findRequestById").mockImplementationOnce(() => { throw new Error("read failed"); });
    await service.postRequest(row);
    expect(api.sendMessage).not.toHaveBeenCalled();
    read.mockRestore();

    const render = vi.spyOn(repo, "createCallbackId").mockImplementationOnce(() => { throw new Error("render failed"); });
    await service.postRequest(upsert());
    expect(api.sendMessage).not.toHaveBeenCalled();
    render.mockRestore();
    await service.postRequest(upsert());
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(repo.findTelegramNotice(row.id)).toBe(42);
  });

  it("does not resend after Telegram accepts a message but saving its ID fails", async () => {
    const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }), editMessageText: vi.fn() };
    const service = createNoticeService(repo, api, 123);
    const row = upsert();
    const save = vi.spyOn(repo, "saveTelegramNotice").mockImplementationOnce(() => { throw new Error("database unavailable"); });
    await expect(service.postRequest(row)).rejects.toThrow("database unavailable");
    save.mockRestore();
    await service.postRequest(upsert());
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not send when cancellation wins during rendering", async () => {
    const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }), editMessageText: vi.fn() };
    const service = createNoticeService(repo, api, 123);
    const row = upsert();
    const original = repo.createCallbackId.bind(repo);
    const render = vi.spyOn(repo, "createCallbackId").mockImplementation((...args) => {
      repo.cancelPendingRequest(row.id);
      return original(...args);
    });
    await service.postRequest(row);
    render.mockRestore();
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(repo.findRequestById(row.id)?.status).toBe("cancelled");
    expect(repo.claimTelegramNotice(row.id)).toBe(false);
  });

  it("resolves a notice cancelled during send and rejects its callback", async () => {
    let finish!: (value: { message_id: number }) => void;
    const api = { sendMessage: vi.fn(() => new Promise<{ message_id: number }>((resolve) => { finish = resolve; })), editMessageText: vi.fn().mockResolvedValue(true) };
    const service = createNoticeService(repo, api, 123);
    const row = upsert();
    const sending = service.postRequest(row);
    const callback = api.sendMessage.mock.calls[0]![2].reply_markup.inline_keyboard[0]![0]!.callback_data!;
    expect(repo.cancelPendingRequest(row.id)).toBe(true);
    await service.cancelRequest(row.id);
    finish({ message_id: 42 });
    await sending;
    expect(api.editMessageText).toHaveBeenCalledWith(123, 42, expect.stringContaining("cancelled"));
    expect(handleCallbackQuery(repo, callback, 123, 123, 123, 42).type).toBe("stale");
    await service.postRequest(upsert());
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("retries a failed cancellation edit on a repeated cancellation", async () => {
    const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }), editMessageText: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(true) };
    const service = createNoticeService(repo, api, 123);
    const row = upsert();
    await service.postRequest(row);
    repo.cancelPendingRequest(row.id);
    await service.cancelRequest(row.id);
    await service.cancelRequest(row.id);
    expect(api.editMessageText).toHaveBeenCalledTimes(2);
  });

  it.each(["decided", "dispatching"] as const)("does not overwrite or cancel a %s request", async (status) => {
    const row = upsert();
    repo.updateRequestStatus(row.id, "decided");
    if (status === "dispatching") repo.updateRequestStatus(row.id, status);
    const updated = upsert("request", "Changed");
    expect(updated.status).toBe(status);
    expect(updated.payloadJson).toBe(row.payloadJson);
    expect(repo.cancelPendingRequest(row.id)).toBe(false);
    const api = { sendMessage: vi.fn(), editMessageText: vi.fn() };
    const service = createNoticeService(repo, api, 123);
    await service.postRequest(updated);
    await service.cancelRequest(row.id);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.editMessageText).not.toHaveBeenCalled();
  });
});
