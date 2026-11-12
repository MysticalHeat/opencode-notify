# @nomli/opencode-notify

OpenCode plugin for cross-platform desktop notifications.

## Install

```bash
npm install @nomli/opencode-notify
```

Requires `@opencode-ai/plugin` and `@opencode-ai/sdk` as peer dependencies (provided by OpenCode runtime).

Repository: [MysticalHeat/opencode-notify](https://github.com/MysticalHeat/opencode-notify)

## Usage

```js
import { createNotifyPlugin } from "@nomli/opencode-notify"

const plugin = createNotifyPlugin({
  sounds: { idle: "default", error: "basso" },
})

export default plugin
```

## Notification timing and presence

By default, idle notifications wait 7 seconds and are cancelled if the session becomes busy or a new user message arrives; they are suppressed if the session is confirmed active at the deadline. Questions and permissions wait at least 10 seconds. When the session is confirmed active, they remain pending until it is no longer confirmed active, up to 30 seconds from the original event. Errors are immediate. Repeated events do not restart the delay, and matching replies or rejections cancel pending requests and are forwarded to the relay.

The shared desktop and relay scheduling delays can be set in the existing configuration file, under `desktop.delays`:

```json
{
  "desktop": {
    "delays": { "idleMs": 7000, "requestMs": 10000, "activeMaxMs": 30000 }
  }
}
```

Each value is an integer in milliseconds between 0 and 2147483647. `activeMaxMs` is measured from the original request event and must be at least `requestMs`. Fields may be omitted to use their defaults; existing configurations need no changes. The same `delays` object can be passed directly to `createNotifyPlugin`.

Integrators can provide session presence through `createNotifyPlugin(config, { presence: { isActive(sessionId) { ... } } })`. The callback is synchronous: return `true` only when the specific session is confirmed active, `false` when known inactive, or `undefined` when unknown. Missing callbacks, unknown values and exceptions fail open. While a request is pending after 10 seconds, presence is polled once per second. For example, a `PresenceBroker` can be adapted with `isActive: id => broker.status(id) === "focused"`.

The default runtime also supports a companion TUI plugin, registered separately in `tui.json`, for local session-presence detection. For a local checkout, add the absolute path to `packages/opencode-plugin/dist/tui.js` to its `plugin` array; published packages can use `@nomli/opencode-notify/tui`. Restart OpenCode after registration. Presence detection requires a supported local transport and terminal focus reporting. Remote, ambiguous, and unknown connections fail open and continue to receive notifications. The existing relay protocol carries actionable questions and permissions, not idle or error notifications. Request matching depends on session and request IDs (or a shared tool call ID); events without matching identifiers cannot reliably be correlated.
