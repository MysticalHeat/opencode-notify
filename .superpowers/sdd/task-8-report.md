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
