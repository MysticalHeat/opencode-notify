#!/usr/bin/env bash
set -euo pipefail

PACKAGE="@nomli/opencode-notify"
REGISTRY="https://registry.npmjs.org"

if ! command -v opencode >/dev/null 2>&1; then
  for candidate in "$HOME"/.nvm/versions/node/*/bin; do
    if [ -x "$candidate/opencode" ]; then
      export PATH="$candidate:$PATH"
      break
    fi
  done
fi

command -v opencode >/dev/null 2>&1 || {
  echo "opencode is not on PATH. Set PATH or install OpenCode first." >&2
  exit 1
}

if pgrep -u "$(id -u)" -x opencode >/dev/null; then
  echo "OpenCode is running; update deferred."
  exit 0
fi

latest="$(npm view "$PACKAGE" version --registry="$REGISTRY")"
current="$(node -e '
  const { readFileSync } = require("node:fs");
  const path = require("node:path");
  const source = readFileSync(path.join(process.env.HOME, ".config", "opencode", "opencode.json"), "utf8");
  const match = source.match(/@nomli\/opencode-notify@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  process.stdout.write(match?.[1] ?? "");
')"

if [ "$latest" = "$current" ]; then
  echo "OpenCode plugin is already at $latest."
  exit 0
fi

# The package moved from GitHub Packages to the public npm registry.
npm config delete @nomli:registry --location=user || true

# OpenCode downloads the package before modifying its config.
opencode plugin "$PACKAGE@$latest" --global --force
node scripts/migrate-opencode-plugin-config.mjs "$latest"
echo "Installed $PACKAGE@$latest. It will load on the next OpenCode start."
