import { randomBytes } from "node:crypto";
import type { Repository, ClientRow } from "../db/repository.js";

// ─── Types ──────────────────────────────────────────────

export interface PairingService {
  generatePairingCode(ttlMs?: number): { code: string; expiresAt: Date };
  confirmPairingCode(
    code: string,
    telegramUserId: number,
    onTokenGenerated: (token: string, client: ClientRow) => Promise<void>,
  ): Promise<{ success: boolean; clientId?: string; error?: string }>;
  revokeClient(clientId: string, telegramUserId: number): boolean;
  listClients(telegramUserId: number): ClientRow[];
}

// ─── Constants ──────────────────────────────────────────

const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000; // 5 minutes
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const TOKEN_BYTES = 32; // 256-bit random token

// ─── Rate Limiter ───────────────────────────────────────

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

function createRateLimiter() {
  const store = new Map<number, RateLimitEntry>();

  function isAllowed(userId: number): boolean {
    const now = Date.now();
    const entry = store.get(userId);

    if (!entry) {
      store.set(userId, { count: 1, windowStart: now });
      return true;
    }

    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      // Window expired, reset
      store.set(userId, { count: 1, windowStart: now });
      return true;
    }

    if (entry.count >= RATE_LIMIT_MAX_ATTEMPTS) {
      return false;
    }

    entry.count++;
    return true;
  }

  return { isAllowed };
}

// ─── Helpers ────────────────────────────────────────────

function generateHumanCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 for readability
  const bytes = randomBytes(8);
  const parts: string[] = [];

  for (let i = 0; i < 8; i++) {
    const idx = bytes[i]! % chars.length;
    parts.push(chars[idx]!);
  }

  return parts.slice(0, 4).join("") + "-" + parts.slice(4).join("");
}

function generateClientToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

function isAuthorized(
  telegramUserId: number,
  authorizedUserId: number,
): boolean {
  return telegramUserId === authorizedUserId;
}

// ─── Factory ────────────────────────────────────────────

export function createPairingService(
  repo: Repository,
  authorizedUserId: number,
): PairingService {
  const rateLimiter = createRateLimiter();

  return {
    generatePairingCode(ttlMs?: number): { code: string; expiresAt: Date } {
      const ttl = ttlMs ?? DEFAULT_PAIRING_TTL_MS;
      const expiresAt = new Date(Date.now() + ttl);
      const code = generateHumanCode();
      repo.createPairingCode(code, expiresAt);
      return { code, expiresAt };
    },

    async confirmPairingCode(
      code: string,
      telegramUserId: number,
      onTokenGenerated: (token: string, client: ClientRow) => Promise<void>,
    ): Promise<{ success: boolean; clientId?: string; error?: string }> {
      // Authorization check
      if (!isAuthorized(telegramUserId, authorizedUserId)) {
        return { success: false, error: "unauthorized: not an authorized user" };
      }

      // Rate limiting
      if (!rateLimiter.isAllowed(telegramUserId)) {
        return { success: false, error: "rate limit: too many pairing attempts" };
      }

      // Look up the pairing code
      const pairingCode = repo.findPairingCodeByCode(code);
      if (!pairingCode) {
        return { success: false, error: "invalid pairing code" };
      }

      // Check expiry
      if (new Date(pairingCode.expiresAt).getTime() <= Date.now()) {
        return { success: false, error: "pairing code expired" };
      }

      // Check consumed
      if (pairingCode.consumed === 1) {
        return { success: false, error: "pairing code already consumed" };
      }

      // Generate client token and create client
      const token = generateClientToken();
      const client = repo.createClient(token);

      // Atomically consume the pairing code
      const consumed = repo.consumePairingCode(code, client.id);
      if (!consumed) {
        // Race condition: someone else consumed it between check and now
        return { success: false, error: "pairing code already consumed" };
      }

      // Hand off token via callback (never persisted or sent to Telegram)
      await onTokenGenerated(token, client);

      return { success: true, clientId: client.id };
    },

    revokeClient(
      clientId: string,
      telegramUserId: number,
    ): boolean {
      if (!isAuthorized(telegramUserId, authorizedUserId)) {
        return false;
      }
      return repo.deleteClient(clientId);
    },

    listClients(telegramUserId: number): ClientRow[] {
      if (!isAuthorized(telegramUserId, authorizedUserId)) {
        throw new Error("unauthorized: not an authorized user");
      }
      return repo.listAllClients();
    },
  };
}
