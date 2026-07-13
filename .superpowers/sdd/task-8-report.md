# Task 8 Report: Extract local notification package

**Status:** Complete  
**Commit:** `refactor(plugin): extract local notification package`

## Summary

Extracted desktop/cmux notification behavior from `~/.config/opencode/plugins/notify.ts` and submodules into `packages/opencode-plugin/src/`. No imports from global config, no Telegram sender/relay transport. Local notifications remain functional when future relay is absent/offline.

## Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Public API exports |
| `src/notify.ts` | Plugin factory, event pipeline (normalize, dedupe, quiet hours, child-session, summarize) |
| `src/backend.ts` | Desktop notification via `node-notifier`, cmux notification with timeout/fallback |
| `src/timeout.ts` | `withTimeout` utility (extracted from kdco-primitives) |
| `src/types.ts` | Shared type definitions |
| `src/node-notifier.d.ts` | Type declaration for `node-notifier` |

## Tests (90 passing)

| Test file | Count | Covers |
|-----------|-------|--------|
| `normalize.test.ts` | 15 | `tool.execute.before` mapping, `session.status(idle)` mapping, direct passthrough, unknown events |
| `dedupe.test.ts` | 13 | Key generation per event type, duplicate suppression within window, reset |
| `quiet-hours.test.ts` | 9 | Overnight range, normal range, edge boundaries |
| `child-session.test.ts` | 10 | Child suppression on/off, question/permission always allowed, session metadata |
| `backend.test.ts` | 16 | cmux args, availability check, spawn/timeout, fallback priorities |
| `notify.test.ts` | 18 | Event summarization, context building, sound assignment |
| `timeout.test.ts` | 9 | TimeoutError, resolve, reject, edge cases |

## Dependency setup

- `node-notifier`: runtime dependency
- `@opencode-ai/plugin`: peer + dev dependency
- `@opencode-ai/sdk`: dev dependency (types only)
- Bun APIs (`Bun.which`, `Bun.spawn`) guarded with typeof checks, injectable via `NotifyDeps`

## Checks

- [x] Build passes
- [x] Typecheck passes
- [x] Lint passes
- [x] 90/90 tests pass

## Concerns

- `cmux` notification path uses `Bun.spawn` as default; Node.js environments must provide `spawnProcess` via deps or use desktop-only path
- `node-notifier` dynamic import catches missing/offline gracefully (returns false, no crash)
- No integration test with real `node-notifier` — unit tests mock all external deps
- Session metadata fetching depends on `@opencode-ai/sdk` types at design time but is optional at runtime (gracefully returns `{}` on error)

## Review Fixes (commit `ac94f5b`)

**Status:** Complete  
**Commit:** `fix(plugin): address Task 8 review Moderate findings`

### Findings addressed

| Finding | Resolution |
|---------|------------|
| Terminal-focus suppression missing | Restored via new `src/focus.ts` module with injectable `TerminalDetectDeps` |
| Notification activation/bundleId missing | `activate`/`bundleId` now passed to `sendDesktopNotification` from terminal info |
| Session metadata fetched twice per event | Fixed: `shouldSkipChildSession` called once, both `skip` and `session` destructured |
| No platform/terminal deps injection | Added `NotifyDeps.terminal` with `TerminalDetectDeps` (platform, env, runCommand) |

### New files

| File | Purpose |
|------|---------|
| `src/focus.ts` | Terminal detection, bundleId mapping, focus state, suppression decision |
| `__tests__/focus.test.ts` | 41 unit tests for focus suppression, terminal detection, bundle mapping |
| `__tests__/plugin.test.ts` | 9 integration tests for single-fetch, focus suppression pipeline, tool hooks |

### Checks

- [x] 140/140 tests pass (was 90)
- [x] Typecheck passes
- [x] Lint passes
- [x] No global config or machine-specific paths reintroduced
- [x] No relay/Telegram scope added
