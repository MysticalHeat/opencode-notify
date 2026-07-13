export class TimeoutError extends Error {
	readonly name = "TimeoutError" as const
	readonly timeoutMs: number

	constructor(message: string, timeoutMs: number) {
		super(message)
		this.timeoutMs = timeoutMs
	}
}

export async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	message = "Operation timed out",
): Promise<T> {
	if (typeof ms !== "number" || ms < 0) {
		throw new Error(`withTimeout: timeout must be a non-negative number, got ${ms}`)
	}

	if (ms === 0) {
		throw new TimeoutError(message, ms)
	}

	let timeoutId: ReturnType<typeof setTimeout>
	return Promise.race([
		promise.finally(() => clearTimeout(timeoutId)),
		new Promise<never>((_, reject) => {
			timeoutId = setTimeout(() => {
				reject(new TimeoutError(message, ms))
			}, ms)
		}),
	])
}
