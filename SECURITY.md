# Security Policy

## Supported versions

| Version | Supported          |
|---------|--------------------|
| 0.x     | :white_check_mark: |

## Reporting a vulnerability

To report a security vulnerability, please **do not** open a public issue.

Instead, email the maintainer directly or use GitHub's private vulnerability
reporting if enabled on the repository.

You can expect:

- An acknowledgment within 72 hours.
- A fix or mitigation plan within 14 days, depending on severity.
- Coordinated disclosure after the fix is released.

## Scope

This policy covers:

- The `@nomli/opencode-notify` plugin package.
- The relay server (`@repo/server`).
- The wire protocol (`@repo/protocol`).

## Secure defaults

- The plugin config file is stored with mode `0600` (owner read/write only).
- Client tokens are never logged or embedded in build artifacts.
- Relay connections require bearer-token authentication.
- Pairing codes are single-use and time-limited.

## Supply chain

- Dependencies are pinned in `package-lock.json`.
- CI enforces lockfile integrity via `npm ci`.
- Dependabot is configured for weekly automated updates.
- The public npm package uses trusted publishing and `npm publish --provenance`.
  No long-lived npm publish token is stored in GitHub.
- The release workflow requires `id-token: write`; provenance failures are not
  hidden and stop the release.
- The relay Telegram token is stored only in the VPS environment file. Rotate
  it immediately if it appears in terminal output, logs, or an image layer.
