import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { applyEdits, modify, parse } from "jsonc-parser";

const packageName = "@nomli/opencode-notify";
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("Usage: node scripts/migrate-opencode-plugin-config.mjs <exact-version>");
}

const configPath =
  process.env.OPENCODE_CONFIG_PATH ?? join(homedir(), ".config", "opencode", "opencode.json");
const source = readFileSync(configPath, "utf8");
const errors = [];
const config = parse(source, errors, { allowTrailingComma: true });
if (errors.length > 0 || !config || typeof config !== "object" || Array.isArray(config)) {
  throw new Error(`Cannot safely update invalid JSONC config: ${configPath}`);
}

const plugin = Array.isArray(config.plugin) ? config.plugin : [];
const next = plugin.filter((item) => {
  const spec = Array.isArray(item) ? item[0] : item;
  return typeof spec !== "string" || !spec.startsWith("file://") || !spec.includes("opencode-notify");
});

const replacement = `${packageName}@${version}`;
const existing = next.findIndex((item) => {
  const spec = Array.isArray(item) ? item[0] : item;
  return typeof spec === "string" && (spec === packageName || spec.startsWith(`${packageName}@`));
});
if (existing === -1) next.push(replacement);
else if (Array.isArray(next[existing])) next[existing][0] = replacement;
else next[existing] = replacement;

const edits = modify(source, ["plugin"], next, {
  formattingOptions: { insertSpaces: true, tabSize: 2 },
});
if (edits.length === 0) process.exit(0);

const backupPath = `${configPath}.bak.${Date.now()}`;
copyFileSync(configPath, backupPath);
writeFileSync(configPath, applyEdits(source, edits), "utf8");
console.log(`Updated ${configPath}; backup: ${backupPath}`);
