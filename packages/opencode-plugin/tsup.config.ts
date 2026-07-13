import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: false,
  noExternal: [/@repo\/protocol/, /@repo\/core/],
  external: [
    "@opencode-ai/plugin",
    "@opencode-ai/sdk",
    "@opencode-ai/sdk/v2",
    "node-notifier",
  ],
  outDir: "dist",
})
