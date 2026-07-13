export { createNotifyPlugin } from "./notify.js"
export {
	normalizeEventType,
	dedupeKey,
	createDedupeTracker,
	inQuietHours,
	shouldSkipChildSession,
	getSessionMetadata,
	summarizeEvent,
	buildContext,
} from "./notify.js"
export {
	sendDesktopNotification,
	sendNotificationWithFallback,
	sendCmuxNotification,
	canUseCmuxNotification,
	buildCmuxNotifyArgs,
	CMUX_NOTIFY_TIMEOUT_MS,
} from "./backend.js"
export {
	shouldSuppressForFocus,
	detectTerminalInfo,
	isTerminalFocused,
	getBundleId,
	getFrontmostApp,
} from "./focus.js"
export { TimeoutError, withTimeout } from "./timeout.js"
export type {
	NotifyPluginConfig,
	NotifyEventType,
	PluginEventType,
	NotifySoundConfig,
	QuietHoursConfig,
	CmuxNotificationPayload,
	DesktopNotificationOptions,
	NotifyDeps,
	EventLike,
	SessionMetadata,
	ResolveExecutable,
	SpawnProcess,
	EnvironmentVariables,
	ChildProcessLike,
	OpencodeClient,
	TerminalInfo,
	TerminalDetectDeps,
	RunCommand,
} from "./types.js"
