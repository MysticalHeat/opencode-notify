import { describe, expect, it } from "vitest"
import { TimeoutError, withTimeout } from "../src/timeout.js"

describe("TimeoutError", () => {
	it("has name TimeoutError", () => {
		const error = new TimeoutError("test", 100)
		expect(error.name).toBe("TimeoutError")
		expect(error.timeoutMs).toBe(100)
		expect(error.message).toBe("test")
	})

	it("is instanceof Error", () => {
		const error = new TimeoutError("test", 100)
		expect(error).toBeInstanceOf(Error)
	})

	it("is instanceof TimeoutError", () => {
		const error = new TimeoutError("test", 100)
		expect(error).toBeInstanceOf(TimeoutError)
	})
})

describe("withTimeout", () => {
	it("resolves when promise completes before timeout", async () => {
		const result = await withTimeout(Promise.resolve(42), 5000)
		expect(result).toBe(42)
	})

	it("rejects with TimeoutError when promise takes too long", async () => {
		await expect(withTimeout(new Promise(() => {}), 5)).rejects.toBeInstanceOf(TimeoutError)
	})

	it("rejects with custom message", async () => {
		await expect(withTimeout(new Promise(() => {}), 5, "custom timeout")).rejects.toThrow("custom timeout")
	})

	it("rejects immediately for zero timeout", async () => {
		await expect(withTimeout(new Promise(() => {}), 0)).rejects.toBeInstanceOf(TimeoutError)
	})

	it("throws for negative timeout", async () => {
		await expect(withTimeout(Promise.resolve(1), -1)).rejects.toThrow("non-negative number")
	})

	it("propagates promise rejection", async () => {
		await expect(withTimeout(Promise.reject(new Error("original")), 5000)).rejects.toThrow("original")
	})
})
