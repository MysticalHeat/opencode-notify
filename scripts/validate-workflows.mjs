import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflowsDir = join(__dirname, "..", ".github", "workflows");

const files = readdirSync(workflowsDir).filter((f) =>
  f.endsWith(".yml") || f.endsWith(".yaml"),
);

if (files.length === 0) {
  console.error("No workflow files found in", workflowsDir);
  process.exit(1);
}

let errors = 0;

for (const file of files) {
  const path = join(workflowsDir, file);
  const content = readFileSync(path, "utf8");
  const issues = [];

  if (content.includes("\t")) {
    issues.push("contains tab characters (use spaces)");
  }
  if (content.includes("\r")) {
    issues.push("contains CR characters (use LF line endings)");
  }

  const lines = content.split("\n");
  const trailing = lines.filter((l) => /\s+$/.test(l) && l.trim().length > 0);
  if (trailing.length > 0) {
    const nums = [];
    for (let i = 0; i < lines.length; i++) {
      if (/\s+$/.test(lines[i]) && lines[i].trim().length > 0) {
        nums.push(i + 1);
      }
    }
    issues.push(
      `trailing whitespace on lines: ${nums.slice(0, 5).join(", ")}${nums.length > 5 ? "..." : ""}`,
    );
  }

  if (issues.length > 0) {
    console.error(`FAIL: ${file}`);
    for (const issue of issues) {
      console.error(`  - ${issue}`);
    }
    errors++;
  } else {
    console.log(`OK: ${file}`);
  }
}

if (errors > 0) {
  console.error(`\n${errors} workflow file(s) have issues.`);
  process.exit(1);
} else {
  console.log(`\nAll ${files.length} workflow file(s) passed validation.`);
}
