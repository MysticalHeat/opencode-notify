import type { PairingService } from "../pairing/service.js";

// ─── Types ──────────────────────────────────────────────

/** Minimal Telegram message/callback shape used by the bot handler. */
export interface TelegramContext {
  /** The Telegram user ID from `message.from.id` or `callback_query.from.id`. */
  userId: number;
  /** The chat ID for sending replies. */
  chatId: number;
  /** Full text of the message (for commands) or callback data. */
  text: string;
}

export interface BotResponse {
  /** Message to send back to the Telegram chat. */
  text: string;
  /** Optional parse mode for Telegram formatting. */
  parseMode?: "HTML" | "MarkdownV2";
}

// ─── Constants ──────────────────────────────────────────

const MSG_UNAUTHORIZED =
  "You are not authorized to use this bot.";
const MSG_INVALID_COMMAND =
  "Unknown command. Use /pair <code> or /clients.";
const MSG_PAIR_USAGE =
  "Usage: /pair <code>";
const MSG_PAIR_SUCCESS =
  "Pairing confirmed! Your client has been registered.";
const MSG_PAIR_EXPIRED =
  "This pairing code has expired. Please generate a new one.";
const MSG_PAIR_CONSUMED =
  "This pairing code has already been used.";
const MSG_PAIR_INVALID =
  "Invalid pairing code. Please check and try again.";
const MSG_PAIR_RATE_LIMITED =
  "Too many pairing attempts. Please wait and try again.";
const MSG_REVOKE_USAGE =
  "Usage: /revoke <client-id>";
const MSG_REVOKE_SUCCESS =
  "Client revoked successfully.";
const MSG_REVOKE_FAILED =
  "Failed to revoke client. Check the client ID and try again.";
const MSG_NO_CLIENTS =
  "No registered clients found.";

// ─── Handler ────────────────────────────────────────────

export function createBotHandler(pairingService: PairingService) {
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
      async (_token, _client) => {
        // Token is intentionally NOT sent to Telegram.
        // It is handed off via the callback channel (WSS, etc.) — Task 6.
        // Telegram only gets a confirmation message.
      },
    );

    if (result.success) {
      return { text: MSG_PAIR_SUCCESS };
    }

    if (result.error?.includes("expired")) {
      return { text: MSG_PAIR_EXPIRED };
    }
    if (result.error?.includes("consumed")) {
      return { text: MSG_PAIR_CONSUMED };
    }
    if (result.error?.includes("rate limit")) {
      return { text: MSG_PAIR_RATE_LIMITED };
    }
    if (result.error?.includes("unauthorized")) {
      return { text: MSG_UNAUTHORIZED };
    }

    return { text: MSG_PAIR_INVALID };
  }

  function handleClientsCommand(ctx: TelegramContext): BotResponse {
    try {
      const clients = pairingService.listClients(ctx.userId);

      if (clients.length === 0) {
        return { text: MSG_NO_CLIENTS };
      }

      const lines = clients.map((c) => {
        const created = new Date(c.createdAt).toISOString();
        const lastSeen = new Date(c.lastSeenAt).toISOString();
        return [
          `ID: <code>${c.id}</code>`,
          `  Created: ${created}`,
          `  Last seen: ${lastSeen}`,
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

  function handleRevokeCommand(
    ctx: TelegramContext,
    args: string[],
  ): BotResponse {
    if (args.length === 0) {
      return { text: MSG_REVOKE_USAGE };
    }

    const clientId = args[0]!;
    const revoked = pairingService.revokeClient(clientId, ctx.userId);

    return revoked
      ? { text: MSG_REVOKE_SUCCESS }
      : { text: MSG_REVOKE_FAILED };
  }

  /**
   * Main entry point: given a Telegram context, returns the bot's response.
   */
  async function handleMessage(
    ctx: TelegramContext,
  ): Promise<BotResponse> {
    const trimmed = ctx.text.trim();

    // Match commands: /pair <code>, /clients, /revoke <id>
    const cmdMatch = trimmed.match(/^\/(\w+)\s*(.*)$/s);
    if (!cmdMatch) {
      return { text: MSG_INVALID_COMMAND };
    }

    const command = cmdMatch[1]!.toLowerCase();
    const argsRaw = cmdMatch[2] ?? "";
    const args = argsRaw.split(/\s+/).filter(Boolean);

    switch (command) {
      case "pair":
        return handlePairCommand(ctx, args);
      case "clients":
        return handleClientsCommand(ctx);
      case "revoke":
        return handleRevokeCommand(ctx, args);
      default:
        return { text: MSG_INVALID_COMMAND };
    }
  }

  return { handleMessage };
}
