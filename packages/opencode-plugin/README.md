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
