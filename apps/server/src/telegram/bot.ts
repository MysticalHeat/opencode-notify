import { Bot, type Context } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import type { PairingService } from "../pairing/service.js";
import type { Repository, RequestRow } from "../db/repository.js";
import { renderPermissionKeyboard, renderQuestionKeyboard, renderTerminalMessage, renderPermissionDecision, renderMultiSelectUpdateKeyboard } from "./render.js";
import { handleCallbackQuery } from "./callbacks.js";
import { handleTextReply } from "./text-replies.js";

// ─── Types ──────────────────────────────────────────────

export interface TelegramContext {
  userId: number;
  chatId: number;
  text: string;
}

export interface BotResponse {
  text: string;
  parseMode?: "HTML" | "MarkdownV2";
  markup?: InlineKeyboardMarkup;
  /** Force the user to reply to this message (for custom text entry). */
  forceReply?: boolean;
  /** Message ID to edit (for terminal keyboard removal/replacement). */
  editMessageId?: number;
}

// ─── Internal ───────────────────────────────────────────

const MSG_UNAUTHORIZED = "You are not authorized to use this bot.";
const MSG_INVALID_COMMAND = "Unknown command. Use /pair <code> or /clients.";
const MSG_PAIR_USAGE = "Usage: /pair <code>";
const MSG_PAIR_SUCCESS = "Pairing confirmed! Your client has been registered.";
const MSG_PAIR_EXPIRED = "This pairing code has expired. Please generate a new one.";
const MSG_PAIR_CONSUMED = "This pairing code has already been used.";
const MSG_PAIR_INVALID = "Invalid pairing code. Please check and try again.";
const MSG_PAIR_RATE_LIMITED = "Too many pairing attempts. Please wait and try again.";
const MSG_REVOKE_USAGE = "Usage: /revoke <client-id>";
const MSG_REVOKE_SUCCESS = "Client revoked successfully.";
const MSG_REVOKE_FAILED = "Failed to revoke client. Check the client ID and try again.";
const MSG_NO_CLIENTS = "No registered clients found.";
const MSG_CALLBACK_STALE = "This action is no longer available.";
const MSG_CALLBACK_EXPIRED = "This request has expired.";
const MSG_UNAUTHORIZED_CALLBACK = "You are not authorized for this action.";
const MSG_QUESTION_DONE = "Answer recorded.";
const MSG_CUSTOM_TEXT_PROMPT = "Please reply to this message with your answer.";

// ─── Command handler (reused from Task 4-6) ─────────────

function createCommandHandler(pairingService: PairingService) {
  async function handlePairCommand(
    ctx: TelegramContext,
    args: string[],
  ): Promise<BotResponse> {
    if (args.length === 0) {
      return { text: MSG_PAIR_USAGE };
    }

    const code = args[0]!;

    const result = await pairingService.confirmPairingCode(
      code,
      ctx.userId,
      async (_token, _client) => { /* Token delivered via callback channel */ },
    );

    if (result.success) return { text: MSG_PAIR_SUCCESS };
    if (result.error?.includes("expired")) return { text: MSG_PAIR_EXPIRED };
    if (result.error?.includes("consumed")) return { text: MSG_PAIR_CONSUMED };
    if (result.error?.includes("rate limit")) return { text: MSG_PAIR_RATE_LIMITED };
    if (result.error?.includes("unauthorized")) return { text: MSG_UNAUTHORIZED };
    return { text: MSG_PAIR_INVALID };
  }

  function handleClientsCommand(ctx: TelegramContext): BotResponse {
    try {
      const clients = pairingService.listClients(ctx.userId);
      if (clients.length === 0) return { text: MSG_NO_CLIENTS };
      const lines = clients.map((c) => {
        const created = new Date(c.createdAt).toISOString();
        const lastSeen = new Date(c.lastSeenAt).toISOString();
        const status = c.revokedAt
          ? `  Revoked: ${new Date(c.revokedAt).toISOString()}`
          : "  Status: active";
        return [
          `ID: <code>${c.id}</code>`,
          `  Created: ${created}`,
          `  Last seen: ${lastSeen}`,
          status,
        ].join("\n");
      });
      return {
        text: `<b>Registered Clients (${clients.length})</b>\n\n${lines.join("\n\n")}`,
        parseMode: "HTML" as const,
      };
    } catch {
      return { text: MSG_UNAUTHORIZED };
    }
  }

  function handleRevokeCommand(ctx: TelegramContext, args: string[]): BotResponse {
    if (args.length === 0) return { text: MSG_REVOKE_USAGE };
    const clientId = args[0]!;
    const revoked = pairingService.revokeClient(clientId, ctx.userId);
    return revoked ? { text: MSG_REVOKE_SUCCESS } : { text: MSG_REVOKE_FAILED };
  }

  async function handleMessage(ctx: TelegramContext): Promise<BotResponse> {
    const trimmed = ctx.text.trim();
    const cmdMatch = trimmed.match(/^\/(\w+)\s*(.*)$/s);
    if (!cmdMatch) return { text: MSG_INVALID_COMMAND };

    const command = cmdMatch[1]!.toLowerCase();
    const argsRaw = cmdMatch[2] ?? "";
    const args = argsRaw.split(/\s+/).filter(Boolean);

    switch (command) {
      case "pair": return handlePairCommand(ctx, args);
      case "clients": return handleClientsCommand(ctx);
      case "revoke": return handleRevokeCommand(ctx, args);
      default: return { text: MSG_INVALID_COMMAND };
    }
  }

  return { handleMessage };
}

// ─── Outbox integration ─────────────────────────────────

export function enqueueDecision(
  repo: Repository,
  result: { requestId: string; clientId: string; sessionId: string; approved?: boolean; always?: boolean; answerValue?: string; answerLabel?: string; selectedValues?: string[] },
  requestRow: RequestRow | undefined,
) {
  if (!requestRow) return;

  const idempotencyKey = `tg-decision-${result.requestId}-${Date.now()}`;
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  let payload: unknown;

  if (result.approved !== undefined) {
    payload = {
      requestId: result.requestId,
      clientId: result.clientId,
      sessionId: result.sessionId,
      approved: result.approved,
      always: result.always ?? false,
    };
  } else if (result.selectedValues !== undefined) {
    payload = {
      requestId: result.requestId,
      clientId: result.clientId,
      sessionId: result.sessionId,
      answers: result.selectedValues.map((v) => ({ value: v, label: v })),
    };
  } else if (result.answerValue !== undefined) {
    payload = {
      requestId: result.requestId,
      clientId: result.clientId,
      sessionId: result.sessionId,
      answers: [{ value: result.answerValue, label: result.answerLabel ?? result.answerValue }],
    };
  } else {
    payload = { requestId: result.requestId };
  }

  repo.enqueue({
    idempotencyKey,
    recipientId: result.clientId,
    messageType: "decision",
    payload,
    requestId: result.requestId,
    expiresAt,
  });
}

// ─── Bot adapter (grammY) ───────────────────────────────

export interface BotAdapter {
  /** Start long polling (blocking). */
  start(onGetUpdates?: (updates: unknown[]) => void): Promise<void>;
  /** Return a webhook handler compatible with node:http createServer. */
  webhookHandler(expectedToken: string): (req: { body?: unknown; headers: Record<string, string | undefined> }, res: { statusCode: number; end: (body?: string) => void }) => Promise<void>;
  /** Post a pending request to the bot as a Telegram message. */
  postRequest(requestRow: RequestRow): Promise<{ messageId: number } | undefined>;
}

export function createBotAdapter(
  botToken: string,
  authorizedUserId: number,
  repo: Repository,
  pairingService: PairingService,
): BotAdapter {
  const bot = new Bot(botToken);
  const commandHandler = createCommandHandler(pairingService);

  bot.on("message:text", async (ctx: Context) => {
    const msg = ctx.message;
    if (!msg) return;

    const userId = msg.from?.id;
    const chatId = msg.chat.id;
    if (!userId) return;

    const replyToMessageId = msg.reply_to_message?.message_id;

    // Handle ForceReply responses first
    if (replyToMessageId) {
      const replyResult = handleTextReply(
        repo,
        msg.text,
        userId,
        authorizedUserId,
        chatId,
        replyToMessageId,
      );

      if (replyResult.type === "correlated" && replyResult.requestId) {
        const req = repo.findRequestByRequestIdAndClient(replyResult.requestId, replyResult.clientId!);
        enqueueDecision(repo, {
          requestId: replyResult.requestId,
          clientId: replyResult.clientId!,
          sessionId: replyResult.sessionId!,
          answerValue: replyResult.text,
          answerLabel: replyResult.text,
        }, req);
        await ctx.reply(MSG_QUESTION_DONE, { reply_to_message_id: msg.message_id });
        return;
      }

      if (replyResult.type === "unauthorized") {
        await ctx.reply(MSG_UNAUTHORIZED_CALLBACK, { reply_to_message_id: msg.message_id });
        return;
      }

      if (replyResult.type === "stale") {
        await ctx.reply(MSG_CALLBACK_STALE, { reply_to_message_id: msg.message_id });
        return;
      }
    }

    // Regular command handling
    const cmdResult = await commandHandler.handleMessage({
      userId,
      chatId,
      text: msg.text ?? "",
    });

    if (cmdResult.markup) {
      await ctx.reply(cmdResult.text, {
        parse_mode: cmdResult.parseMode ?? "HTML",
        reply_markup: cmdResult.markup,
      });
    } else if (cmdResult.forceReply) {
      await ctx.reply(cmdResult.text, {
        parse_mode: cmdResult.parseMode ?? "HTML",
        reply_markup: { force_reply: true },
      });
    } else {
      await ctx.reply(cmdResult.text, {
        parse_mode: cmdResult.parseMode ?? "HTML",
      });
    }
  });

  bot.on("callback_query", async (ctx: Context) => {
    const cq = ctx.callbackQuery;
    if (!cq || !cq.data) return;

    const userId = cq.from.id;
    const chatId = cq.message?.chat.id;
    const messageId = cq.message?.message_id;
    if (!chatId || !messageId) return;

    const result = handleCallbackQuery(
      repo,
      cq.data,
      userId,
      authorizedUserId,
      chatId,
      messageId,
    );

    if (result.type === "unauthorized") {
      await ctx.answerCallbackQuery();
      await ctx.reply(MSG_UNAUTHORIZED_CALLBACK);
      return;
    }

    if (result.type === "stale" || result.type === "expired") {
      await ctx.answerCallbackQuery();
      const msg = result.type === "expired" ? MSG_CALLBACK_EXPIRED : MSG_CALLBACK_STALE;
      try {
        await ctx.editMessageText(msg);
      } catch {
        await ctx.reply(msg);
      }
      return;
    }

    if (result.type === "custom_text") {
      await ctx.answerCallbackQuery();
      try {
        await ctx.editMessageText(MSG_CUSTOM_TEXT_PROMPT);
        const sent = await ctx.reply(MSG_CUSTOM_TEXT_PROMPT, {
          reply_markup: { force_reply: true },
        });
        if (result.requestId && result.clientId) {
          const reqRow = repo.findRequestByRequestIdAndClient(result.requestId, result.clientId);
          if (reqRow) {
            repo.createFreplyTracking(
              chatId,
              userId,
              sent.message_id,
              reqRow.id,
              new Date(Date.now() + 5 * 60 * 1000),
            );
          }
        }
      } catch {
        await ctx.reply(MSG_CUSTOM_TEXT_PROMPT, {
          reply_markup: { force_reply: true },
        });
      }
      return;
    }

    if (result.type === "multi_toggle") {
      await ctx.answerCallbackQuery();

      const selected = result.newSelectedValues ?? [];
      const req = repo.findRequestByRequestIdAndClient(result.requestId!, result.clientId!);
      if (!req || !req.payloadJson) return;

      try {
        const qPayload = JSON.parse(req.payloadJson) as { text: string; options: Array<{ label: string; value: string }> };
        const toggledLabels = qPayload.options.map((opt) => {
          const isSel = selected.includes(opt.value);
          return `${isSel ? "X" : " "} ${opt.label}`;
        }).join("\n");

        const prefix = selected.length > 0
          ? `Selected (${selected.length}):`
          : "Select one or more:";

        const newText = [
          qPayload.text,
          "",
          prefix,
          toggledLabels,
        ].join("\n");

        const expiresAt = new Date(req.expiresAt);
        const newMarkup = renderMultiSelectUpdateKeyboard(
          repo,
          req.id,
          qPayload.options,
          selected,
          expiresAt,
        );

        try {
          await ctx.editMessageText(newText, { reply_markup: newMarkup });
        } catch {
          // Message may not exist, ignore
        }
      } catch {
        // Payload parse error
      }
      return;
    }

    // Terminal outcomes: permission or question selected
    await ctx.answerCallbackQuery();

    if (result.type === "permission" || result.type === "question" || result.type === "multi_done") {
      const req = repo.findRequestByRequestIdAndClient(result.requestId!, result.clientId!);
      enqueueDecision(repo, result as { requestId: string; clientId: string; sessionId: string; approved?: boolean; answerValue?: string; selectedValues?: string[] }, req);

      if (result.type === "permission") {
        const action = req?.payloadJson ? (JSON.parse(req.payloadJson) as { action: string }).action ?? "Permission" : "Permission";
        const decisionText = renderPermissionDecision(action, result.approved!, result.always);
        try {
          await ctx.editMessageText(decisionText);
        } catch {
          await ctx.reply(decisionText);
        }
      } else if (result.type === "multi_done") {
        const selected = result.selectedValues ?? [];
        const qText = req?.payloadJson ? (JSON.parse(req.payloadJson) as { text: string }).text ?? "Question" : "Question";
        const terminalText = `${qText}\n\nAnswers:\n${selected.map((v) => `- ${v}`).join("\n")}`;
        try {
          await ctx.editMessageText(terminalText);
        } catch {
          await ctx.reply(terminalText);
        }
      } else {
        const terminalText = renderTerminalMessage(
          req?.payloadJson ? (JSON.parse(req.payloadJson) as { text: string }).text ?? "Question" : "Question",
          result.answerLabel ?? result.answerValue ?? "",
        );
        try {
          await ctx.editMessageText(terminalText);
        } catch {
          await ctx.reply(terminalText);
        }
      }
    }
  });

  return {
    async start(onGetUpdates?: (updates: unknown[]) => void) {
      if (onGetUpdates) {
        bot.use(async (ctx, next) => {
          onGetUpdates([ctx.update]);
          await next();
        });
      }
      await bot.start();
    },

    webhookHandler(expectedToken: string) {
      return async function handler(
        req: { body?: unknown; headers: Record<string, string | undefined> },
        res: { statusCode: number; end: (body?: string) => void; setHeader?: (k: string, v: string) => void },
      ): Promise<void> {
        const secretToken = (req.headers["x-telegram-bot-api-secret-token"] as string | undefined) ?? "";

        if (secretToken !== expectedToken) {
          res.statusCode = 403;
          res.end("Forbidden");
          return;
        }

        try {
          await bot.handleUpdate(req.body as Parameters<typeof bot.handleUpdate>[0]);
          res.statusCode = 200;
          res.end("OK");
        } catch {
          res.statusCode = 500;
          res.end("Internal Server Error");
        }
      };
    },

    async postRequest(requestRow: RequestRow): Promise<{ messageId: number } | undefined> {
      if (!requestRow.payloadJson || !requestRow.payloadType) return undefined;

      try {
        const expiresAt = new Date(requestRow.expiresAt);
        let resp: unknown;

        if (requestRow.payloadType === "permission") {
          const payload = JSON.parse(requestRow.payloadJson) as { action: string; patterns: string[]; display: string };
          const { text, markup } = renderPermissionKeyboard(repo, requestRow.id, payload, expiresAt);
          resp = await bot.api.sendMessage(authorizedUserId, text, {
            parse_mode: "HTML",
            reply_markup: markup,
          });
        } else {
          const payload = JSON.parse(requestRow.payloadJson) as { text: string; options: Array<{ label: string; value: string }>; multiSelect?: boolean };
          const { text, markup } = renderQuestionKeyboard(repo, requestRow.id, payload, expiresAt);
          resp = await bot.api.sendMessage(authorizedUserId, text, {
            parse_mode: "HTML",
            reply_markup: markup,
          });
        }

        const sendResp = resp as { message_id: number };
        return { messageId: sendResp.message_id };
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * Legacy handler factory exposed for backward compatibility with existing
 * server wiring.  New code should use createBotAdapter.
 */
export function createBotHandler(pairingService: PairingService) {
  return createCommandHandler(pairingService);
}
