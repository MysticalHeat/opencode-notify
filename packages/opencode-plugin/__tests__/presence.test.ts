import { EventEmitter } from "node:events"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createConnection, type Socket } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PresenceBroker } from "../src/presence.js"
import { startPresenceTui, type PresenceTuiApi } from "../src/tui.js"

const brokers: PresenceBroker[] = []
const stops: (() => void)[] = []
const sockets: Socket[] = []
const dirs: string[] = []
afterEach(async () => {
	for (const stop of stops.splice(0)) stop()
	for (const socket of sockets.splice(0)) socket.destroy()
	for (const broker of brokers.splice(0)) await broker.close()
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function broker(options?: Parameters<typeof PresenceBroker.start>[0]) {
	const instance = await PresenceBroker.start(options)
	brokers.push(instance)
	return instance
}
async function client(path: string) {
	const socket = createConnection(path)
	sockets.push(socket)
	await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject) })
	return socket
}
function report(socket: Socket, focus: string, sessionId: string | null) { socket.write(`${JSON.stringify({ focus, sessionId })}\n`) }

describe("presence broker", () => {
	it("isolates servers and aggregates clients, expiring stale reports and failing open", async () => {
		const a = await broker({ ttlMs: 100 })
		const b = await broker()
		expect(a.socketPath).not.toBe(b.socketPath)
		expect((await stat(join(a.socketPath, ".."))).mode & 0o777).toBe(0o700)
		const one = await client(a.socketPath)
		const two = await client(a.socketPath)
		report(one, "focused", "one")
		report(two, "blurred", "two")
		await vi.waitFor(() => expect(a.status("one")).toBe("focused"))
		expect(a.status("two")).toBe("not-focused")
		expect(b.status("one")).toBe("unknown")
		report(two, "unknown", "two")
		await vi.waitFor(() => expect(a.status("two")).toBe("unknown"))
		await vi.waitFor(() => expect(a.status("one")).toBe("unknown"))
		report(one, "focused", "one")
		await vi.waitFor(() => expect(a.status("one")).toBe("focused"))
		one.destroy()
		await vi.waitFor(() => expect(a.status("one")).toBe("unknown"))
	})

	it("rejects unsafe paths and never replaces an existing socket or file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "presence-test-")); dirs.push(dir)
		const path = join(dir, "socket")
		await writeFile(path, "keep")
		await expect(PresenceBroker.start({ socketPath: path })).rejects.toThrow()
		expect((await stat(path)).isFile()).toBe(true)
		await expect(PresenceBroker.start({ socketPath: join(tmpdir(), "unsafe-presence.sock") })).rejects.toThrow(/private/)
	})

	it("drops malformed messages and oversized frames", async () => {
		const instance = await broker()
		const socket = await client(instance.socketPath)
		report(socket, "focused", "a")
		await vi.waitFor(() => expect(instance.status("a")).toBe("focused"))
		socket.write(`${"x".repeat(4097)}\n`)
		await vi.waitFor(() => expect(instance.status("a")).toBe("unknown"))
	})
})

describe("TUI companion", () => {
	it("tracks terminal focus and route, reconnects, and disposes listeners", async () => {
		const dir = await mkdtemp(join(tmpdir(), "presence-test-")); dirs.push(dir)
		const path = join(dir, "socket")
		const renderer = new EventEmitter()
		const controller = new AbortController()
		const route: PresenceTuiApi["route"] = { current: { name: "session", params: { sessionID: "a" } } }
		const api: PresenceTuiApi = { renderer, route, lifecycle: { signal: controller.signal, onDispose: () => {} } }
		stops.push(startPresenceTui(api, { socketPath: path, pollMs: 10, heartbeatMs: 30, reconnectMs: 10 }))
		const first = await broker({ socketPath: path, ttlMs: 150 })
		renderer.emit("focus")
		await vi.waitFor(() => expect(first.status("a")).toBe("focused"))
		Object.assign(route, { current: { name: "session", params: { sessionID: "b" } } })
		await vi.waitFor(() => expect(first.status("b")).toBe("focused"))
		renderer.emit("blur")
		await vi.waitFor(() => expect(first.status("b")).toBe("not-focused"))
		await first.close()
		const second = await broker({ socketPath: path, ttlMs: 150 })
		await new Promise(resolve => setTimeout(resolve, 50))
		expect(second.status("b")).toBe("unknown")
		renderer.emit("focus")
		await vi.waitFor(() => expect(second.status("b")).toBe("focused"))
		controller.abort()
		await vi.waitFor(() => expect(second.status("b")).toBe("unknown"))
		expect(renderer.listenerCount("focus")).toBe(0)
	})
})
