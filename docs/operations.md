# Operations Guide — @nomli/opencode-notify

## Package registry setup

The `@nomli/opencode-notify` package is published to **GitHub Packages** at
`https://npm.pkg.github.com`. Consumers must configure npm to use this registry
for the `@nomli` scope.

### ~/.npmrc scope mapping

Create or edit `~/.npmrc` (in your home directory, **not** in the project):

```
@nomli:registry=https://npm.pkg.github.com
```

This tells npm to resolve any `@nomli/*` package from GitHub Packages instead
of the default npmjs.org registry.

### PAT classic authentication

GitHub Packages requires a **personal access token (classic)** with the
`read:packages` scope. Fine-grained tokens with **only** `packages:read` are
also supported on org-owned repositories if enabled.

1. Go to **GitHub → Settings → Developer settings → Personal access tokens →
   Tokens (classic)**.
2. Generate a new token with the **`read:packages`** scope.
3. Append the following line to `~/.npmrc`:

```
//npm.pkg.github.com/:_authToken=ghp_YOUR_TOKEN_HERE
```

**Security:** Never commit `~/.npmrc` or any file containing a token to version
control. The repository's `.npmrc` contains only the scope-to-registry mapping
and no credentials.

### Verifying the setup

```bash
npm view @nomli/opencode-notify versions
```

If this command lists available versions without an authentication error, the
registry and token are configured correctly.

---

## Installation

### Pinned release version

Install the latest published release:

```bash
npm install @nomli/opencode-notify@<published-version>
```

Always pin to an exact version using `@<published-version>`. Ranges are not
recommended because GitHub Packages may throttle unauthenticated metadata
requests that npm uses during version resolution.

### Local file development

For plugin development against a local checkout, register the package path
directly in your OpenCode plugin entries file
(`~/.config/opencode/plugins.json` or equivalent):

```jsonc
{
  "entries": [
    {
      "id": "@nomli/opencode-notify",
      "name": "opencode-notify",
      "type": "local",
      "path": "/home/user/workspace/opencode-notify/packages/opencode-plugin/dist/index.js"
    }
  ]
}
```

Alternatively, use `npm link` in development:

```bash
cd packages/opencode-plugin
npm link
# In the project consuming the plugin:
npm link @nomli/opencode-notify
```

---

## Update

```bash
# Check current installed version
npm list @nomli/opencode-notify

# View available versions
npm view @nomli/opencode-notify versions

# Install a specific version
npm install @nomli/opencode-notify@0.1.0
```

**Restart required:** OpenCode must be restarted after any plugin
install/update/removal. The plugin subsystem reads installed packages at
startup and does not hot-reload them while OpenCode is running.

---

## Rollback

```bash
npm install @nomli/opencode-notify@<previous-version>
```

Then restart OpenCode.

If the previous version is unknown, check git history or the release page at
`https://github.com/nomli/opencode-notify/releases`.

---

## Pairing

The plugin uses a relay-based pairing flow to associate an OpenCode instance
with a notification target (e.g., Telegram).

1. Enable the relay in the plugin config (`~/.config/opencode/opencode-notify.json`). Do not add a token on first pairing:
   ```jsonc
   {
     "relay": {
       "enabled": true,
        "url": "wss://relay.example.com"
     }
   }
   ```
2. Restart OpenCode. The plugin requests a single-use pairing code from the relay, writes it to the OpenCode process log, and displays a TUI notification with the command to send to Telegram. The notification repeats every 15 seconds while the code remains valid.
3. Send the pairing code to the Telegram bot (`/pair <code>`). If the bot says OpenCode is still connecting, wait a moment and send the same command again.
4. Codes expire after five minutes. The plugin automatically requests a replacement code and displays it without requiring an OpenCode restart.
5. The relay verifies the Telegram user and only then sends a client token through the TLS WebSocket. The plugin persists it in its `0600` configuration file and notifications begin flowing.

### Pairing troubleshooting

| Symptom | Likely cause | Resolution |
|---------|-------------|------------|
| "No pairing code shown" | Relay not enabled or unreachable | Verify `relay.enabled: true` and `relay.url` in config |
| Pairing times out | Network or relay failure | Wait for the replacement pairing code displayed by OpenCode; check relay server logs if it does not appear |
| "Already paired" error | Client ID already associated | Use revocation (see below) |

---

## Client revocation

To revoke a paired client (disable notifications for an OpenCode instance):

```
/revoke <clientId>
```

Send this command to the Telegram bot. The client's token is invalidated and
future connections from that client will be rejected. The OpenCode plugin will
log a `CLIENT_REVOKED` error on next heartbeat.

To pair again after revocation, restart OpenCode and go through the pairing
flow again. A new `clientId` will be generated.

---

## Cache troubleshooting

### npm cache issues

If `npm install` fails with a 401 or E401 error for `@nomli` packages, it may
be because npm cached an unauthenticated response.

```bash
# Clear only the GitHub Packages scope cache
npm cache clean --force

# Or surgically clear the metadata cache
rm -rf ~/.npm/_cacache

# Retry
npm install @nomli/opencode-notify@<published-version>
```

### Plugin load cache

OpenCode may cache plugin resolution results. If a newly installed or updated
plugin does not appear to load:

1. Restart OpenCode.
2. If the issue persists, check that the plugin entry in `plugins.json` is
   correct.
3. Run OpenCode with `--log-level debug` (or equivalent) to inspect plugin
   discovery logs.

### WebSocket connection cache

The relay client maintains a persistent WebSocket connection. If the connection
state appears stale:

1. Restart OpenCode (this tears down and re-establishes the WebSocket).
2. Check that the relay URL is reachable: `curl -I https://relay.example.com`.
3. Verify the client token has not expired or been revoked.

---

## Deploying the relay server

### Published GHCR image

The release workflow publishes the relay server image to
`ghcr.io/mysticalheat/opencode-notify-server`. It does not publish a mutable
`latest` tag. Each GitHub release creates these immutable tags:

- `release-<release-tag>`, for example `release-v0.0.1`.
- `sha-<full-commit-sha>`, for pinning to the exact source commit.

Use a GitHub token with the `read:packages` scope when the image is private:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io --username "$GITHUB_USER" --password-stdin
```

#### Deploy an exact image

Run these commands from a checkout containing `deploy/compose.example.yml`:

```bash
export RELAY_IMAGE_TAG=release-v0.0.1
docker pull "ghcr.io/mysticalheat/opencode-notify-server:$RELAY_IMAGE_TAG"
docker compose -f deploy/compose.example.yml up -d --no-build --force-recreate relay
curl -fsS http://localhost:3000/health/ready
```

Keep the selected `RELAY_IMAGE_TAG` value in the deployment record.

#### Roll back

Select the previous release tag or a known-good full SHA tag, then repeat the
same pull and restart procedure:

```bash
export RELAY_IMAGE_TAG=sha-<known-good-full-commit-sha>
docker pull "ghcr.io/mysticalheat/opencode-notify-server:$RELAY_IMAGE_TAG"
docker compose -f deploy/compose.example.yml up -d --no-build --force-recreate relay
curl -fsS http://localhost:3000/health/ready
```

Review `docker compose -f deploy/compose.example.yml logs --tail=100 relay`
after the restart. The Compose volume is preserved, so the SQLite database and
pairings remain available during an image rollback.

### Container image

Build the image from `apps/server/Dockerfile`:

```bash
docker build -t opencode-notify:latest -f apps/server/Dockerfile .
```

The image runs as a non-root user (`appuser`), uses `tini` as the init
process, and exposes port 3000.  All persistent data (SQLite) lives under
`/data` — mount a volume at this path.

See `deploy/compose.example.yml` for a ready-to-customize Docker Compose
configuration with commented Traefik labels and webhook guidance.

### Backup and restore

Back up the SQLite database with SQLite's backup API rather than copying only
the `.db` file while the server is running: WAL mode may have uncheckpointed
data in adjacent `-wal` and `-shm` files. For the Compose volume, run a backup
from an image that includes `sqlite3`, mounting `relay-data` at `/data`, and
use `.backup '/data/backups/opencode-notify.db'` against
`/data/opencode-notify.db`.

Stop the relay before restoring a backup, replace the database in `/data`, and
then start the relay normally; migrations run safely on startup. Test restores
regularly. A stale backup can restore revoked client tokens and pending outbox
decisions, so revoke affected clients and review pending requests after restore.

### Fake Telegram mode

Set `TELEGRAM_BOT_TOKEN=FAKE` to start the server without a real Telegram
bot.  The HTTP API and WebSocket relay will be active, but no Telegram
messages will be sent or received.  Useful for readiness probes, integration
testing, and smoke tests.

---

## Future: switching from long-polling to webhook

The released server supports **long-polling** only. Webhook configuration and
the handler are scaffolding for a future release; do not follow the procedure
below in production yet.

### When to switch

Webhooks reduce latency and are preferred in production when the relay is
behind a reverse proxy (e.g. Traefik, nginx, Caddy) with a public HTTPS
endpoint.

### Migration procedure

1. **Deploy the server with polling enabled** (default).  Verify it is
   receiving updates normally.

2. **Configure the webhook environment variables** (see
   `apps/server/.env.example`):
   - `WEBHOOK_HOST` — interface to bind the webhook listener on
   - `WEBHOOK_PORT` — port for the webhook listener
   - `TELEGRAM_WEBHOOK_SECRET` — a random secret shared with Telegram

3. **Set up the webhook endpoint on the reverse proxy.**  Expose
   `WEBHOOK_PORT` (default `8443`) on the public hostname.  The webhook
   handler expects the `X-Telegram-Bot-Api-Secret-Token` header.

4. **IMPORTANT: Stop polling before calling `setWebhook`.**  The grammY
   long-polling client and webhook handler must not be active
   simultaneously — concurrent delivery causes duplicate updates and
   undefined behavior.

   At present, the server always starts long-polling.  Webhook mode is not
   yet activated in the application code.  When it is enabled in a future
   release, stopping polling will require a configuration toggle or a
   separate deployment.

5. **Call `setWebhook` on the Telegram Bot API** to register the webhook URL:

   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d "url=https://relay.example.com/telegram/webhook" \
     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
   ```

6. **Verify** the webhook is active:

   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
   ```

   The response should list the pending update count and the configured URL.

7. **Monitor** for errors.  If delivery fails, Telegram will retry with
   exponential backoff.  Check the server logs and adjust firewall/proxy
   rules if needed.

### Rollback to polling

1. Delete the webhook: `curl "https://api.telegram.org/bot<TOKEN>/deleteWebhook?drop_pending_updates=true"`
2. Remove `WEBHOOK_HOST`, `WEBHOOK_PORT`, and `TELEGRAM_WEBHOOK_SECRET`
   from the environment.
3. Restart the server — it will resume long-polling.

Note: `drop_pending_updates=true` discards updates queued during the
transition to avoid replay storms.

---

## Environment variable overrides

See [configuration.md](./configuration.md) for the full configuration
reference. Key env vars for operations:

| Variable | Purpose |
|----------|---------|
| `OPENCODE_NOTIFY_CONFIG_PATH` | Alternate config file location |
| `OPENCODE_NOTIFY_RELAY_URL` | Override relay server URL |
| `OPENCODE_NOTIFY_CLIENT_TOKEN` | Override client bearer token |
| `OPENCODE_NOTIFY_RELAY_ENABLED` | Force relay on/off (`true`/`false`) |
