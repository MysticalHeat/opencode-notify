import type { Repository } from "../db/repository.js";
import { transitionRequest } from "@repo/core";

export interface CallbackResult {
  type: "permission" | "question" | "multi_toggle" | "multi_done" | "custom_text" | "unauthorized" | "stale" | "expired";
  requestId?: string;
  clientId?: string;
  sessionId?: string;
  approved?: boolean;
  always?: boolean;
  answerValue?: string;
  answerLabel?: string;
  selectedValues?: string[];
  newSelectedValues?: string[];
  messageId?: number;
}

export function handleCallbackQuery(
  repo: Repository,
  actionId: string,
  telegramUserId: number,
  authorizedUserId: number,
  chatId: number,
  messageId: number,
): CallbackResult {
  if (telegramUserId !== authorizedUserId) {
    return { type: "unauthorized" };
  }

  const cb = repo.findAndClaimCallbackId(actionId);
  if (!cb) {
    return { type: "stale" };
  }

  if (new Date(cb.expiresAt).getTime() <= Date.now()) {
    return { type: "expired" };
  }

  let payload: Record<string, unknown> = {};
  if (cb.payloadJson) {
    try {
      payload = JSON.parse(cb.payloadJson) as Record<string, unknown>;
    } catch {
      return { type: "stale" };
    }
  }

  const req = repo.findRequestById(cb.requestFk);
  if (!req) {
    return { type: "stale" };
  }

  const next = transitionRequest(
    {
      requestId: req.requestId,
      clientId: req.clientId,
      sessionId: req.sessionId,
      status: req.status,
      expiresAt: new Date(req.expiresAt),
    },
    {
      type: "DECISION",
      requestId: req.requestId,
      clientId: req.clientId,
      sessionId: req.sessionId,
    },
    new Date(),
  );

  if (!next) {
    return { type: "stale" };
  }

  if (next.status === "expired") {
    return { type: "expired" };
  }

  if (next.status !== "decided" && next.status !== "rejected") {
    return { type: "stale" };
  }

  const actionType = cb.actionType;

  switch (actionType) {
    case "permission_approve": {
      repo.updateRequestStatus(req.id, "decided");
      return {
        type: "permission",
        requestId: req.requestId,
        clientId: req.clientId,
        sessionId: req.sessionId,
        approved: true,
        always: false,
      };
    }

    case "permission_always": {
      repo.updateRequestStatus(req.id, "decided");
      return {
        type: "permission",
        requestId: req.requestId,
        clientId: req.clientId,
        sessionId: req.sessionId,
        approved: true,
        always: true,
      };
    }

    case "permission_reject": {
      repo.updateRequestStatus(req.id, "decided");
      return {
        type: "permission",
        requestId: req.requestId,
        clientId: req.clientId,
        sessionId: req.sessionId,
        approved: false,
        always: false,
      };
    }

    case "question_select": {
      const value = payload.value as string;
      const label = payload.label as string;
      repo.updateRequestStatus(req.id, "decided");
      repo.saveAnswers(req.id, [{ value, label }]);
      return {
        type: "question",
        requestId: req.requestId,
        clientId: req.clientId,
        sessionId: req.sessionId,
        answerValue: value,
        answerLabel: label,
      };
    }

    case "question_multi_toggle": {
      const toggleValue = payload.value as string;

      const state = repo.findDecisionState(req.id, chatId, telegramUserId);
      let selected: string[] = [];
      if (state) {
        try { selected = JSON.parse(state.selectedJson) as string[]; } catch { /* */ }
      }

      if (selected.includes(toggleValue)) {
        selected = selected.filter((v) => v !== toggleValue);
      } else {
        selected = [...selected, toggleValue];
      }

      if (state) {
        repo.updateDecisionState(state.id, JSON.stringify(selected));
      } else {
        repo.createDecisionState(req.id, chatId, telegramUserId, messageId, selected);
      }

      return {
        type: "multi_toggle",
        requestId: req.requestId,
        clientId: req.clientId,
        sessionId: req.sessionId,
        newSelectedValues: selected,
        messageId,
      };
    }

    case "question_multi_done": {
      const state = repo.findDecisionState(req.id, chatId, telegramUserId);
      let selected: string[] = [];
      if (state) {
        try { selected = JSON.parse(state.selectedJson) as string[]; } catch { /* */ }
        repo.deleteDecisionState(state.id);
      }

      repo.updateRequestStatus(req.id, "decided");

      const allOptions = payload.options as Array<{ label: string; value: string }> | undefined ?? [];
      const answers = selected.map((v) => {
        const opt = allOptions.find((o) => o.value === v);
        return { value: v, label: opt?.label ?? v };
      });
      repo.saveAnswers(req.id, answers);

      return {
        type: "multi_done",
        requestId: req.requestId,
        clientId: req.clientId,
        sessionId: req.sessionId,
        selectedValues: selected,
      };
    }

    case "question_custom_text": {
      return {
        type: "custom_text",
        requestId: req.requestId,
        clientId: req.clientId,
        sessionId: req.sessionId,
        messageId,
      };
    }

    default:
      return { type: "stale" };
  }
}
