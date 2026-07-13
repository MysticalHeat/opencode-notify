import { describe, it, expect } from "vitest"
import {
	loadConfig,
	writeConfig,
	migrateFromOldConfig,
	ensureConfigMode,
	applyEnvOverrides,
	configPath,
	oldConfigPath,
	DEFAULT_CONFIG,
	ConfigError,
	ValidationError,
	type FsAbstraction,
	type OsAbstraction,
	type OpenCodeNotifyConfig,
} from "../src/config.js"

// ── In-memory filesystem ──────────────────────────────────

interface MemEntry {
	content: string
	mode: number
}

function createMemFs(
	initial: Record<string, MemEntry> = {},
	opts?: { failWriteTo?: string; failRenameFrom?: string },
): FsAbstraction & { files: Map<string, MemEntry> } {
	const files = new Map(Object.entries(initial))

	return {
		files,
		async readFile(path: string) {
			const entry = files.get(path)
			if (!entry) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" })
			return entry.content
		},
		async writeFile(path: string, data: string, options?: { mode?: number }) {
			if (opts?.failWriteTo && path.includes(opts.failWriteTo)) {
				throw Object.assign(new Error("Write failed"), { code: "EIO" })
			}
			files.set(path, { content: data, mode: options?.mode ?? 0o600 })
		},
		async stat(path: string) {
			const entry = files.get(path)
			if (!entry) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" })
			return { mode: entry.mode }
		},
		async chmod(path: string, mode: number) {
			const entry = files.get(path)
			if (!entry) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" })
			files.set(path, { content: entry.content, mode })
		},
		async rename(oldPath: string, newPath: string) {
			if (opts?.failRenameFrom && oldPath.includes(opts.failRenameFrom)) {
				throw Object.assign(new Error("Rename failed"), { code: "EIO" })
			}
			const entry = files.get(oldPath)
			if (!entry) throw Object.assign(new Error(`ENOENT: ${oldPath}`), { code: "ENOENT" })
			files.set(newPath, entry)
			files.delete(oldPath)
		},
		async unlink(path: string) {
			files.delete(path)
		},
		async access(path: string) {
			if (!files.has(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" })
		},
		async mkdir(_path: string, _options?: { recursive?: boolean }) {
			void _path
			void _options
		},
	}
}

function createMockOs(homeDir = "/home/testuser"): OsAbstraction {
	return { homedir: () => homeDir }
}

const HOME = "/home/testuser"
const CONFIG_PATH = `${HOME}/.config/opencode/opencode-notify.json`
const OLD_CONFIG_PATH = `${HOME}/.config/opencode/kdco-notify.json`

function jsonEntry(data: unknown, mode = 0o600): MemEntry {
	return { content: JSON.stringify(data, null, 2), mode }
}

// ── loadConfig ────────────────────────────────────────────

describe("loadConfig", () => {
	describe("defaults", () => {
		it("returns DEFAULT_CONFIG when no config file exists", async () => {
			const memfs = createMemFs()
			const os = createMockOs()

			const cfg = await loadConfig({ fs: memfs, os })

			expect(cfg).toEqual(DEFAULT_CONFIG)
		})

		it("uses custom env path when provided", async () => {
			const memfs = createMemFs({
				"/home/testuser/.config/opencode/custom.json": jsonEntry({
					desktop: { notifyChildSessions: true },
				}),
			})
			const os = createMockOs()

			const cfg = await loadConfig({ fs: memfs, os, envPath: "/home/testuser/.config/opencode/custom.json" })

			expect(cfg.desktop?.notifyChildSessions).toBe(true)
		})

		it("rejects env path outside home", async () => {
			const memfs = createMemFs()
			const os = createMockOs()

			await expect(
				loadConfig({ fs: memfs, os, envPath: "/etc/passwd" }),
			).rejects.toThrow(ConfigError)
		})
	})

	describe("partial config", () => {
		it("merges partial relay settings with defaults", async () => {
			const memfs = createMemFs({
				[CONFIG_PATH]: jsonEntry({
					relay: { url: "https://relay.example.com" },
				}),
			})
			const os = createMockOs()

			const cfg = await loadConfig({ fs: memfs, os })

			expect(cfg.relay?.url).toBe("https://relay.example.com")
			expect(cfg.relay?.enabled).toBe(false)
			expect(cfg.relay?.clientMetadata?.sounds?.error).toBe("basso")
			expect(cfg.desktop?.sounds?.error).toBe("basso")
		})

		it("merges partial desktop settings with defaults", async () => {
			const memfs = createMemFs({
				[CONFIG_PATH]: jsonEntry({
					desktop: { notifyChildSessions: true },
				}),
			})
			const os = createMockOs()

			const cfg = await loadConfig({ fs: memfs, os })

			expect(cfg.desktop?.notifyChildSessions).toBe(true)
			expect(cfg.desktop?.sounds?.idle).toBe("default")
			expect(cfg.desktop?.quietHours?.enabled).toBe(false)
		})

		it("preserves custom relay URL while filling defaults", async () => {
			const memfs = createMemFs({
				[CONFIG_PATH]: jsonEntry({
					relay: { url: "wss://ws.example.com", clientToken: "tok" },
				}),
			})
			const os = createMockOs()

			const cfg = await loadConfig({ fs: memfs, os })

			expect(cfg.relay?.url).toBe("wss://ws.example.com")
			expect(cfg.relay?.clientToken).toBe("tok")
			expect(cfg.relay?.enabled).toBe(false)
		})

		it("returns defaults for empty object config", async () => {
			const memfs = createMemFs({
				[CONFIG_PATH]: jsonEntry({}),
			})
			const os = createMockOs()

			const cfg = await loadConfig({ fs: memfs, os })

			expect(cfg).toEqual(DEFAULT_CONFIG)
		})
	})

	describe("malformed JSON", () => {
		it("throws ConfigError for invalid JSON", async () => {
			const memfs = createMemFs({
				[CONFIG_PATH]: { content: "not }}\n valid json", mode: 0o600 },
			})
			const os = createMockOs()

			await expect(loadConfig({ fs: memfs, os })).rejects.toThrow(ConfigError)
		})

		it("throws ConfigError for bare string in config file", async () => {
			const memfs = createMemFs({
				[CONFIG_PATH]: { content: '"just a string"', mode: 0o600 },
			})
			const os = createMockOs()

			await expect(loadConfig({ fs: memfs, os })).rejects.toThrow(ConfigError)
		})

		it("throws ConfigError for numeric config file", async () => {
			const memfs = createMemFs({
				[CONFIG_PATH]: { content: "42", mode: 0o600 },
			})
			const os = createMockOs()

			await expect(loadConfig({ fs: memfs, os })).rejects.toThrow(ConfigError)
		})

		it("throws ValidationError for invalid relay URL type", async () => {
			const memfs = createMemFs({
				[CONFIG_PATH]: jsonEntry({
					relay: { url: 12345 },
				}),
			})
			const os = createMockOs()

			await expect(loadConfig({ fs: memfs, os })).rejects.toThrow(ValidationError)
		})

		it("throws ValidationError for non-https/wss relay URL", async () => {
			const memfs = createMemFs({
				[CONFIG_PATH]: jsonEntry({
					relay: { url: "http://insecure.example.com" },
				}),
			})
			const os = createMockOs()

			await expect(loadConfig({ fs: memfs, os })).rejects.toThrow(ValidationError)
		})

		it("throws ValidationError for invalid relay enabled type", async () => {
			const memfs = createMemFs({
				[CONFIG_PATH]: jsonEntry({
					relay: { enabled: "yes" },
				}),
			})
			const os = createMockOs()

			await expect(loadConfig({ fs: memfs, os })).rejects.toThrow(ValidationError)
		})

		it("throws ValidationError for invalid quiet hours format", async () => {
			const memfs = createMemFs({
				[CONFIG_PATH]: jsonEntry({
					desktop: { quietHours: { start: "25:00" } },
				}),
			})
			const os = createMockOs()

			await expect(loadConfig({ fs: memfs, os })).rejects.toThrow(ValidationError)
		})

		it("throws ValidationError for invalid quiet hours end format", async () => {
			const memfs = createMemFs({
				[CONFIG_PATH]: jsonEntry({
					desktop: { quietHours: { end: "abc" } },
				}),
			})
			const os = createMockOs()

			await expect(loadConfig({ fs: memfs, os })).rejects.toThrow(ValidationError)
		})

		it("throws ValidationError for non-string desktop sound value", async () => {
			const memfs = createMemFs({
				[CONFIG_PATH]: jsonEntry({
					desktop: { sounds: { idle: 123 } },
				}),
			})
			const os = createMockOs()

			await expect(loadConfig({ fs: memfs, os })).rejects.toThrow(ValidationError)
		})

		it("throws ValidationError for non-string relay clientMetadata sound value", async () => {
			const memfs = createMemFs({
				[CONFIG_PATH]: jsonEntry({
					relay: { clientMetadata: { sounds: { error: true } } },
				}),
			})
			const os = createMockOs()

			await expect(loadConfig({ fs: memfs, os })).rejects.toThrow(ValidationError)
		})

		it("throws ValidationError for non-boolean relay quietHours enabled", async () => {
			const memfs = createMemFs({
				[CONFIG_PATH]: jsonEntry({
					relay: { clientMetadata: { quietHours: { enabled: "yes" } } },
				}),
			})
			const os = createMockOs()

			await expect(loadConfig({ fs: memfs, os })).rejects.toThrow(ValidationError)
		})
	})

	describe("token persistence", () => {
		it("preserves relay settings through write/read roundtrip", async () => {
			const memfs = createMemFs()
			const os = createMockOs()
			const original: OpenCodeNotifyConfig = {
				relay: { url: "https://relay.example.com", clientToken: "secret-token", enabled: true },
			}

			await writeConfig(original, { fs: memfs, os })
			const loaded = await loadConfig({ fs: memfs, os })

			expect(loaded.relay?.url).toBe("https://relay.example.com")
			expect(loaded.relay?.clientToken).toBe("secret-token")
			expect(loaded.relay?.enabled).toBe(true)
		})

		it("preserves desktop settings through write/read roundtrip", async () => {
			const memfs = createMemFs()
			const os = createMockOs()
			const original: OpenCodeNotifyConfig = {
				desktop: {
					notifyChildSessions: true,
					sounds: { error: "funk", idle: "glass" },
					quietHours: { enabled: true, start: "23:00", end: "07:00" },
				},
			}

			await writeConfig(original, { fs: memfs, os })
			const loaded = await loadConfig({ fs: memfs, os })

			expect(loaded.desktop?.notifyChildSessions).toBe(true)
			expect(loaded.desktop?.sounds?.error).toBe("funk")
			expect(loaded.desktop?.sounds?.idle).toBe("glass")
			expect(loaded.desktop?.quietHours?.enabled).toBe(true)
			expect(loaded.desktop?.quietHours?.start).toBe("23:00")
			expect(loaded.desktop?.quietHours?.end).toBe("07:00")
		})

		it("roundtrips config with both relay and desktop sections", async () => {
			const memfs = createMemFs()
			const os = createMockOs()
			const original: OpenCodeNotifyConfig = {
				relay: { url: "wss://relay.example.com", clientToken: "tok" },
				desktop: { notifyChildSessions: true },
			}

			await writeConfig(original, { fs: memfs, os })
			const loaded = await loadConfig({ fs: memfs, os })

			expect(loaded.relay?.url).toBe("wss://relay.example.com")
			expect(loaded.relay?.clientToken).toBe("tok")
			expect(loaded.desktop?.notifyChildSessions).toBe(true)
			expect(loaded.relay?.clientMetadata?.sounds?.idle).toBe("default")
		})

		it("includes version field in written config", async () => {
			const memfs = createMemFs()
			const os = createMockOs()

			await writeConfig({}, { fs: memfs, os })
			const raw = memfs.files.get(CONFIG_PATH)?.content

			expect(raw).toBeDefined()
			const parsed = JSON.parse(raw!)
			expect(parsed.version).toBe(1)
		})
	})
})

// ── writeConfig ───────────────────────────────────────────

describe("writeConfig", () => {
	describe("atomic writes", () => {
		it("writes config file with correct content", async () => {
			const memfs = createMemFs()
			const os = createMockOs()

			await writeConfig({ relay: { url: "https://example.com" } }, { fs: memfs, os })

			const entry = memfs.files.get(CONFIG_PATH)
			expect(entry).toBeDefined()
			const parsed = JSON.parse(entry!.content)
			expect(parsed.relay.url).toBe("https://example.com")
		})

		it("ensures 0600 permissions on written file", async () => {
			const memfs = createMemFs()
			const os = createMockOs()

			await writeConfig({}, { fs: memfs, os })

			const entry = memfs.files.get(CONFIG_PATH)
			expect(entry).toBeDefined()
			expect(entry!.mode & 0o777).toBe(0o600)
		})

		it("overwrites existing config atomically", async () => {
			const memfs = createMemFs({
				[CONFIG_PATH]: jsonEntry({ relay: { url: "https://old.example.com" } }),
			})
			const os = createMockOs()

			await writeConfig({ relay: { url: "https://new.example.com" } }, { fs: memfs, os })

			const entry = memfs.files.get(CONFIG_PATH)
			expect(entry).toBeDefined()
			const parsed = JSON.parse(entry!.content)
			expect(parsed.relay.url).toBe("https://new.example.com")
		})

		it("cleans up temp file after successful write", async () => {
			const memfs = createMemFs()
			const os = createMockOs()

			await writeConfig({}, { fs: memfs, os })

			const allPaths = [...memfs.files.keys()]
			const tempFiles = allPaths.filter((p) => p.includes(".tmp"))
			expect(tempFiles).toHaveLength(0)
		})

		it("preserves existing config on write failure", async () => {
			const existingContent = JSON.stringify({ relay: { url: "https://safe.example.com" } }, null, 2)
			const memfs = createMemFs(
				{
					[CONFIG_PATH]: { content: existingContent, mode: 0o600 },
				},
				{ failWriteTo: ".tmp" },
			)
			const os = createMockOs()

			await expect(
				writeConfig({ relay: { url: "https://new.example.com" } }, { fs: memfs, os }),
			).rejects.toThrow()

			const entry = memfs.files.get(CONFIG_PATH)
			expect(entry).toBeDefined()
			expect(entry!.content).toBe(existingContent)
		})

		it("cleans up temp file after write failure", async () => {
			const memfs = createMemFs({}, { failWriteTo: ".tmp" })
			const os = createMockOs()

			await expect(writeConfig({}, { fs: memfs, os })).rejects.toThrow()

			const allPaths = [...memfs.files.keys()]
			const tempFiles = allPaths.filter((p) => p.includes(".tmp"))
			expect(tempFiles).toHaveLength(0)
		})

		it("uses 0600 as default mode in memfs writeFile", async () => {
			const memfs = createMemFs()
			const os = createMockOs()

			await writeConfig({}, { fs: memfs, os })

			const entry = memfs.files.get(CONFIG_PATH)
			expect(entry).toBeDefined()
			expect(entry!.mode & 0o777).toBe(0o600)
		})

		it("creates parent directory when missing", async () => {
			const memfs = createMemFs()
			const os = createMockOs()
			const customPath = "/home/testuser/.config/opencode/nested/deep/config.json"

			await writeConfig({}, { fs: memfs, os, envPath: customPath })

			const entry = memfs.files.get(customPath)
			expect(entry).toBeDefined()
			expect(entry!.mode & 0o777).toBe(0o600)
		})

		it("succeeds when parent directory already exists", async () => {
			const memfs = createMemFs({
				[CONFIG_PATH]: jsonEntry({ version: 1 }),
			})
			const os = createMockOs()

			await writeConfig({ relay: { url: "https://updated.example.com" } }, { fs: memfs, os })

			const entry = memfs.files.get(CONFIG_PATH)
			expect(entry).toBeDefined()
			expect(JSON.parse(entry!.content).relay.url).toBe("https://updated.example.com")
		})

		it("cleans up temp file after rename failure", async () => {
			const memfs = createMemFs({}, { failRenameFrom: ".tmp" })
			const os = createMockOs()

			await expect(writeConfig({}, { fs: memfs, os })).rejects.toThrow()

			const allPaths = [...memfs.files.keys()]
			const tempFiles = allPaths.filter((p) => p.includes(".tmp"))
			expect(tempFiles).toHaveLength(0)
		})
	})

	describe("validation on write", () => {
		it("throws ValidationError when writing invalid relay URL", async () => {
			const memfs = createMemFs()
			const os = createMockOs()

			await expect(
				writeConfig({ relay: { url: "not-a-url" } }, { fs: memfs, os }),
			).rejects.toThrow(ValidationError)
		})

		it("throws ValidationError when writing invalid quiet hours", async () => {
			const memfs = createMemFs()
			const os = createMockOs()

			await expect(
				writeConfig(
					{ desktop: { quietHours: { start: "99:99" } } },
					{ fs: memfs, os },
				),
			).rejects.toThrow(ValidationError)
		})
	})
})

// ── ensureConfigMode ──────────────────────────────────────

describe("ensureConfigMode", () => {
	it("fixes insecure 0644 mode to 0600", async () => {
		const memfs = createMemFs({
			[CONFIG_PATH]: { content: "{}", mode: 0o644 },
		})
		const os = createMockOs()
		const fixed = await ensureConfigMode({ fs: memfs, os })

		expect(fixed).toBe(true)
		const entry = memfs.files.get(CONFIG_PATH)
		expect(entry!.mode & 0o777).toBe(0o600)
	})

	it("fixes world-readable 0644 to 0600", async () => {
		// Mode includes all read bits
		const memfs = createMemFs({
			[CONFIG_PATH]: { content: "{}", mode: 0o644 },
		})
		const os = createMockOs()

		await ensureConfigMode({ fs: memfs, os })
		const entry = memfs.files.get(CONFIG_PATH)
		expect(entry!.mode & 0o777).toBe(0o600)
	})

	it("leaves already-correct 0600 mode unchanged", async () => {
		const memfs = createMemFs({
			[CONFIG_PATH]: { content: "{}", mode: 0o600 },
		})
		const os = createMockOs()
		const fixed = await ensureConfigMode({ fs: memfs, os })

		expect(fixed).toBe(false)
		const entry = memfs.files.get(CONFIG_PATH)
		expect(entry!.mode & 0o777).toBe(0o600)
	})

	it("fixes 0606 (owner+other rw) to 0600", async () => {
		const memfs = createMemFs({
			[CONFIG_PATH]: { content: "{}", mode: 0o606 },
		})
		const os = createMockOs()
		const fixed = await ensureConfigMode({ fs: memfs, os })

		expect(fixed).toBe(true)
		expect(memfs.files.get(CONFIG_PATH)!.mode & 0o777).toBe(0o600)
	})

	it("fixes 0604 (owner rw, other r) to 0600", async () => {
		const memfs = createMemFs({
			[CONFIG_PATH]: { content: "{}", mode: 0o604 },
		})
		const os = createMockOs()
		await ensureConfigMode({ fs: memfs, os })
		expect(memfs.files.get(CONFIG_PATH)!.mode & 0o777).toBe(0o600)
	})

	it("fixes 0666 (all rw) to 0600", async () => {
		const memfs = createMemFs({
			[CONFIG_PATH]: { content: "{}", mode: 0o666 },
		})
		const os = createMockOs()
		const fixed = await ensureConfigMode({ fs: memfs, os })

		expect(fixed).toBe(true)
		expect(memfs.files.get(CONFIG_PATH)!.mode & 0o777).toBe(0o600)
	})

	it("returns false when config file does not exist", async () => {
		const memfs = createMemFs()
		const os = createMockOs()
		const fixed = await ensureConfigMode({ fs: memfs, os })

		expect(fixed).toBe(false)
	})

	it("uses custom env path for mode check", async () => {
		const memfs = createMemFs({
			"/home/testuser/.config/opencode/custom.json": { content: "{}", mode: 0o644 },
		})
		const os = createMockOs()
		const fixed = await ensureConfigMode({ fs: memfs, os, envPath: "/home/testuser/.config/opencode/custom.json" })

		expect(fixed).toBe(true)
		expect(memfs.files.get("/home/testuser/.config/opencode/custom.json")!.mode & 0o777).toBe(0o600)
	})

	it("rejects env path outside home for mode check", async () => {
		const memfs = createMemFs()
		const os = createMockOs()

		await expect(
			ensureConfigMode({ fs: memfs, os, envPath: "/tmp/config.json" }),
		).rejects.toThrow(ConfigError)
	})
})

// ── migrateFromOldConfig ──────────────────────────────────

describe("migrateFromOldConfig", () => {
	it("returns null when old config does not exist", async () => {
		const memfs = createMemFs()
		const os = createMockOs()

		const result = await migrateFromOldConfig({ fs: memfs, os })

		expect(result).toBeNull()
	})

	it("returns null when old config has invalid JSON", async () => {
		const memfs = createMemFs({
			[OLD_CONFIG_PATH]: { content: "not json {{{", mode: 0o600 },
		})
		const os = createMockOs()

		const result = await migrateFromOldConfig({ fs: memfs, os })

		expect(result).toBeNull()
	})

	it("returns null when old config is not an object", async () => {
		const memfs = createMemFs({
			[OLD_CONFIG_PATH]: { content: '"just a string"', mode: 0o600 },
		})
		const os = createMockOs()

		const result = await migrateFromOldConfig({ fs: memfs, os })

		expect(result).toBeNull()
	})

	it("migrates sounds from old config", async () => {
		const memfs = createMemFs({
			[OLD_CONFIG_PATH]: jsonEntry({
				sounds: { idle: "pop", error: "funk" },
			}),
		})
		const os = createMockOs()

		const result = await migrateFromOldConfig({ fs: memfs, os })

		expect(result).not.toBeNull()
		expect(result!.desktop?.sounds?.idle).toBe("pop")
		expect(result!.desktop?.sounds?.error).toBe("funk")
		expect(result!.desktop?.sounds?.permission).toBe("ping")
		expect(result!.desktop?.sounds?.question).toBe("default")
	})

	it("migrates quiet hours from old config", async () => {
		const memfs = createMemFs({
			[OLD_CONFIG_PATH]: jsonEntry({
				quietHours: { enabled: true, start: "23:00", end: "06:00" },
			}),
		})
		const os = createMockOs()

		const result = await migrateFromOldConfig({ fs: memfs, os })

		expect(result).not.toBeNull()
		expect(result!.desktop?.quietHours?.enabled).toBe(true)
		expect(result!.desktop?.quietHours?.start).toBe("23:00")
		expect(result!.desktop?.quietHours?.end).toBe("06:00")
	})

	it("migrates childSessions boolean from old config", async () => {
		const memfs = createMemFs({
			[OLD_CONFIG_PATH]: jsonEntry({ childSessions: true }),
		})
		const os = createMockOs()

		const result = await migrateFromOldConfig({ fs: memfs, os })

		expect(result).not.toBeNull()
		expect(result!.desktop?.notifyChildSessions).toBe(true)
	})

	it("migrates notifyChildSessions boolean from old config", async () => {
		const memfs = createMemFs({
			[OLD_CONFIG_PATH]: jsonEntry({ notifyChildSessions: true }),
		})
		const os = createMockOs()

		const result = await migrateFromOldConfig({ fs: memfs, os })

		expect(result).not.toBeNull()
		expect(result!.desktop?.notifyChildSessions).toBe(true)
	})

	it("maps Telegram settings to relay disabled", async () => {
		const memfs = createMemFs({
			[OLD_CONFIG_PATH]: jsonEntry({
				telegram: { botToken: "123:abc", chatId: "456" },
				sounds: { idle: "pop" },
			}),
		})
		const os = createMockOs()

		const result = await migrateFromOldConfig({ fs: memfs, os })

		expect(result).not.toBeNull()
		expect(result!.relay?.enabled).toBe(false)
		expect(result!.desktop?.sounds?.idle).toBe("pop")
	})

	it("does not modify the old config file", async () => {
		const oldContent = JSON.stringify({ sounds: { idle: "pop" } }, null, 2)
		const memfs = createMemFs({
			[OLD_CONFIG_PATH]: { content: oldContent, mode: 0o600 },
		})
		const os = createMockOs()

		await migrateFromOldConfig({ fs: memfs, os })

		const entry = memfs.files.get(OLD_CONFIG_PATH)
		expect(entry).toBeDefined()
		expect(entry!.content).toBe(oldContent)
		expect(entry!.mode & 0o777).toBe(0o600)
	})

	it("maps sounds into relay clientMetadata", async () => {
		const memfs = createMemFs({
			[OLD_CONFIG_PATH]: jsonEntry({ sounds: { error: "funk" } }),
		})
		const os = createMockOs()

		const result = await migrateFromOldConfig({ fs: memfs, os })

		expect(result!.relay?.clientMetadata?.sounds?.error).toBe("funk")
		expect(result!.relay?.clientMetadata?.sounds?.idle).toBe("default")
	})

	it("maps quiet hours into relay clientMetadata", async () => {
		const memfs = createMemFs({
			[OLD_CONFIG_PATH]: jsonEntry({
				quietHours: { enabled: true, start: "21:00", end: "08:00" },
			}),
		})
		const os = createMockOs()

		const result = await migrateFromOldConfig({ fs: memfs, os })

		expect(result!.relay?.clientMetadata?.quietHours?.enabled).toBe(true)
		expect(result!.relay?.clientMetadata?.quietHours?.start).toBe("21:00")
	})

	it("preserves all other defaults when migrating partial old config", async () => {
		const memfs = createMemFs({
			[OLD_CONFIG_PATH]: jsonEntry({ sounds: { error: "funk" } }),
		})
		const os = createMockOs()

		const result = await migrateFromOldConfig({ fs: memfs, os })

		expect(result!.version).toBe(1)
		expect(result!.desktop?.notifyChildSessions).toBe(false)
		expect(result!.relay?.enabled).toBe(false)
		expect(result!.relay?.clientMetadata?.notifyChildSessions).toBe(false)
	})
})

// ── applyEnvOverrides ─────────────────────────────────────

describe("applyEnvOverrides", () => {
	it("overrides relay URL from env", () => {
		const config = DEFAULT_CONFIG
		const env = { OPENCODE_NOTIFY_RELAY_URL: "https://relay.env.com" }

		const result = applyEnvOverrides(config, env)

		expect(result.relay?.url).toBe("https://relay.env.com")
	})

	it("accepts wss URL from env", () => {
		const config = DEFAULT_CONFIG
		const env = { OPENCODE_NOTIFY_RELAY_URL: "wss://relay.env.com/ws" }

		const result = applyEnvOverrides(config, env)

		expect(result.relay?.url).toBe("wss://relay.env.com/ws")
	})

	it("overrides client token from env", () => {
		const config = DEFAULT_CONFIG
		const env = { OPENCODE_NOTIFY_CLIENT_TOKEN: "env-secret-token" }

		const result = applyEnvOverrides(config, env)

		expect(result.relay?.clientToken).toBe("env-secret-token")
	})

	it("overrides relay enabled from env (true)", () => {
		const config = DEFAULT_CONFIG
		const env = { OPENCODE_NOTIFY_RELAY_ENABLED: "true" }

		const result = applyEnvOverrides(config, env)

		expect(result.relay?.enabled).toBe(true)
	})

	it("overrides relay enabled from env (1)", () => {
		const config = DEFAULT_CONFIG
		const env = { OPENCODE_NOTIFY_RELAY_ENABLED: "1" }

		const result = applyEnvOverrides(config, env)

		expect(result.relay?.enabled).toBe(true)
	})

	it("overrides relay enabled from env (false)", () => {
		const cfg: OpenCodeNotifyConfig = {
			...DEFAULT_CONFIG,
			relay: { ...DEFAULT_CONFIG.relay!, enabled: true },
		}
		const env = { OPENCODE_NOTIFY_RELAY_ENABLED: "false" }

		const result = applyEnvOverrides(cfg, env)

		expect(result.relay?.enabled).toBe(false)
	})

	it("throws ValidationError for invalid URL in env", () => {
		const config = DEFAULT_CONFIG
		const env = { OPENCODE_NOTIFY_RELAY_URL: "not-a-url" }

		expect(() => applyEnvOverrides(config, env)).toThrow(ValidationError)
	})

	it("throws ValidationError for http URL in env", () => {
		const config = DEFAULT_CONFIG
		const env = { OPENCODE_NOTIFY_RELAY_URL: "http://insecure.com" }

		expect(() => applyEnvOverrides(config, env)).toThrow(ValidationError)
	})

	it("does not modify config when env vars are absent", () => {
		const result = applyEnvOverrides(DEFAULT_CONFIG, {})

		expect(result).toEqual(DEFAULT_CONFIG)
	})

	it("does not modify original config object", () => {
		const config = DEFAULT_CONFIG
		const env = { OPENCODE_NOTIFY_RELAY_URL: "https://new.example.com" }

		const result = applyEnvOverrides(config, env)

		expect(config.relay?.url).toBeUndefined()
		expect(result.relay?.url).toBe("https://new.example.com")
	})

	it("allows all three env vars together", () => {
		const config = DEFAULT_CONFIG
		const env = {
			OPENCODE_NOTIFY_RELAY_URL: "wss://full.example.com",
			OPENCODE_NOTIFY_CLIENT_TOKEN: "full-token",
			OPENCODE_NOTIFY_RELAY_ENABLED: "true",
		}

		const result = applyEnvOverrides(config, env)

		expect(result.relay?.url).toBe("wss://full.example.com")
		expect(result.relay?.clientToken).toBe("full-token")
		expect(result.relay?.enabled).toBe(true)
	})

	it("ignores empty string env vars", () => {
		const config = DEFAULT_CONFIG
		const env = {
			OPENCODE_NOTIFY_RELAY_URL: "   ",
			OPENCODE_NOTIFY_CLIENT_TOKEN: "",
		}

		const result = applyEnvOverrides(config, env)

		expect(result.relay?.url).toBeUndefined()
		expect(result.relay?.clientToken).toBeUndefined()
	})
})

// ── configPath ────────────────────────────────────────────

describe("configPath", () => {
	it("returns default path in homedir", () => {
		const os = createMockOs()
		const path = configPath(os)

		expect(path).toBe(CONFIG_PATH)
	})

	it("uses env path override under home", () => {
		const os = createMockOs()
		const path = configPath(os, "/home/testuser/.config/opencode/custom.json")

		expect(path).toBe("/home/testuser/.config/opencode/custom.json")
	})

	it("uses env path override at home root", () => {
		const os = createMockOs()
		const path = configPath(os, "/home/testuser/my-config.json")

		expect(path).toBe("/home/testuser/my-config.json")
	})

	it("rejects env path outside home directory", () => {
		const os = createMockOs()
		expect(() => configPath(os, "/etc/config.json")).toThrow(ConfigError)
	})

	it("rejects env path in /tmp", () => {
		const os = createMockOs()
		expect(() => configPath(os, "/tmp/config.json")).toThrow(ConfigError)
	})

	it("rejects env path using traversal outside home", () => {
		const os = createMockOs()
		expect(() => configPath(os, "/home/testuser/../../etc/config.json")).toThrow(ConfigError)
	})
})

// ── oldConfigPath ─────────────────────────────────────────

describe("oldConfigPath", () => {
	it("returns old config path in homedir", () => {
		const os = createMockOs()
		const path = oldConfigPath(os)

		expect(path).toBe(OLD_CONFIG_PATH)
	})
})

// ── Error types ───────────────────────────────────────────

describe("ConfigError", () => {
	it("is an instance of Error", () => {
		const err = new ConfigError("test")
		expect(err).toBeInstanceOf(Error)
		expect(err.name).toBe("ConfigError")
		expect(err.message).toBe("test")
	})
})

describe("ValidationError", () => {
	it("is an instance of Error", () => {
		const err = new ValidationError("test")
		expect(err).toBeInstanceOf(Error)
		expect(err.name).toBe("ValidationError")
		expect(err.message).toBe("test")
	})
})

// ── deepMerge edge cases ──────────────────────────────────

describe("loadConfig edge cases", () => {
	it("handles deeply nested partial objects", async () => {
		const memfs = createMemFs({
			[CONFIG_PATH]: jsonEntry({
				relay: {
					clientMetadata: { sounds: { error: "custom" } },
				},
			}),
		})
		const os = createMockOs()

		const cfg = await loadConfig({ fs: memfs, os })

		expect(cfg.relay?.clientMetadata?.sounds?.error).toBe("custom")
		expect(cfg.relay?.clientMetadata?.sounds?.idle).toBe("default")
	})

	it("does not include undefined keys from partial objects", async () => {
		const memfs = createMemFs({
			[CONFIG_PATH]: jsonEntry({
				desktop: { sounds: {} },
			}),
		})
		const os = createMockOs()

		const cfg = await loadConfig({ fs: memfs, os })

		expect(cfg.desktop?.sounds?.error).toBe("basso")
	})

	it("loads config with only version field", async () => {
		const memfs = createMemFs({
			[CONFIG_PATH]: jsonEntry({ version: 1 }),
		})
		const os = createMockOs()

		const cfg = await loadConfig({ fs: memfs, os })

		expect(cfg).toEqual(DEFAULT_CONFIG)
	})
})
