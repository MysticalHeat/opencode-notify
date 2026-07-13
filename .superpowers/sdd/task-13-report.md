# Task 13 Report — CI, Release, Documentation

## Status: Complete

## Commit: `ci: add private package release workflow`

## Files Created/Modified

| File | Purpose |
|------|---------|
| `.github/workflows/ci.yml` | CI pipeline: typecheck, lint, test, build, npm pack dry-run, package.json checker, Docker build smoke |
| `.github/workflows/release.yml` | Release workflow: publishes `@nomli/opencode-notify` to GitHub Packages with provenance, uses `GITHUB_TOKEN` |
| `.github/dependabot.yml` | Weekly Dependabot for npm + GitHub Actions, ignores semver-major |
| `Dockerfile` | Minimal placeholder multi-stage build (smoke-tests CI Docker build, full image deferred to Task 14) |
| `docs/operations.md` | Consumer operations: `~/.npmrc` scope mapping, PAT classic setup, install/update/rollback/restart, pairing, revocation, npm/plugin/WebSocket cache troubleshooting |
| `README.md` | Root monorepo README with package overview, dev setup, docs links |
| `SECURITY.md` | Security policy: supported versions, reporting, scope, secure defaults, supply chain |
| `LICENSE` | Root MIT license (matching `packages/opencode-plugin/LICENSE`) |

## Checks

- [x] YAML structural validation (no tabs, balanced quotes) — all 3 workflow files pass
- [x] Docker build smoke test (`docker build`) — succeeds, produces image
- [x] `npm run typecheck` — passes (all cached)
- [x] `npm run test` — passes (all 559 tests across 4 packages)
- [x] `npm run lint` — 3 packages pass; `@repo/server` has 7 pre-existing `no-unused-vars` errors (not introduced by this task)

## Concerns

1. **Pre-existing lint violations in `@repo/server`** — `apps/server/src/app.ts:30` (`db` unused), plus 6 unused variables in test files. These are outside the scope of this task and existed before these changes.
2. **`npm audit` reports 3 vulnerabilities (1 low, 2 moderate) in dependencies** — Dependabot is now configured for weekly updates, which should address these over time.
3. **Release workflow requires `id-token: write` and `attestations: write`** — GitHub org/enterprise settings must allow these permissions for the repository.
4. **Dockerfile is a minimal placeholder** — The full deployment image is deferred to Task 14.
