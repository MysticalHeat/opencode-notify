# Changelog

## 0.0.0

- Initial prebuilt package release `@nomli/opencode-notify`.
- Bundles internal protocol and core runtime code.
- Provides `createNotifyPlugin` factory with config, dedupe, quiet hours, focus suppression, and relay support.
- Desktop notifications via `node-notifier` (auto-fallback when cmux unavailable).
