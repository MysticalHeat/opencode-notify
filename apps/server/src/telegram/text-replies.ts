import type { Repository } from "../db/repository.js";

export interface TextReplyResult {
  type: "correlated" | "orphan" | "unauthorized" | "stale";
  requestId?: string;
  clientId?: string;
  sessionId?: string;
  text?: string;
}

export function handleTextReply(
  repo: Repository,
  text: string | undefined,
  telegramUserId: number,
  authorizedUserId: number,
  chatId: number,
  replyToMessageId: number | undefined,
): TextReplyResult {
  if (telegramUserId !== authorizedUserId) {
    return { type: "unauthorized" };
  }

  if (!text || text.trim().length === 0) {
    return { type: "orphan" };
  }

  if (!replyToMessageId) {
    return { type: "orphan" };
  }

  const tracking = repo.findFreplyTracking(chatId, telegramUserId, replyToMessageId);
  if (!tracking) {
    return { type: "orphan" };
  }

  if (new Date(tracking.expiresAt).getTime() <= Date.now()) {
    repo.deleteFreplyTracking(tracking.id);
    return { type: "stale" };
  }

  const req = repo.findRequestById(tracking.requestFk);
  if (!req) {
    repo.deleteFreplyTracking(tracking.id);
    return { type: "stale" };
  }

  if (req.status !== "pending") {
    repo.deleteFreplyTracking(tracking.id);
    return { type: "stale" };
  }

  repo.updateRequestStatus(req.id, "decided");
  repo.saveAnswers(req.id, [{ value: text.trim(), label: text.trim() }]);
  repo.deleteFreplyTracking(tracking.id);

  return {
    type: "correlated",
    requestId: req.requestId,
    clientId: req.clientId,
    sessionId: req.sessionId,
    text: text.trim(),
  };
}
