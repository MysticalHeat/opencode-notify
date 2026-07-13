import { randomBytes } from "node:crypto";
import type { InlineKeyboardMarkup } from "grammy/types";
import type { Repository } from "../db/repository.js";

export type CallbackActionType =
  | "permission_approve"
  | "permission_always"
  | "permission_reject"
  | "question_select"
  | "question_multi_toggle"
  | "question_multi_done"
  | "question_custom_text";

export interface CallbackPayload {
  actionType: CallbackActionType;
  value?: string;
  selectedValues?: string[];
}

export interface QuestionPayload {
  text: string;
  options: Array<{ label: string; value: string }>;
  multiSelect?: boolean;
}

export interface PermissionPayload {
  action: string;
  patterns: string[];
  display: string;
}

function generateActionId(): string {
  return randomBytes(32).toString("base64url");
}

function storeCallbackId(
  repo: Repository,
  requestId: string,
  actionType: CallbackActionType,
  expiresAt: Date,
  payload: unknown,
): string {
  const actionId = generateActionId();
  repo.createCallbackId(actionId, requestId, actionType, expiresAt, payload);
  return actionId;
}

export function renderPermissionKeyboard(
  repo: Repository,
  requestId: string,
  payload: PermissionPayload,
  expiresAt: Date,
): { text: string; markup: InlineKeyboardMarkup } {
  const approveId = storeCallbackId(repo, requestId, "permission_approve", expiresAt, { approved: true });
  const alwaysId = storeCallbackId(repo, requestId, "permission_always", expiresAt, { approved: true, always: true });
  const rejectId = storeCallbackId(repo, requestId, "permission_reject", expiresAt, { approved: false });

  const text = [
    `Permission Request`,
    ``,
    `Action: ${payload.action}`,
    payload.patterns.length > 0 ? `Paths: ${payload.patterns.join(", ")}` : "",
    `Description: ${payload.display}`,
    ``,
    `How would you like to respond?`,
  ].filter(Boolean).join("\n");

  const markup: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        { text: "Approve Once", callback_data: approveId },
        { text: "Always Approve", callback_data: alwaysId },
        { text: "Reject", callback_data: rejectId },
      ],
    ],
  };

  return { text, markup };
}

export function renderQuestionKeyboard(
  repo: Repository,
  requestId: string,
  payload: QuestionPayload,
  expiresAt: Date,
): { text: string; markup: InlineKeyboardMarkup } {
  const isMulti = payload.multiSelect === true;
  const questionText = payload.text;

  const intro = isMulti
    ? `${questionText}\n(select one or more, then tap Done)`
    : `${questionText}\n(select one)`;

  if (isMulti && payload.options.length === 0) {
    const doneId = storeCallbackId(repo, requestId, "question_multi_done", expiresAt, { selectedValues: [] });
    const customId = storeCallbackId(repo, requestId, "question_custom_text", expiresAt, {});

    const markup: InlineKeyboardMarkup = {
      inline_keyboard: [
        [{ text: "Done", callback_data: doneId }],
        [{ text: "Enter custom answer...", callback_data: customId }],
      ],
    };

    return { text: intro, markup };
  }

  if (payload.options.length === 0) {
    const customId = storeCallbackId(repo, requestId, "question_custom_text", expiresAt, {});
    const markup: InlineKeyboardMarkup = {
      inline_keyboard: [
        [{ text: "Enter custom answer...", callback_data: customId }],
      ],
    };

    return { text: intro, markup };
  }

  if (isMulti) {
    const rows = payload.options.map((opt) => {
      const toggleId = storeCallbackId(repo, requestId, "question_multi_toggle", expiresAt, { value: opt.value, options: payload.options });
      return [{ text: opt.label, callback_data: toggleId }];
    });

    const doneId = storeCallbackId(repo, requestId, "question_multi_done", expiresAt, { selectedValues: [] });
    const customId = storeCallbackId(repo, requestId, "question_custom_text", expiresAt, {});

    rows.push([{ text: "Done", callback_data: doneId }]);
    rows.push([{ text: "Enter custom answer...", callback_data: customId }]);

    const markup: InlineKeyboardMarkup = { inline_keyboard: rows };

    return { text: intro, markup };
  }

  const rows = payload.options.map((opt) => {
    const selectId = storeCallbackId(repo, requestId, "question_select", expiresAt, { value: opt.value, label: opt.label });
    return [{ text: opt.label, callback_data: selectId }];
  });

  const customId = storeCallbackId(repo, requestId, "question_custom_text", expiresAt, {});
  rows.push([{ text: "Enter custom answer...", callback_data: customId }]);

  const markup: InlineKeyboardMarkup = { inline_keyboard: rows };

  return { text: intro, markup };
}

export function renderTerminalMessage(question: string, label: string): string {
  return `${question}\n\nAnswer: ${label}`;
}

export function renderPermissionDecision(action: string, approved: boolean, always?: boolean): string {
  const alwaysSuffix = always ? " (always)" : "";
  return `Permission: ${action}\nDecision: ${approved ? "Approved" : "Rejected"}${alwaysSuffix}`;
}
