# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| Latest  | Yes       |
| < 1.x   | No        |

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
- Publishes to GitHub Packages use repository-scoped `GITHUB_TOKEN` — no
  long-lived publish secrets.
