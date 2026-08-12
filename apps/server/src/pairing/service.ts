import { randomBytes, randomUUID } from "node:crypto";
import type { Repository, ClientRow } from "../db/repository.js";

// ─── Types ──────────────────────────────────────────────

export interface PairingService {
  generatePairingCode(ttlMs?: number): { code: string; expiresAt: Date };
  waitForPairingConfirmation(code: string): {
    success: boolean;
    wait?: Promise<PairingCredentials>;
    cancel?: () => void;
    error?: string;
  };
  confirmPairingForConnectedClient(
    code: string,
    telegramUserId: number,
  ): Promise<{ success: boolean; clientId?: string; error?: string }>;
  confirmPairingCode(
    code: string,
    telegramUserId: number,
    onTokenGenerated: (token: string, client: ClientRow) => Promise<void>,
  ): Promise<{ success: boolean; clientId?: string; error?: string }>;
  revokeClient(clientId: string, telegramUserId: number): boolean;
  listClients(telegramUserId: number): ClientRow[];
}

export interface PairingCredentials {
  clientId: string;
  token: string;
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

  /** Refund one count so successful operations don't consume the budget. */
  function refund(userId: number): void {
    const entry = store.get(userId);
    if (entry && entry.count > 0) {
      entry.count--;
    }
  }

  return { isAllowed, refund };
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
  const waiters = new Map<string, (credentials: PairingCredentials) => void>();

  function validateAvailableCode(code: string): { success: true } | { success: false; error: string } {
    const pairingCode = repo.findPairingCodeByCode(code);
    if (!pairingCode) return { success: false, error: "invalid pairing code" };
    if (new Date(pairingCode.expiresAt).getTime() <= Date.now()) {
      return { success: false, error: "pairing code expired" };
    }
    if (pairingCode.consumed === 1) {
      return { success: false, error: "pairing code already consumed" };
    }
    return { success: true };
  }

  async function confirm(
    code: string,
    telegramUserId: number,
    onTokenGenerated: (token: string, client: ClientRow) => Promise<void>,
  ): Promise<{ success: boolean; clientId?: string; error?: string }> {
    if (!isAuthorized(telegramUserId, authorizedUserId)) {
      return { success: false, error: "unauthorized: not an authorized user" };
    }
    if (!rateLimiter.isAllowed(telegramUserId)) {
      return { success: false, error: "rate limit: too many pairing attempts" };
    }

    const available = validateAvailableCode(code);
    if (!available.success) return available;

    const clientId = randomUUID();
    const token = generateClientToken();
    if (!repo.confirmAndConsumePairingCode(code, clientId, telegramUserId)) {
      return { success: false, error: "pairing code already consumed" };
    }

    const client = repo.createClientWithId(clientId, token);
    try {
      await onTokenGenerated(token, client);
    } catch (callbackErr) {
      const cbMsg = callbackErr instanceof Error ? callbackErr.message : String(callbackErr);
      repo.compensateCallbackFailure(clientId, code);
      return { success: false, error: `callback failed: ${cbMsg}` };
    }

    rateLimiter.refund(telegramUserId);
    return { success: true, clientId: client.id };
  }

  return {
    generatePairingCode(ttlMs?: number): { code: string; expiresAt: Date } {
      const ttl = ttlMs ?? DEFAULT_PAIRING_TTL_MS;
      const expiresAt = new Date(Date.now() + ttl);
      const code = generateHumanCode();
      repo.createPairingCode(code, expiresAt);
      return { code, expiresAt };
    },

    waitForPairingConfirmation(code: string) {
      const available = validateAvailableCode(code);
      if (!available.success) return available;
      if (waiters.has(code)) {
        return { success: false, error: "pairing code is already waiting for confirmation" };
      }

      let resolveWaiter: ((credentials: PairingCredentials) => void) | undefined;
      const wait = new Promise<PairingCredentials>((resolve) => {
        resolveWaiter = resolve;
      });
      waiters.set(code, resolveWaiter!);

      return {
        success: true,
        wait,
        cancel: () => {
          if (waiters.get(code) === resolveWaiter) waiters.delete(code);
        },
      };
    },

    async confirmPairingForConnectedClient(code: string, telegramUserId: number) {
      const waiter = waiters.get(code);
      if (!waiter) return { success: false, error: "pairing client is not connected" };

      const result = await confirm(code, telegramUserId, async (token, client) => {
        waiter({ token, clientId: client.id });
      });
      if (result.success || result.error?.includes("consumed") || result.error?.includes("expired")) {
        waiters.delete(code);
      }
      return result;
    },

    async confirmPairingCode(
      code: string,
      telegramUserId: number,
      onTokenGenerated: (token: string, client: ClientRow) => Promise<void>,
    ): Promise<{ success: boolean; clientId?: string; error?: string }> {
      return confirm(code, telegramUserId, onTokenGenerated);
    },

    revokeClient(
      clientId: string,
      telegramUserId: number,
    ): boolean {
      if (!isAuthorized(telegramUserId, authorizedUserId)) {
        return false;
      }
      return repo.revokeClient(clientId);
    },

    listClients(telegramUserId: number): ClientRow[] {
      if (!isAuthorized(telegramUserId, authorizedUserId)) {
        throw new Error("unauthorized: not an authorized user");
      }
      return repo.listAllClients();
    },
  };
}
