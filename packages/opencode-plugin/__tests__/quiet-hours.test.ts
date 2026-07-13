import { describe, expect, it, vi, afterEach } from "vitest"
import { inQuietHours } from "../src/notify.js"

describe("inQuietHours", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	function mockTime(hours: number, minutes: number) {
		const date = new Date(2025, 6, 10, hours, minutes, 0, 0)
		vi.setSystemTime(date)
	}

	describe("within-range (e.g., 22:00–08:00)", () => {
		const range = { start: "22:00", end: "08:00" }

		it("returns true during night hours (23:00)", () => {
			mockTime(23, 0)
			expect(inQuietHours(range)).toBe(true)
		})

		it("returns true during early morning (03:00)", () => {
			mockTime(3, 0)
			expect(inQuietHours(range)).toBe(true)
		})

		it("returns true at exact start (22:00)", () => {
			mockTime(22, 0)
			expect(inQuietHours(range)).toBe(true)
		})

		it("returns false at exact end (08:00)", () => {
			mockTime(8, 0)
			expect(inQuietHours(range)).toBe(false)
		})

		it("returns false during day (12:00)", () => {
			mockTime(12, 0)
			expect(inQuietHours(range)).toBe(false)
		})

		it("returns false just before start (21:59)", () => {
			mockTime(21, 59)
			expect(inQuietHours(range)).toBe(false)
		})
	})

	describe("normal range (e.g., 01:00–03:00)", () => {
		const range = { start: "01:00", end: "03:00" }

		it("returns true within range (02:00)", () => {
			mockTime(2, 0)
			expect(inQuietHours(range)).toBe(true)
		})

		it("returns false before range (00:30)", () => {
			mockTime(0, 30)
			expect(inQuietHours(range)).toBe(false)
		})

		it("returns false after range (04:00)", () => {
			mockTime(4, 0)
			expect(inQuietHours(range)).toBe(false)
		})
	})
})
