# OpenCode Notify — Plugin Configuration

## Config file location

The plugin reads its configuration from:

```
~/.config/opencode/opencode-notify.json
```

Override the path with the `OPENCODE_NOTIFY_CONFIG_PATH` environment variable
(see "Loading overrides" below).

## Permissions

The config file is written with mode `0600` (owner read/write only). The plugin
automatically corrects a config file that has been created with a wider
permission mask (e.g. `0644`, `0666`) the next time it is opened. Write
operations use an atomic temp-file-plus-rename strategy so that an existing
config is never left in a partially-written state even if the process crashes
mid-write.

## Schema

```jsonc
{
  "version": 1,

  "relay": {
    // Enable the relay transport.  Default: false.
    // The relay will not connect unless explicitly enabled *and* a valid
    // url/clientToken pair has been provided.
    "enabled": false,

    // Relay server URL.  Must use https:// or wss://.
    "url": "https://relay.example.com",

    // Client bearer token issued by the relay.
    "clientToken": "<token>",

    // Per-client metadata forwarded during pairing.
    "clientMetadata": {
      "notifyChildSessions": false,
      "sounds": {
        "idle": "default",
        "error": "basso",
        "permission": "ping",
        "question": "default"
      },
      "quietHours": {
        "enabled": false,
        "start": "22:00",
        "end": "08:00"
      }
    }
  },

  "desktop": {
    "notifyChildSessions": false,
    "sounds": {
      "idle": "default",
      "error": "basso",
      "permission": "ping",
      "question": "default"
    },
    "quietHours": {
      "enabled": false,
      "start": "22:00",
      "end": "08:00"
    }
  }
}
```

### Field reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `version` | number | `1` | Config schema version |
| `relay.enabled` | boolean | `false` | Whether the relay transport is active |
| `relay.url` | string | — | Relay server URL (`https://` or `wss://`) |
| `relay.clientToken` | string | — | Client bearer token |
| `relay.clientMetadata.notifyChildSessions` | boolean | `false` | Relay should notify for child sessions |
| `relay.clientMetadata.sounds.*` | string | `"default"`, `"basso"`, `"ping"`, `"default"` | Sound names forwarded to relay |
| `relay.clientMetadata.quietHours.enabled` | boolean | `false` | Quiet-hours range active |
| `relay.clientMetadata.quietHours.start` | string | `"22:00"` | Start time (`HH:MM`) |
| `relay.clientMetadata.quietHours.end` | string | `"08:00"` | End time (`HH:MM`) |
| `desktop.notifyChildSessions` | boolean | `false` | Desktop notifications for child sessions |
| `desktop.sounds.*` | string | (same as relay) | Desktop notification sounds |
| `desktop.quietHours.*` | — | (same as relay) | Desktop quiet hours |

All sections are optional. Missing fields are filled from the defaults above.

## Environment-variable overrides

The following environment variables are read at startup and override
file-based configuration. They are never written back to disk.

| Variable | Overrides | Accepted values |
|----------|-----------|-----------------|
| `OPENCODE_NOTIFY_CONFIG_PATH` | Config file path | Absolute path to an alternate config file |
| `OPENCODE_NOTIFY_RELAY_URL` | `relay.url` | `https://` or `wss://` URL |
| `OPENCODE_NOTIFY_CLIENT_TOKEN` | `relay.clientToken` | Non-empty string |
| `OPENCODE_NOTIFY_RELAY_ENABLED` | `relay.enabled` | `"true"` / `"1"` / `"false"` |

Env overrides are useful for automation (CI, provisioning scripts) so that
secrets do not need to be embedded in the project tree or checked into version
control.

**Security note:** Keep `OPENCODE_NOTIFY_CLIENT_TOKEN` out of shell history and
shared environment dumps. Use a secret manager or a short-lived shell variable
when possible.

## Loading order

1. Read `~/.config/opencode/opencode-notify.json` (or the path from
   `OPENCODE_NOTIFY_CONFIG_PATH`). If the file does not exist, the in-memory
   defaults are used.
2. Merge filed-in config on top of defaults.
3. Apply env-var overrides on top of the merged config.
4. Validate the result (invalid URLs, wrong types → `ValidationError`).

## One-time migration from `kdco-notify.json`

If an older config file exists at `~/.config/opencode/kdco-notify.json`, the
plugin can extract legacy settings through a read-only migration:

- **Sounds** (`sounds`) are copied into both `desktop.sounds` and
  `relay.clientMetadata.sounds`.
- **Quiet hours** (`quietHours`) are copied into both `desktop.quietHours`
  and `relay.clientMetadata.quietHours`.
- **Child-session** settings (`childSessions` / `notifyChildSessions`) are
  copied into both `desktop.notifyChildSessions` and
  `relay.clientMetadata.notifyChildSessions`.
- **Telegram** settings (`telegram.botToken`, `telegram.chatId`) are NOT
  carried forward. Instead the migration explicitly sets `relay.enabled` to
  `false` — the relay must be paired explicitly before it is activated.

The old file is **never modified or deleted**. The migration is a pure read
and produces only in-memory configuration. To persist the migrated settings,
call `writeConfig()`.

## API

The `config.ts` module exports these functions (file-system and home-directory
dependencies are injectable for testing):

| Export | Purpose |
|--------|---------|
| `loadConfig(opts?)` | Read → validate → merge defaults → return config |
| `writeConfig(config, opts?)` | Validate → merge defaults → atomic write with `0600` |
| `migrateFromOldConfig(opts?)` | Read-only migration from `kdco-notify.json` → config object or `null` |
| `ensureConfigMode(opts?)` | Check and correct file permissions to `0600` |
| `applyEnvOverrides(config, env?)` | Apply env-var overrides (non-mutating) |
| `configPath(os?, envPath?)` | Resolve the config file path |
| `oldConfigPath(os?)` | Resolve the old `kdco-notify.json` path |
| `DEFAULT_CONFIG` | Default `OpenCodeNotifyConfig` object |
