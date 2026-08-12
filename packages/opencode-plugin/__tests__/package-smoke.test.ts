import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { execSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs"
import { resolve, join } from "node:path"
import { tmpdir } from "node:os"

const pkgDir = resolve(__dirname, "..")
const tmpRoot = join(tmpdir(), `opencode-notify-smoke-${Date.now()}`)
const COMMAND_TIMEOUT_MS = 120_000

beforeAll(() => {
  execSync("npm run build", {
    cwd: pkgDir,
    stdio: "pipe",
    timeout: COMMAND_TIMEOUT_MS,
  })
  mkdirSync(tmpRoot, { recursive: true })
  writeFileSync(
    join(tmpRoot, ".npmrc"),
    "registry=https://registry.npmjs.org/\naudit=false\nfund=false\n",
  )
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

function npmPackFileLines(cwd: string): string[] {
  const output = execSync("npm pack --dry-run 2>&1", {
    cwd,
    encoding: "utf-8",
    shell: "/bin/sh",
    timeout: COMMAND_TIMEOUT_MS,
  })
  const lines = output.split("\n")
  return lines
    .filter((l) => /^npm notice\s+\d+(\.\d+)?\s*k?B\s/.test(l))
    .map((l) => l.replace(/^npm notice\s+\S+\s+/, "").trim())
}

describe("package smoke: npm pack integrity", () => {
  it("npm pack --dry-run lists only publishable files (dist/, README.md, LICENSE, package.json)", () => {
    const files = npmPackFileLines(pkgDir)
    expect(files.length).toBeGreaterThan(0)

    const forbidden = [
      /\bsrc\//,
      /\b__tests__\//,
      /\btest\//,
      /\.test\./i,
      /\.spec\./i,
      /\.tsbuildinfo$/,
      /tsconfig\.json$/,
      /eslint\.config/,
      /tsup\.config/,
      /vitest\.config/,
      /\.db$/,
      /\.sqlite/,
      /\.tgz$/,
      /\.map$/,
      /node_modules\//,
      /\.turbo\//,
      /coverage\//,
      /\.env(?!\.example)/,
    ]

    for (const file of files) {
      for (const pattern of forbidden) {
        expect(file).not.toMatch(pattern)
      }
    }

    const allowed = [/^dist\//, /^package\.json$/, /^README\.md$/, /^LICENSE$/]
    for (const file of files) {
      const isAllowed = allowed.some((p) => p.test(file))
      expect({ file, isAllowed }).toEqual({ file, isAllowed: true })
    }

    const hasDist = files.some((f) => f.startsWith("dist/"))
    expect(hasDist).toBe(true)
  })

  it("npm pack creates tarball, installs in temp project, and imports ESM entry point", () => {
    const packDest = join(tmpRoot, "tarball")
    mkdirSync(packDest, { recursive: true })

    execSync(`npm pack --pack-destination "${packDest}"`, {
      cwd: pkgDir,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: COMMAND_TIMEOUT_MS,
    })

    const tarballEntries = readdirSync(packDest).filter((f) => f.endsWith(".tgz"))
    expect(tarballEntries.length).toBe(1)

    const tarballName = tarballEntries[0]!
    expect(tarballName).toMatch(/opencode-notify-.*\.tgz$/)

    const tarballPath = join(packDest, tarballName)
    expect(existsSync(tarballPath)).toBe(true)

    const testProject = join(tmpRoot, "test-project")
    mkdirSync(testProject, { recursive: true })

    writeFileSync(
      join(testProject, "package.json"),
      JSON.stringify({ name: "smoke-test", private: true, type: "module" }, null, 2),
    )

    execSync(
      `npm install --offline --ignore-scripts --no-audit --no-fund --package-lock=false --legacy-peer-deps "${tarballPath}"`,
      {
        cwd: testProject,
        stdio: "pipe",
        timeout: COMMAND_TIMEOUT_MS,
        env: {
          ...process.env,
          npm_config_userconfig: join(tmpRoot, ".npmrc"),
        },
      },
    )

    const entryMjs = join(testProject, "import-test.mjs")
    writeFileSync(
      entryMjs,
      [
        `import { createNotifyPlugin } from "@nomli/opencode-notify";`,
        `const plugin = createNotifyPlugin();`,
        `if (typeof plugin !== "function") throw new Error("Expected createNotifyPlugin to return a function");`,
        `console.log("ESM import OK");`,
      ].join("\n"),
    )

    const importResult = execSync("node import-test.mjs", {
      cwd: testProject,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: COMMAND_TIMEOUT_MS,
    })

    expect(importResult.trim()).toContain("ESM import OK")
  })
})

describe("package smoke: no source maps with local paths in dist", () => {
  it("dist/ contains no .map files", () => {
    const mapFiles = execSync("find dist -name '*.map' 2>/dev/null || true", {
      cwd: pkgDir,
      encoding: "utf-8",
      timeout: COMMAND_TIMEOUT_MS,
    }).trim()
    expect(mapFiles).toBe("")
  })
})
