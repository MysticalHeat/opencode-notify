import { GrammyError } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import type { Repository, RequestRow } from "../db/repository.js";
import { renderPermissionKeyboard, renderQuestionKeyboard } from "./render.js";

interface NoticeApi {
  sendMessage(chatId: number, text: string, options: { parse_mode: "HTML"; reply_markup: InlineKeyboardMarkup }): Promise<{ message_id: number }>;
  editMessageText(chatId: number, messageId: number, text: string): Promise<unknown>;
}

export function createNoticeService(repo: Repository, api: NoticeApi, chatId: number) {
  async function cancelRequest(id: string): Promise<void> {
    if (repo.findRequestById(id)?.status !== "cancelled") return;
    const messageId = repo.findTelegramNotice(id);
    if (messageId === undefined) return;
    try {
      await api.editMessageText(chatId, messageId, "This request was cancelled.");
    } catch {
      // The request is already non-actionable; a repeated cancellation can retry the edit.
    }
  }

  async function postRequest(row: RequestRow): Promise<{ messageId: number } | undefined> {
    if (!row.payloadJson || !row.payloadType || !repo.claimTelegramNotice(row.id)) return undefined;
    let rendered: { text: string; markup: InlineKeyboardMarkup };
    try {
      const current = repo.findRequestById(row.id);
      if (!current || current.status !== "pending" || !current.payloadJson || !current.payloadType || new Date(current.expiresAt).getTime() <= Date.now()) {
        repo.releaseTelegramNotice(row.id);
        return undefined;
      }
      row = current;
      const expiresAt = new Date(current.expiresAt);
      if (current.payloadType === "permission") {
        rendered = renderPermissionKeyboard(repo, row.id, JSON.parse(current.payloadJson), expiresAt);
      } else {
        rendered = renderQuestionKeyboard(repo, row.id, JSON.parse(current.payloadJson), expiresAt);
      }
      // Cancellation or a decision in another process may have raced rendering.
      const latest = repo.findRequestById(row.id);
      if (!latest || latest.status !== "pending" || new Date(latest.expiresAt).getTime() <= Date.now()) {
        repo.releaseTelegramNotice(row.id);
        return undefined;
      }
    } catch {
      repo.releaseTelegramNotice(row.id);
      return undefined;
    }

    let sent: { message_id: number };
    try {
      sent = await api.sendMessage(chatId, rendered.text, { parse_mode: "HTML", reply_markup: rendered.markup });
    } catch (error) {
      // A client-side API rejection confirms failure. Server and network errors
      // may have occurred after acceptance, so retrying could create a duplicate.
      if (error instanceof GrammyError && error.error_code >= 400 && error.error_code < 500) {
        repo.releaseTelegramNotice(row.id);
      }
      return undefined;
    }
    repo.saveTelegramNotice(row.id, sent.message_id);
    await cancelRequest(row.id);
    return { messageId: sent.message_id };
  }

  return { postRequest, cancelRequest };
}
