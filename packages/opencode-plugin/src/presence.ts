import { mkdtemp, lstat, mkdir, rm, writeFile } from "node:fs/promises"
import { lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createServer, type Server, type Socket } from "node:net"

export type PresenceFocus = "focused" | "blurred" | "unknown"
export type PresenceStatus = "focused" | "not-focused" | "unknown"
export interface PresenceSnapshot { focus: PresenceFocus; sessionId: string | null }
export interface PresenceBrokerOptions { socketPath?: string; ttlMs?: number; maxClients?: number }

/** A socket path must live directly inside a private, user-owned directory. */
async function checkDirectory(path: string): Promise<void> {
	const stat = await lstat(path)
	if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
		throw new Error("Presence socket directory must be private and owned by the current user")
	}
}

// The private registry contains one record per broker, never one mutable record per URL.
// Multiple records are intentionally ambiguous, including records left by a crashed server.
function registryDirectory(): string {
	return join(tmpdir(), `oc-notify-presence-${process.getuid?.() ?? "unsupported"}`)
}

function safeDirectory(path: string): boolean {
	try {
		const stat = lstatSync(path)
		return stat.isDirectory() && (stat.mode & 0o077) === 0 && !!process.getuid && stat.uid === process.getuid()
	} catch { return false }
}

function namespace(): string | undefined {
	try { const stat = statSync("/proc/self/ns/net"); return `${stat.dev}:${stat.ino}` } catch { return undefined }
}

/** Confirm that this process actually owns the IPv4 loopback listener, rather than OpenCode's fallback URL. */
function ownsListener(port: number): boolean | undefined {
	try {
		const inodes = new Set(readdirSync("/proc/self/fd").flatMap(fd => {
			try { const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/self/fd/${fd}`)); return match ? [match[1]!] : [] } catch { return [] }
		}))
		return readFileSync("/proc/net/tcp", "utf8").split("\n").some(line => {
			const fields = line.trim().split(/\s+/)
			const [address, rawPort] = (fields[1] ?? "").split(":")
			return fields[3] === "0A" && (address === "0100007F" || address === "00000000") && parseInt(rawPort ?? "", 16) === port && inodes.has(fields[9] ?? "")
		})
	} catch { return undefined }
}

function discoveryKey(kind: string, directory: string): string {
	return createHash("sha256").update(JSON.stringify([kind, directory])).digest("hex")
}

/** Return an identity only for transports we can distinguish safely. */
export function tuiPresenceKey(baseUrl: unknown, directory: unknown): string | undefined {
	if (typeof baseUrl !== "string" || typeof directory !== "string" || !directory.startsWith("/")) return
	try {
		const url = new URL(baseUrl)
		if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return
		if (url.href === "http://opencode.internal/") return discoveryKey(`internal:${process.pid}`, directory)
		const ns = namespace()
		if (url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port && ns) return discoveryKey(`http:${ns}:${url.port}`, directory)
	} catch { /* unavailable */ }
}

function serverPresenceKey(serverUrl: URL, directory: string): { key: string; valid: () => boolean } | undefined {
	if (!directory?.startsWith("/")) return
	if (serverUrl.href === "http://localhost:4096/" && ownsListener(4096) === false) {
		return { key: discoveryKey(`internal:${process.pid}`, directory), valid: () => ownsListener(4096) === false }
	}
	const key = tuiPresenceKey(serverUrl.href, directory)
	if (!key || serverUrl.hostname !== "127.0.0.1") return
	const port = Number(serverUrl.port)
	if (!ownsListener(port)) return
	return { key, valid: () => ownsListener(port) === true }
}

/** Read exactly one registration; never guess when discovery is ambiguous. */
export function discoverPresence(key: string): string | undefined {
	try {
		const dir = registryDirectory()
		if (!/^[a-f0-9]{64}$/.test(key) || !safeDirectory(dir)) return
		const files = readdirSync(dir).filter(name => name.startsWith(`${key}-`) && name.endsWith(".json"))
		if (files.length !== 1) return
		const path = join(dir, files[0]!)
		const stat = lstatSync(path)
		if (!stat.isFile() || stat.size > 2048 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) return
		const socketPath: unknown = JSON.parse(readFileSync(path, "utf8")).socketPath
		if (typeof socketPath !== "string" || !socketPath.startsWith("/") || !safeDirectory(dirname(socketPath))) return
		return socketPath
	} catch { return }
}

export async function registerPresence(broker: PresenceBroker, serverUrl: URL, directory: string): Promise<{ isActive(sessionId: string): boolean; close(): Promise<void> } | undefined> {
	const identity = serverPresenceKey(serverUrl, directory)
	if (!identity || !process.getuid) return
	const dir = registryDirectory()
	await mkdir(dir, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error })
	await checkDirectory(dir)
	const record = join(dir, `${identity.key}-${randomUUID()}.json`)
	try { await writeFile(record, JSON.stringify({ socketPath: broker.socketPath }), { flag: "wx", mode: 0o600 }) }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") await rm(record, { force: true }).catch(() => {})
		throw error
	}
	let closed = false
	return {
		isActive(sessionId) { return !closed && identity.valid() && discoverPresence(identity.key) === broker.socketPath && broker.status(sessionId) === "focused" },
		async close() { if (closed) return; closed = true; await rm(record, { force: true }) },
	}
}

function validSnapshot(value: unknown): value is PresenceSnapshot {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const data = value as Record<string, unknown>
	return (data.focus === "focused" || data.focus === "blurred" || data.focus === "unknown") &&
		(data.sessionId === null || (typeof data.sessionId === "string" && data.sessionId.length > 0 && data.sessionId.length <= 512))
}

/** Each connection represents one TUI. A stale, disconnected or malformed client cannot suppress notifications. */
export class PresenceBroker {
	readonly socketPath: string
	private readonly server: Server
	private readonly clients = new Map<Socket, { snapshot?: PresenceSnapshot; updated: number }>()
	private readonly ttlMs: number
	private readonly maxClients: number
	private readonly ownedDirectory?: string
	private closed = false

	private constructor(path: string, options: PresenceBrokerOptions, ownedDirectory?: string) {
		this.socketPath = path
		this.ttlMs = options.ttlMs ?? 15_000
		this.maxClients = options.maxClients ?? 64
		this.ownedDirectory = ownedDirectory
		this.server = createServer(socket => this.accept(socket))
		// Errors after startup must not terminate the host process.
		this.server.on("error", () => {})
	}

	static async start(options: PresenceBrokerOptions = {}): Promise<PresenceBroker> {
		if (!Number.isFinite(options.ttlMs ?? 15_000) || (options.ttlMs ?? 15_000) <= 0 || !Number.isInteger(options.maxClients ?? 64) || (options.maxClients ?? 64) < 1) throw new Error("Invalid presence broker options")
		const ownedDirectory = options.socketPath ? undefined : await mkdtemp(join(tmpdir(), "oc-presence-"))
		const path = options.socketPath ?? join(ownedDirectory!, "socket")
		try {
			await checkDirectory(dirname(path))
			const broker = new PresenceBroker(path, options, ownedDirectory)
			await new Promise<void>((resolve, reject) => {
				const fail = (error: Error) => reject(error)
				broker.server.once("error", fail)
				broker.server.listen(path, () => { broker.server.off("error", fail); resolve() })
			})
			return broker
		} catch (error) {
			if (ownedDirectory) await rm(ownedDirectory, { recursive: true, force: true })
			throw error
		}
	}

	private accept(socket: Socket): void {
		if (this.closed || this.clients.size >= this.maxClients) { socket.destroy(); return }
		this.clients.set(socket, { updated: 0 })
		let buffer = ""
		socket.setEncoding("utf8")
		socket.on("error", () => {})
		socket.on("close", () => this.clients.delete(socket))
		socket.on("data", chunk => {
			buffer += chunk
			if (buffer.length > 4096) { socket.destroy(); this.clients.delete(socket); return }
			let end: number
			while ((end = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, end)
				buffer = buffer.slice(end + 1)
				try {
					const message: unknown = JSON.parse(line)
					if (!validSnapshot(message)) throw new Error("Invalid presence message")
					this.clients.set(socket, { snapshot: message, updated: Date.now() })
				} catch { this.clients.delete(socket); socket.destroy(); return }
			}
		})
	}

	status(sessionId: string): PresenceStatus {
		if (!sessionId || this.closed) return "unknown"
		let known = false
		let unknown = false
		for (const { snapshot, updated } of this.clients.values()) {
			if (!snapshot || Date.now() - updated >= this.ttlMs || snapshot.focus === "unknown") { unknown = true; continue }
			known = true
			if (snapshot.focus === "focused" && snapshot.sessionId === sessionId) return "focused"
		}
		return known && !unknown ? "not-focused" : "unknown"
	}

	async close(): Promise<void> {
		if (this.closed) return
		this.closed = true
		for (const socket of this.clients.keys()) socket.destroy()
		this.clients.clear()
		await new Promise<void>(resolve => this.server.close(() => resolve()))
		if (this.ownedDirectory) await rm(this.ownedDirectory, { recursive: true, force: true })
	}
}
