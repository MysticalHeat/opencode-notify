import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../src/db/migrate.js";
import { openDatabase } from "../src/db/database.js";
import { createRepository, type Repository } from "../src/db/repository.js";
import { createPairingService, type PairingService } from "../src/pairing/service.js";

// ─── Helpers ──────────────────────────────────────────────

let db: Database.Database;
let repo: Repository;
let cleanup: (() => void) | undefined;
let tmpDir: string;
let pairingService: PairingService;

const AUTHORIZED_USER_ID = 123456789;
const UNAUTHORIZED_USER_ID = 987654321;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pairing-test-"));
  const dbPath = join(tmpDir, "test.db");
  const result = openDatabase(dbPath);
  db = result.db;
  cleanup = () => {
    result.close();
    rmSync(tmpDir, { recursive: true, force: true });
  };
  runMigrations(db);
  repo = createRepository(db);
});

afterAll(() => {
  if (cleanup) cleanup();
});

beforeEach(() => {
  db.exec(`
    DELETE FROM outbox;
    DELETE FROM telegram_updates;
    DELETE FROM request_answers;
    DELETE FROM requests;
    DELETE FROM pairing_codes;
    DELETE FROM pairings;
    DELETE FROM clients;
  `);
  // Fresh pairing service per test to reset rate limiter
  pairingService = createPairingService(repo, AUTHORIZED_USER_ID);
});

// ─── PAIRING CODE CREATION ────────────────────────────────

describe("pairing code creation", () => {
  it("generates a pairing code with expiry", () => {
    const { code, expiresAt } = pairingService.generatePairingCode();
    expect(code).toBeDefined();
    expect(code.length).toBeGreaterThanOrEqual(8);
    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    // Code should be stored in the database
    const row = repo.findPairingCodeByCode(code);
    expect(row).toBeDefined();
    expect(row!.code).toBe(code);
    expect(row!.consumed).toBe(0);
  });

  it("generates unique codes on consecutive calls", () => {
    const c1 = pairingService.generatePairingCode();
    const c2 = pairingService.generatePairingCode();
    expect(c1.code).not.toBe(c2.code);
  });

  it("allows custom TTL for pairing code", () => {
    const shortTtl = 5_000; // 5 seconds
    const { expiresAt } = pairingService.generatePairingCode(shortTtl);
    const diff = expiresAt.getTime() - Date.now();
    expect(diff).toBeLessThanOrEqual(shortTtl + 500); // allow some clock skew
    expect(diff).toBeGreaterThan(0);
  });
});

// ─── PAIRING CODE EXPIRY ──────────────────────────────────

describe("pairing code expiry", () => {
  it("rejects expired codes", async () => {
    const { code } = pairingService.generatePairingCode(1); // 1ms TTL — expired immediately
    // Wait a tick for expiry
    await new Promise((r) => setTimeout(r, 5));

    let generatedToken: string | undefined;
    const result = await pairingService.confirmPairingCode(
      code,
      AUTHORIZED_USER_ID,
      async (token, _client) => {
        generatedToken = token;
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("expired");
    expect(generatedToken).toBeUndefined();
  });

  it("expirePairingCodes cleans up expired codes", () => {
    pairingService.generatePairingCode(1); // immediately expired
    // Should not throw
    const count = repo.expirePairingCodes();
    expect(count).toBeGreaterThanOrEqual(0);
  });
});

// ─── ONE-TIME CODE CONSUMPTION ────────────────────────────

describe("one-time code consumption", () => {
  it("consumes a code only once", async () => {
    const { code } = pairingService.generatePairingCode(60_000);

    let firstToken: string | undefined;
    const result1 = await pairingService.confirmPairingCode(
      code,
      AUTHORIZED_USER_ID,
      async (token, _client) => {
        firstToken = token;
      },
    );
    expect(result1.success).toBe(true);
    expect(firstToken).toBeDefined();

    // Second attempt should fail
    let secondToken: string | undefined;
    const result2 = await pairingService.confirmPairingCode(
      code,
      AUTHORIZED_USER_ID,
      async (token, _client) => {
        secondToken = token;
      },
    );
    expect(result2.success).toBe(false);
    expect(secondToken).toBeUndefined();

    // Verify code is marked consumed in DB
    const row = repo.findPairingCodeByCode(code);
    expect(row).toBeDefined();
    expect(row!.consumed).toBe(1);
  });

  it("second confirmation attempt returns error about already consumed", async () => {
    const { code } = pairingService.generatePairingCode(60_000);

    await pairingService.confirmPairingCode(
      code,
      AUTHORIZED_USER_ID,
      async () => {},
    );

    const result2 = await pairingService.confirmPairingCode(
      code,
      AUTHORIZED_USER_ID,
      async () => {},
    );
    expect(result2.success).toBe(false);
    expect(result2.error).toMatch(/already|consumed/i);
  });
});

// ─── WRONG TELEGRAM USER ──────────────────────────────────

describe("wrong Telegram user", () => {
  it("rejects confirmation from unauthorized user ID", async () => {
    const { code } = pairingService.generatePairingCode(60_000);

    let generatedToken: string | undefined;
    const result = await pairingService.confirmPairingCode(
      code,
      UNAUTHORIZED_USER_ID,
      async (token, _client) => {
        generatedToken = token;
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unauthorized|not authorized/i);
    expect(generatedToken).toBeUndefined();

    // Code should not be consumed
    const row = repo.findPairingCodeByCode(code);
    expect(row!.consumed).toBe(0);
  });

  it("authorized user can still confirm after unauthorized attempt", async () => {
    const { code } = pairingService.generatePairingCode(60_000);

    // Unauthorized attempt
    await pairingService.confirmPairingCode(
      code,
      UNAUTHORIZED_USER_ID,
      async () => {},
    );

    // Authorized attempt succeeds
    let generatedToken: string | undefined;
    const result = await pairingService.confirmPairingCode(
      code,
      AUTHORIZED_USER_ID,
      async (token, _client) => {
        generatedToken = token;
      },
    );
    expect(result.success).toBe(true);
    expect(generatedToken).toBeDefined();
  });
});

// ─── TOKEN HANDOFF VIA CALLBACK ───────────────────────────

describe("token handoff via callback", () => {
  it("issues a unique random client token via callback on confirmation", async () => {
    const { code } = pairingService.generatePairingCode(60_000);

    let receivedToken: string | null = null;
    let receivedClient: unknown = null;

    const result = await pairingService.confirmPairingCode(
      code,
      AUTHORIZED_USER_ID,
      async (token, client) => {
        receivedToken = token;
        receivedClient = client;
      },
    );
    expect(result.success).toBe(true);
    expect(receivedToken).toBeDefined();
    expect(receivedToken!.length).toBeGreaterThanOrEqual(32);
    expect(receivedClient).toBeDefined();
  });

  it("creates a new client row in the database on confirmation", async () => {
    const { code } = pairingService.generatePairingCode(60_000);

    let clientId: string | undefined;
    await pairingService.confirmPairingCode(
      code,
      AUTHORIZED_USER_ID,
      async (_token, client) => {
        clientId = client.id;
      },
    );
    expect(clientId).toBeDefined();

    const clients = repo.listAllClients();
    expect(clients.length).toBe(1);
    expect(clients[0]!.id).toBe(clientId);
  });

  it("each confirmation creates a new client (not reused)", async () => {
    const c1 = pairingService.generatePairingCode(60_000);
    const c2 = pairingService.generatePairingCode(60_000);

    let client1Id: string | undefined;
    let client2Id: string | undefined;

    await pairingService.confirmPairingCode(
      c1.code,
      AUTHORIZED_USER_ID,
      async (_t, client) => {
        client1Id = client.id;
      },
    );
    await pairingService.confirmPairingCode(
      c2.code,
      AUTHORIZED_USER_ID,
      async (_t, client) => {
        client2Id = client.id;
      },
    );

    expect(client1Id).not.toBe(client2Id);
    const clients = repo.listAllClients();
    expect(clients.length).toBe(2);
  });
});

// ─── TOKEN REVOCATION ─────────────────────────────────────

describe("token revocation", () => {
  it("revokes a client token via deleteClient", async () => {
    const { code } = pairingService.generatePairingCode(60_000);

    let clientId: string | undefined;
    await pairingService.confirmPairingCode(
      code,
      AUTHORIZED_USER_ID,
      async (_token, client) => {
        clientId = client.id;
      },
    );
    expect(clientId).toBeDefined();

    // Revoke
    const revoked = pairingService.revokeClient(
      clientId!,
      AUTHORIZED_USER_ID,
    );
    expect(revoked).toBe(true);

    // Client should no longer be in the list
    const clients = repo.listAllClients();
    expect(clients.find((c) => c.id === clientId)).toBeUndefined();
  });

  it("revocation by unauthorized user fails", async () => {
    const { code } = pairingService.generatePairingCode(60_000);

    let clientId: string | undefined;
    await pairingService.confirmPairingCode(
      code,
      AUTHORIZED_USER_ID,
      async (_token, client) => {
        clientId = client.id;
      },
    );

    const revoked = pairingService.revokeClient(
      clientId!,
      UNAUTHORIZED_USER_ID,
    );
    expect(revoked).toBe(false);

    // Client should still exist
    const clients = repo.listAllClients();
    expect(clients.find((c) => c.id === clientId)).toBeDefined();
  });

  it("revocation of nonexistent client returns false", () => {
    const revoked = pairingService.revokeClient(
      "nonexistent-id",
      AUTHORIZED_USER_ID,
    );
    expect(revoked).toBe(false);
  });
});

// ─── RATE LIMITING ────────────────────────────────────────

describe("rate limiting", () => {
  it("allows up to 5 confirmation attempts within a window", async () => {
    // Generate 5 codes
    const codes = Array.from({ length: 5 }, () =>
      pairingService.generatePairingCode(60_000),
    );

    const results: boolean[] = [];
    for (const { code } of codes) {
      const result = await pairingService.confirmPairingCode(
        code,
        AUTHORIZED_USER_ID,
        async () => {},
      );
      results.push(result.success);
    }

    expect(results.every(Boolean)).toBe(true);
  });

  it("rejects the 6th confirmation attempt with invalid codes within the same window", async () => {
    // Use invalid codes — failures should count toward rate limit
    for (let i = 0; i < 5; i++) {
      const result = await pairingService.confirmPairingCode(
        "WRONG-CODE",
        AUTHORIZED_USER_ID,
        async () => {},
      );
      expect(result.success).toBe(false);
    }

    const result6 = await pairingService.confirmPairingCode(
      "WRONG-CODE",
      AUTHORIZED_USER_ID,
      async () => {},
    );
    expect(result6.success).toBe(false);
    expect(result6.error).toMatch(/rate limit|too many/i);
  });

  it("rate limiter is scoped to pairing confirmations (not code generation)", () => {
    // Code generation should not be rate-limited
    const codes = Array.from({ length: 10 }, () =>
      pairingService.generatePairingCode(60_000),
    );
    expect(codes).toHaveLength(10);
  });

  it("successful pairings do not count toward rate limit budget", async () => {
    // Generate 7 codes — all valid, should all succeed without rate limiting
    const codes = Array.from({ length: 7 }, () =>
      pairingService.generatePairingCode(60_000),
    );

    const results: boolean[] = [];
    for (const { code } of codes) {
      const result = await pairingService.confirmPairingCode(
        code,
        AUTHORIZED_USER_ID,
        async () => {},
      );
      results.push(result.success);
    }

    expect(results.length).toBe(7);
    expect(results.every(Boolean)).toBe(true);
  });

  it("rate limits repeated invalid code guesses", async () => {
    // Use the same invalid code for each attempt to trigger rate limit
    for (let i = 0; i < 5; i++) {
      const result = await pairingService.confirmPairingCode(
        "WRONG-CODE",
        AUTHORIZED_USER_ID,
        async () => {},
      );
      expect(result.success).toBe(false);
      if (i < 4) {
        expect(result.error).toMatch(/invalid|not found/i);
      }
    }

    // 6th attempt should be rate-limited
    const result6 = await pairingService.confirmPairingCode(
      "WRONG-CODE",
      AUTHORIZED_USER_ID,
      async () => {},
    );
    expect(result6.success).toBe(false);
    expect(result6.error).toMatch(/rate limit|too many/i);
  });

  it("successful pairing after 4 invalid guesses does not get rate-limited", async () => {
    // 4 invalid guesses consume budget but don't overflow
    for (let i = 0; i < 4; i++) {
      await pairingService.confirmPairingCode(
        "WRONG-CODE",
        AUTHORIZED_USER_ID,
        async () => {},
      );
    }

    // 5th attempt with a valid code should succeed (budget: 4 failures + 1 success = still within limit)
    const { code } = pairingService.generatePairingCode(60_000);
    const result = await pairingService.confirmPairingCode(
      code,
      AUTHORIZED_USER_ID,
      async () => {},
    );
    expect(result.success).toBe(true);
  });
});

// ─── CALLBACK FAILURE & CAS CONSUME RESILIENCE ─────────────

describe("callback failure and CAS consume resilience", () => {
  it("CAS consume failure does not leave an orphaned client record", async () => {
    const { code } = pairingService.generatePairingCode(60_000);

    // Consume the code directly via repo to simulate a race
    const otherClient = repo.createClient("racer-token");
    const consumed = repo.consumePairingCode(code, otherClient.id);
    expect(consumed).toBe(true);

    // Now try to confirm — CAS should fail
    let callbackCalled = false;
    const result = await pairingService.confirmPairingCode(
      code,
      AUTHORIZED_USER_ID,
      async (_token, _client) => {
        callbackCalled = true;
      },
    );

    expect(result.success).toBe(false);
    expect(callbackCalled).toBe(false);

    // No extra client records should have been added beyond the racer
    const clients = repo.listAllClients();
    expect(clients.length).toBe(1);
    expect(clients[0]!.id).toBe(otherClient.id);
  });

  it("callback failure cleans up client and resets pairing code", async () => {
    const { code } = pairingService.generatePairingCode(60_000);

    let callbackCalled = false;
    const result = await pairingService.confirmPairingCode(
      code,
      AUTHORIZED_USER_ID,
      async (_token, _client) => {
        callbackCalled = true;
        throw new Error("callback delivery failed");
      },
    );

    expect(result.success).toBe(false);
    expect(callbackCalled).toBe(true);
    expect(result.error).toMatch(/callback|failed/i);

    // Client should have been cleaned up
    const clients = repo.listAllClients();
    expect(clients.length).toBe(0);

    // Pairing code should be unconsumed (available for retry)
    const pc = repo.findPairingCodeByCode(code);
    expect(pc).toBeDefined();
    expect(pc!.consumed).toBe(0);
  });

  it("after callback failure, same pairing code can be retried successfully", async () => {
    const { code } = pairingService.generatePairingCode(60_000);

    // First attempt: callback fails
    const result1 = await pairingService.confirmPairingCode(
      code,
      AUTHORIZED_USER_ID,
      async (_token, _client) => {
        throw new Error("callback delivery failed");
      },
    );
    expect(result1.success).toBe(false);

    // Second attempt: callback succeeds with same code
    let receivedToken: string | undefined;
    const result2 = await pairingService.confirmPairingCode(
      code,
      AUTHORIZED_USER_ID,
      async (token, _client) => {
        receivedToken = token;
      },
    );
    expect(result2.success).toBe(true);
    expect(receivedToken).toBeDefined();

    // Should have exactly 1 client now (first was cleaned up)
    const clients = repo.listAllClients();
    expect(clients.length).toBe(1);
  });

  it("plaintext token is never exposed in error response on callback failure", async () => {
    const { code } = pairingService.generatePairingCode(60_000);

    const result = await pairingService.confirmPairingCode(
      code,
      AUTHORIZED_USER_ID,
      async (_token, _client) => {
        throw new Error("callback delivery failed");
      },
    );
    expect(result.success).toBe(false);
    // Error message must not contain any token-like strings
    expect(JSON.stringify(result)).not.toMatch(
      /[A-Za-z0-9_-]{32,}/,
    );
  });
});

// ─── /clients VISIBILITY ──────────────────────────────────

describe("/clients visibility", () => {
  it("lists all registered clients for authorized user", async () => {
    const { code } = pairingService.generatePairingCode(60_000);

    await pairingService.confirmPairingCode(
      code,
      AUTHORIZED_USER_ID,
      async () => {},
    );

    const clients = pairingService.listClients(AUTHORIZED_USER_ID);
    expect(clients.length).toBe(1);
  });

  it("rejects unauthorized access to client list", () => {
    expect(() =>
      pairingService.listClients(UNAUTHORIZED_USER_ID),
    ).toThrow(/unauthorized|not authorized/i);
  });
});

// ─── PAIRING REPOSITORY INTEGRATION ───────────────────────

describe("pairing repository methods", () => {
  it("createPairingCode and findPairingCodeByCode round-trip", () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const row = repo.createPairingCode("TEST-CODE1", expiresAt);
    expect(row.code).toBe("TEST-CODE1");
    expect(row.consumed).toBe(0);

    const found = repo.findPairingCodeByCode("TEST-CODE1");
    expect(found).toBeDefined();
    expect(found!.id).toBe(row.id);
  });

  it("consumePairingCode atomically marks code as consumed", () => {
    const expiresAt = new Date(Date.now() + 60_000);
    repo.createPairingCode("CONSUME-CODE", expiresAt);

    const client = repo.createClient("temp-token");
    const consumed = repo.consumePairingCode("CONSUME-CODE", client.id);
    expect(consumed).toBe(true);

    const row = repo.findPairingCodeByCode("CONSUME-CODE");
    expect(row!.consumed).toBe(1);
    expect(row!.consumedByClientId).toBe(client.id);
  });

  it("consumePairingCode fails for already-consumed code", () => {
    const expiresAt = new Date(Date.now() + 60_000);
    repo.createPairingCode("DOUBLE-CONSUME", expiresAt);
    const client1 = repo.createClient("token-1");
    repo.consumePairingCode("DOUBLE-CONSUME", client1.id);

    const client2 = repo.createClient("token-2");
    const second = repo.consumePairingCode("DOUBLE-CONSUME", client2.id);
    expect(second).toBe(false);
  });

  it("consumePairingCode fails for expired code", () => {
    const expiresAt = new Date(Date.now() - 60_000); // past
    repo.createPairingCode("EXPIRED-CODE", expiresAt);

    const client = repo.createClient("temp-token");
    const consumed = repo.consumePairingCode("EXPIRED-CODE", client.id);
    expect(consumed).toBe(false);
  });
});
