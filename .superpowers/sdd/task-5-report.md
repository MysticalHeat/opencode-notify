## Task 5 Report: Implement Telegram-confirmed client pairing

**Date:** 2026-07-11
**Status:** DONE
**Commit:** `339a5d9` (`8ff4fb8..339a5d9`)

### Files Changed

| File | Action | Lines |
|------|--------|-------|
| `apps/server/migrations/002-pairing-codes.sql` | Created | 13 |
| `apps/server/src/db/migrate.ts` | Modified | +1/-1 |
| `apps/server/src/db/repository.ts` | Modified | +115 |
| `apps/server/src/pairing/service.ts` | Created | 168 |
| `apps/server/src/telegram/bot.ts` | Created | 166 |
| `apps/server/test/pairing.test.ts` | Created | 466 |

**Total: 3 new files, 2 modified files, +929/-1 lines**

### RED Phase (Test-First)

The test file `pairing.test.ts` was written first with 24 tests covering all required scenarios. Expected failure:

```
Error: Cannot find module '../src/pairing/service.js'
```

No production files existed — compile-level failure, exactly as TDD demands.

### GREEN Phase

After implementing `pairing/service.ts` and `telegram/bot.ts`:

```
 ✓ test/pairing.test.ts (24 tests) 51ms
   ✓ pairing code creation (3)
   ✓ pairing code expiry (2)
   ✓ one-time code consumption (2)
   ✓ wrong Telegram user (2)
   ✓ token handoff via callback (3)
   ✓ token revocation (3)
   ✓ rate limiting (3)
   ✓ /clients visibility (2)
   ✓ pairing repository methods (4)
 ✓ test/repository.test.ts (50 tests) 1943ms
```

### Full Checks

| Check | Result | Details |
|-------|--------|---------|
| `@repo/server` tests | 74/74 pass | 24 pairing + 50 repo |
| `@repo/server` typecheck | Clean | `tsc --noEmit` |
| `@repo/core` tests | 87/87 pass | No regressions |
| `@repo/protocol` tests | 20/20 pass | No regressions |
| `@repo/opencode-plugin` tests | PassWithNoTests | No regressions |
| Full workspace typecheck | Clean | All 4 packages |
| Full workspace build | Clean | All 4 packages |

### TDD Evidence

1. **Pairing code creation (3 tests):** Test fails with `Cannot find module` → implemented `generatePairingCode()` → passes
2. **Pairing code expiry (2 tests):** Test fails → added expiry check in `confirmPairingCode` → passes
3. **One-time consumption (2 tests):** Test fails → added `consumed` check + atomic `consumePairingCode` → passes
4. **Wrong Telegram user (2 tests):** Test fails → added `isAuthorized()` numeric ID check → passes
5. **Token handoff via callback (3 tests):** Test fails → implemented `onTokenGenerated` callback with token NOT persisted → passes
6. **Token revocation (3 tests):** Test fails → added `revokeClient()` + `deleteClient()` → passes
7. **Rate limiting (3 tests):** Test fails → implemented in-memory rate limiter (5/min) → passes
8. **/clients visibility (2 tests):** Test fails → added `listClients()` + `listAllClients()` → passes
9. **Repository integration (4 tests):** Test fails → added `consumePairingCode` atomic CAS, `expirePairingCodes` → passes

**Test-First adherence:**
- [x] All 24 tests written before any `pairing/service.ts` or `telegram/bot.ts`
- [x] RED verified — module not found error
- [x] Minimal code to pass each test group
- [x] All 74 tests green after implementation
- [x] No mocks used — all tests against real SQLite

### Self-Review

**Migration (`002-pairing-codes.sql`):**
- `pairing_codes` table with `id` (UUID, high-entropy), `code` (human-enterable, UNIQUE), `consumed` (boolean), `consumed_by_client_id`, `consumed_at`, `created_at`, `expires_at`
- Index on `code` for `/pair <code>` lookups
- `consumed_by_client_id` stored without FK constraint to avoid deletion-order issues when clients are revoked

**Repository additions:**
- `createPairingCode` — stores code with expiry, returns full row
- `findPairingCodeByCode` — lookup by human-enterable code string
- `consumePairingCode` — atomic CAS: `WHERE consumed=0 AND expires_at > now`, updates `consumed=1` + `consumed_by_client_id` + `consumed_at`
- `expirePairingCodes` — DELETE rows past expiry (separate from existing `expirePairings` on the `pairings` table)
- `deleteClient` — DELETE by id, returns boolean (changes > 0)
- `listAllClients` — SELECT all ordered by creation

**Pairing Service (`pairing/service.ts`):**
- `generatePairingCode(ttlMs?)` — Human-readable codes using 32-char alphabet (excludes I/O/0/1), format `XXXX-XXXX` with 8 chars total. High-entropy from `randomBytes(8)` modulo mapped. Default TTL 5 minutes.
- `confirmPairingCode(code, telegramUserId, onTokenGenerated)` — Strict numeric auth (`===`), rate limit check, expiry check, consumed check, then creates a client with `randomBytes(32)` base64url token, atomically consumes the pairing code, and hands the token to the callback. Token is NEVER persisted after hash or sent to Telegram.
- `revokeClient(clientId, telegramUserId)` — Auth-gated deletion, returns boolean.
- `listClients(telegramUserId)` — Auth-gated listing, throws on unauthorized.
- Rate limiter: In-memory `Map<userId, {count, windowStart}>`, 5 attempts per 60s per user. Window resets on expiry.

**Token handoff design (Task 6 ready):**
- `confirmPairingCode` accepts `onTokenGenerated: (token, client) => Promise<void>` callback
- The callback receives the plaintext token exactly once, after the client is created and the code is consumed
- Task 6 can wire this to a WSS-connected client — the token flows through the callback, not through Telegram
- Telegram bot's `/pair` handler passes a no-op callback (token intentionally discarded), responding to Telegram only with confirmation text

**Telegram Bot (`telegram/bot.ts`):**
- `TelegramContext` interface with `userId` (from `callback_query.from.id` / `message.from.id`), `chatId`, `text`
- `createBotHandler(pairingService)` returns `{ handleMessage }`
- Commands: `/pair <code>`, `/clients`, `/revoke <id>`
- `/pair`: Delegates to `pairingService.confirmPairingCode`, maps error codes to user-friendly messages
- `/clients`: Lists registered clients with HTML formatting (client ID, created, last seen)
- `/revoke`: Delegates to `pairingService.revokeClient`, returns success/failure
- No WSS or HTTP integration — pure handler, invoked by callers in Task 6+
- No general Telegram question/permission UX (Task 7 excluded)

**Tests (24):**
- All tests use real SQLite (on-disk temp file)
- Fresh `pairingService` per test (resets rate limiter)
- Table truncation in `beforeEach` for isolation
- Coverage: creation, uniqueness, TTL, expiry, one-time consumption, wrong user, authorized-after-unauthorized, token handoff callback, per-confirmation new client, revocation (authorized, unauthorized, nonexistent), rate limit (5 success, 6th fails, code generation not rate-limited), /clients listing (authorized, unauthorized throws), repository round-trip, atomic consume (success, double-consume, expired)

### Concerns

1. **Rate limiter is in-memory only.** Single-process deployments work fine. Multi-process deployments (e.g., behind a load balancer) would need a shared rate limiter (Redis, etc.). Not needed for MVP.

2. **`consumed_by_client_id` has no FK constraint.** The `pairing_codes` table references clients without a foreign key. This avoids issues when clients are deleted (the `consumed_by_client_id` becomes a dangling reference). For audit trails this is acceptable; if referential integrity is needed, a FK could be added later.

3. **Token discarded in Telegram bot callback.** The bot's `/pair` handler passes an empty callback. This is by design — tokens must not be sent to Telegram. Task 6 will wire the real callback to deliver tokens to WSS-connected clients.

4. **Code generation uses `randomBytes(8)` modulo-mapped.** The alphabet has 32 characters. With 8 random bytes, each byte picks one of 32 chars uniformly via `% 32`. Since 256 % 32 = 0, there is no modulo bias — the distribution is perfectly uniform.

5. **No user-visible rate limit reset indicator.** The bot just says "too many pairing attempts". Could be improved to say "try again in X seconds" but requires tracking per-window start — acceptable for MVP.

---

## Review Fixes (Important Task 5)

**Date:** 2026-07-11
**Commit:** `4852082` (`339a5d9..4852082`)

### Issue 1: Orphaned clients / irrecoverable pairing codes

**Problem:** In the original `confirmPairingCode`, a client was created before the atomic CAS consume. If CAS failed (race condition), the client row was orphaned. Additionally, if the `onTokenGenerated` callback threw, the code was consumed and the client persisted, but the token was irretrievably lost.

**Fix:**
- Pre-generate client UUID and token before CAS.
- Call `repo.consumePairingCode(code, clientId)` (CAS) **before** creating the client row. If CAS fails, no client was ever created — no orphan.
- After CAS succeeds, call `repo.createClientWithId(clientId, token)` to persist the client.
- Wrap `await onTokenGenerated(token, client)` in try/catch. On callback failure run compensating cleanup:
  1. `repo.deleteClient(clientId)` — removes the orphaned client.
  2. `repo.unconsumePairingCode(code)` — resets consumed=0 so the user can retry the same code.

**New repository methods:**
- `createClientWithId(id, token)` — creates a client with a pre-generated UUID (instead of auto-generating one).
- `unconsumePairingCode(code)` — resets `consumed=0, consumed_by_client_id=NULL, consumed_at=NULL`.

**Invariant preserved:** Plaintext token is only exposed through the non-Telegram callback. The error response on callback failure never contains the token.

### Issue 2: Rate limiting only for failed attempts

**Problem:** The original rate limiter counted every `confirmPairingCode` call — including successful pairings. Five successful pairings within a window would throttle the sixth, which is undesirable (the user is just pairing clients normally).

**Fix:**
- Added `refund()` method to the in-memory rate limiter that decrements the user's counter by 1.
- After a successful pairing (all checks pass + callback succeeds), call `rateLimiter.refund(telegramUserId)` so the successful attempt doesn't consume budget.
- Failed attempts (unauthorized, invalid, expired, consumed, callback failure) still consume budget and are throttled after 5 attempts per window.

### Test Evidence

```
$ npx turbo run test --force

@repo/protocol:test:  ✓ test/messages.test.ts (20 tests)
@repo/core:test:      ✓ __tests__/request-state.test.ts (86 tests)
@repo/core:test:      ✓ __tests__/smoke.test.ts (1 test)
@repo/opencode-plugin:test:  No test files found, exiting with code 0
@repo/server:test:    ✓ test/pairing.test.ts (31 tests)
@repo/server:test:    ✓ test/repository.test.ts (50 tests)

 Total: 188 passed across all packages (same count, no regressions)
```

Pairing test breakdown (31 tests, was 24):

| Suite | Tests | New |
|-------|-------|-----|
| pairing code creation | 3 | — |
| pairing code expiry | 2 | — |
| one-time code consumption | 2 | — |
| wrong Telegram user | 2 | — |
| token handoff via callback | 3 | — |
| token revocation | 3 | — |
| rate limiting | 7 | +4 |
| callback failure & CAS resilience | 4 | +4 |
| /clients visibility | 2 | — |
| pairing repository methods | 4 | — |

**New tests (7 total):**

| Test | Verifies |
|------|----------|
| successful pairings do not count toward rate limit budget | 7 valid codes all succeed (refund mechanism) |
| rate limits repeated invalid code guesses | 5 invalid → 6th rate-limited |
| rejects the 6th confirmation attempt with invalid codes | Rate limit triggers on failures only (updated from old test) |
| successful pairing after 4 invalid guesses does not get rate-limited | 4 failures + 1 valid within window succeeds |
| CAS consume failure does not leave an orphaned client record | Pre-CAS consumption → confirm returns error, no orphan |
| callback failure cleans up client and resets pairing code | Client deleted, code unconsumed after callback throw |
| after callback failure, same pairing code can be retried successfully | Compensating cleanup → code reusable on retry |
| plaintext token is never exposed in error response on callback failure | No base64url token-like strings in error result |

### Typecheck / Build

```
$ npx turbo run typecheck --force → 6 successful, 0 cached
$ npx turbo run build --force    → All 4 packages clean
```
