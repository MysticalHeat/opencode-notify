# Task 9 Report: Add plugin configuration and one-time migration

**Status:** Complete  
**Commit:** `ff37d0c` — `feat(plugin): add secure relay configuration`

## Summary

Implemented a full configuration subsystem at `~/.config/opencode/opencode-notify.json`
with secure 0600 atomic writes, validated relay/client settings, injectable
filesystem/home abstractions, and a read-only migration path from the legacy
`kdco-notify.json`.

## Files

| File | Purpose |
|------|---------|
| `src/config.ts` | Config types, validation, deep-merge, atomic I/O, migration, env overrides |
| `__tests__/config.test.ts` | 67 unit tests across 10 describe blocks |
| `docs/configuration.md` | Full schema reference, env overrides, migration guide, API table |
| `src/index.ts` | Exported all public config symbols |

## Tests (207 total: 67 new + 140 existing)

| Category | Count | Coverage |
|----------|-------|----------|
| Defaults | 2 | Returns DEFAULT_CONFIG when no file exists, custom env path |
| Partial config | 4 | Merges relay/desktop/empty objects with defaults |
| Malformed JSON | 8 | Invalid JSON → ConfigError, wrong types → ValidationError, bad URLs, bad quiet hours |
| Token persistence | 4 | Write/read roundtrip for relay settings, desktop settings, combined, version field |
| Atomic writes | 7 | Correct content, 0600 mode, overwrite, temp file cleanup on success/failure, no corruption |
| Write validation | 2 | Invalid URL/quiet hours rejected on write |
| ensureConfigMode | 8 | Fixes 0644/0606/0604/0666 → 0600, leaves 0600, missing file → false, custom path |
| Migration | 10 | Sounds, quiet hours, childSessions/notifyChildSessions, Telegram → relay disabled, old file untouched, invalid/null old config → null, defaults preserved |
| applyEnvOverrides | 11 | URL/token/enabled from env, wss accepted, invalid → ValidationError, immutability of original, empty strings ignored, all three together |
| Config/old path | 3 | Default path resolution, env override, old path |
| Error types | 2 | ConfigError/ValidationError extend Error |
| Edge cases | 3 | Deep nesting, empty sub-objects, version-only config |

## Implementation details

### Atomic writes
- Writes to a temp file (`~/.config/opencode/.opencode-notify.<uuid>.tmp`) with mode `0600`
- Verifies file mode post-write; corrects if filesystem overrides umask
- Renames temp to target (atomic on same filesystem)
- On failure: cleans up temp file, existing config untouched

### deepMerge
- Generic deep-merge with left-side defaults, right-side overrides
- Clones at every nesting level (no shared references to DEFAULT_CONFIG)
- Used by `loadConfig`, `writeConfig`, `migrateFromOldConfig`, `applyEnvOverrides`

### Migration (`migrateFromOldConfig`)
- Reads `~/.config/opencode/kdco-notify.json` (read-only)
- Maps `sounds`, `quietHours`, `childSessions`/`notifyChildSessions` into both `desktop.*` and `relay.clientMetadata.*`
- Maps Telegram settings → `relay.enabled = false` (requires explicit pairing)
- Returns `null` if old file doesn't exist, can't be read, or contains invalid JSON
- Old file is never modified

### Env overrides (`applyEnvOverrides`)
- `OPENCODE_NOTIFY_RELAY_URL` → `relay.url`
- `OPENCODE_NOTIFY_CLIENT_TOKEN` → `relay.clientToken`
- `OPENCODE_NOTIFY_RELAY_ENABLED` → `relay.enabled` (`"true"`/`"1"` → true, `"false"` → false)
- Non-mutating: returns a fresh object, original unchanged
- Env vars never written to disk

### Testability
- `FsAbstraction` and `OsAbstraction` interfaces with default Node.js implementations
- In-memory filesystem used in all 67 tests with configurable failure injection (`failWriteTo`, `failRenameFrom`)

## Checks

- [x] 207/207 tests pass
- [x] Typecheck passes
- [x] Lint passes
- [x] No relay transport wired (config only)
- [x] Old config migration preserves original file
- [x] Atomic writes verified via in-memory filesystem
- [x] 0600 permissions enforced on write

## Concerns

- ~~Config directory (`~/.config/opencode/`) must exist; `writeConfig` does not create missing parent directories~~ **Fixed in M3:** `writeConfig` now creates parent directories via `mkdir(dir, { recursive: true })`.
- Concurrent writes from multiple processes use last-writer-wins semantics (atomic rename per writer)
- Relay `clientToken` is stored in a local file with 0600 permissions; users should prefer env vars for automated environments
- The `DEFAULT_CONFIG` export includes initial sound/quiet-hours defaults; if these change in future versions, migrate may need to handle version bumps
- No integration test against the real filesystem — only mem-fs unit tests

## Review Fixes (H1/H2, M1/M2/M3)

**Commit:** `92e1c86`

### H1/H2 — Constrain env config-path override to home directory

`configPath(os, envPath)` now validates that any `envPath` override resolves to
a path under the user home directory. Paths outside home (e.g. `/etc`, `/tmp`,
path-traversal like `../../etc`) are rejected with `ConfigError`. Exact rule:
resolved path must start with `home + "/"` or equal `home` itself.

### M1 — Align MemFS default mode with production

MemFS `writeFile` default mode changed `0o644` → `0o600` to match production.

### M2 — Validate sound values as strings and both quietHours.enabled as boolean

Added validation for `desktop.sounds.*` (string), `relay.clientMetadata.sounds.*`
(string), and `relay.clientMetadata.quietHours.enabled` (boolean).

### M3 — Config parent directory creation

Added `mkdir` to `FsAbstraction`. `writeConfig` calls `mkdir(dir, { recursive: true })`
before writing. MemFS implementation is a no-op (flat filesystem).

### Test delta

| Area | Tests |
|------|-------|
| configPath env validation (H1/H2) | 5 added (3 reject + 2 allow) |
| loadConfig env reject (H1/H2) | 1 |
| ensureConfigMode env reject (H1/H2) | 1 |
| MemFS mode + parent dir (M1, M3) | 3 |
| Sound/enabled validation (M2) | 3 |
| **New total** | **219** (79 config + 140 existing) |

### Verification

- [x] 219/219 tests pass
- [x] Typecheck passes
- [x] Lint passes
- [x] Read-only old config migration preserved
- [x] No relay transport wired
