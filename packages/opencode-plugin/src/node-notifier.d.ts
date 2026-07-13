declare module "node-notifier" {
	const notifier: {
		notify(options: Record<string, unknown>, callback?: (error: unknown) => void): void
	}
	export default notifier
}
