# opencode-notify

Cross-platform desktop and Telegram notification plugin for OpenCode.

## Packages

| Package | Scope | Description |
|---------|-------|-------------|
| [`@nomli/opencode-notify`](./packages/opencode-plugin) | Public | OpenCode plugin — installable from GitHub Packages |
| `@repo/core` | Private | Shared notification logic (request state, dedupe) |
| `@repo/protocol` | Private | Wire protocol schemas and parsers (v1) |
| `@repo/server` | Private | Relay server (Fastify + WebSocket + Telegram bot) |

## Quick start

```bash
npm install @nomli/opencode-notify@0.0.0
```

See [docs/operations.md](./docs/operations.md) for registry setup, PAT
configuration, and operational procedures.

## Development

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm run test
```

Requires Node.js >= 22.

## Documentation

- [Configuration reference](./docs/configuration.md)
- [Wire protocol specification](./docs/protocol.md)
- [Operations guide](./docs/operations.md)

## License

[MIT](./LICENSE)
