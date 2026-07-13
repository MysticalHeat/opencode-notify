### Task 10: Connect OpenCode requests to relay decisions

**Status:** DONE  
**Commit:** (see below)  

---

### Files Created

| File | Purpose |
|------|---------|
| `packages/opencode-plugin/src/events.ts` | Event adapters converting `question.asked`, `question.v2.asked`, `permission.asked`, `permission.v2.asked` to protocol `RequestUpsertMessage` / `RequestCancelMessage` |
| `packages/opencode-plugin/src/relay-client.ts` | Reconnecting WSS relay client with bounded exponential backoff + jitter, heartbeat, dedupe, shutdown |
| `packages/opencode-plugin/src/opencode-client.ts` | OpenCode v2 SDK adapter via `createOpencodeClient({ baseUrl: serverUrl })`, applying question answers/reject and permission once/always/reject with 404-as-expired semantics |
| `packages/opencode-plugin/__tests__/events.test.ts` | 13 tests: exact event fixtures for `question.asked`, `question.v2.asked`, `permission.asked`, `permission.v2.asked` conversion to `UpsertEvent`, message building, cancel building, relay gating |
| `packages/opencode-plugin/__tests__/relay-client.test.ts` | 8 tests: fake WebSocket proving connect→paired handshake, decision delivery, dedupe-by-messageId, reconnection with backoff, shutdown suppression, heartbeat emission, malformed-message resilience, answers decision handling |
| `packages/opencode-plugin/__tests__/integration.test.ts` | 16 tests: fake OpenCode SDK proving v2 `applyQuestion` (applied/expired/failed), `rejectQuestion`, `applyPermission` (once/always/reject), 404→expired, v2→legacy fallback, full question+permission lifecycle |

### Files Modified

| File | Change |
|------|--------|
| `packages/opencode-plugin/src/index.ts` | Export new modules: `eventToUpsert`, `buildUpsertMessage`, `buildCancelMessage`, `shouldRelayEvent`, `RelayClient`, `applyQuestion`, `rejectQuestion`, `applyPermission`, `createOpencodeClient` and their types |

### Design Decisions

1. **Event adapter** (`events.ts`): Self-contained to avoid circular dependencies with `notify.ts`. Normalizes v2 (`question.v2.asked`, `permission.v2.asked`) and legacy (`question.asked`, `permission.asked`) events into a unified `UpsertEvent` with 5-minute expiry window.

2. **Relay client** (`relay-client.ts`): WSS-based with protocol handshake (hello→pairing→heartbeat). Exponential backoff capped at 120s (configurable) with ±30% jitter. Deduplicates decisions by `requestId:messageId` composite key. Flushes pending upserts on successful pairing. Send failures are silently ignored (non-blocking).

3. **OpenCode client** (`opencode-client.ts`): Prefers v2 SDK (`client.v2.session.question.reply/reject`, `client.v2.session.permission.reply`) with graceful fallback to legacy (`client.question.reply/reject`, `client.permission.reply/respond`). Returns `"applied"` on success, `"expired"` on 404 (not found = request expired), `"failed"` on other errors. All calls are non-blocking to plugin hooks.

4. **Local behavior preserved**: Relay integration is additive; existing desktop notification flow is unchanged. Relay failures/errors never block plugin event hooks.

### Test Results

```
Test Files  13 passed (13)
     Tests  256 passed (256)
```

- TypeScript typecheck: clean
- ESLint: clean (no warnings/errors in new files)

### Verification Commands

```bash
npm run test -- --filter=@repo/opencode-plugin
npm run typecheck
npm run lint
```

### Potential Concerns

1. **`@opencode-ai/sdk` is a devDependency**: The `createOpencodeClient` import in `opencode-client.ts` uses `@opencode-ai/sdk/v2` which is listed as a devDependency in `@repo/opencode-plugin`. This works in dev/test but for distribution, the consumer must provide the `@opencode-ai/sdk` peer dependency (already declared as `@opencode-ai/plugin` peer dep).
2. **Relay client uses `globalThis.WebSocket`**: No fallback for environments without native WebSocket. If needed in Node.js without built-in WebSocket, consumers can inject `ws` via a custom constructor.
3. **Pending reconciliation on reconnect**: Implemented via `flushPending()` which re-sends stored upsert events. Full pending-request reconciliation (listing from OpenCode, comparing with queued decisions) requires the consumer to wire the relay client's `onDecision` callback to list and reconcile pending requests via the OpenCode client.
4. **No packaging/CI/deploy**: Per task brief, these are deferred.

---

## Review Fixes (Task 10)

**Date:** 2026-07-13

### Issues Fixed

| # | Issue | File(s) | Change |
|---|-------|---------|--------|
| 1 | `getSessionID` used ambiguous `props.id` as fallback | `events.ts:21-23` | Removed `props.id` fallback; `sessionID`/`sessionId` only |
| 2 | `buildUpsertMessage` included `undefined` fields in payload | `events.ts:138-155` | Added `stripUndefined()` helper; `question`/`permission` stripped when undefined |
| 3 | `seenDecisions` `Set<string>` grew unboundedly | `relay-client.ts:55,228-246` | Replaced with `Map<string, number>` (key→timestamp); TTL-based eviction (5 min) + max 1000 entries |
| 4 | `onDecision` callback exception escaped handler | `relay-client.ts:272-278` | Wrapped `onDecision(msg)` in try/catch; dedupe tracked before callback |
| 5 | Failed `sendApplyResult` silently lost when not paired | `relay-client.ts:59,113-127,147-168` | Added `pendingApplyResults` queue; flushed on `flushPending()` after pairing |
| 6 | Stale event listeners retained across reconnects | `relay-client.ts:67-68,177,179,189-199` | Named `messageListener`/`closeListener`; removed from old WS before new connection |
| 7 | `flushPending()` reconstructed minimal events (lost question/permission) | `relay-client.ts:58,101-104,141-145` | Stored full `UpsertEvent` in `Map<string, UpsertEvent>`; sends complete payload on flush |

### Regression Tests Added (15 new)

| Test suite | Count | Verifies |
|------------|-------|----------|
| sanitize props.id extraction | 3 | `id` not used as sessionID; `id` still used as requestID; real sessionID preserved |
| valid protocol upserts | 3 | `question` stripped from permission-only; `permission` stripped from question-only; complete payload preserved |
| bound/expire seen decisions | 1 | 100 unique decisions → deduped on replay; old entries evictable |
| callback exception isolation | 2 | Throwing callback doesn't crash handler; dedupe tracked before callback |
| failed apply-result retry | 3 | Result queued pre-pairing then flushed; immediate send when paired; no throw on shutdown |
| stale listener prevention | 1 | Old socket messages don't affect client after reconnect |
| complete payload preservation | 2 | `flushPending` sends full question payload; apply results also flushed |

### Verification

| Check | Result |
|-------|--------|
| Tests (271 total, 15 new) | PASS (271/271) |
| Typecheck (`tsc --noEmit`) | PASS (all 4 packages) |
| Lint (`eslint`) | PASS (opencode-plugin; 7 pre-existing server errors unaffected) |
| RED → GREEN | Confirmed: 6 tests failed → 6 pass after fixes |

### Design Principles Preserved

- **Local desktop behavior unchanged**: Only `events.ts` and `relay-client.ts` modified; `notify.ts`, `backend.ts`, `focus.ts` untouched
- **Non-blocking hooks**: Callback exceptions caught; send failures silently ignored; apply-result queuing is non-blocking
- **No packaging/deployment**: As specified
