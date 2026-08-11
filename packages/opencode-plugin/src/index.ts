export { createNotifyPlugin } from "./notify.js"
export { OpenCodeNotifyPlugin } from "./runtime.js"
export { default } from "./runtime.js"
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
export {
	configPath,
	oldConfigPath,
	loadConfig,
	writeConfig,
	migrateFromOldConfig,
	ensureConfigMode,
	applyEnvOverrides,
	DEFAULT_CONFIG as DEFAULT_PLUGIN_CONFIG,
	ConfigError,
	ValidationError,
} from "./config.js"
export type {
	RelayConfig,
	OpenCodeNotifyConfig,
	KdcoNotifyConfig,
	FsAbstraction,
	OsAbstraction,
} from "./config.js"

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

export {
	eventToUpsert,
	buildUpsertMessage,
	buildCancelMessage,
	shouldRelayEvent,
} from "./events.js"
export type { UpsertEvent, CancelEvent } from "./events.js"

export { RelayClient } from "./relay-client.js"
export type { RelayClientOptions, RelayStatus, RelayDecisionCallback, RelayStatusCallback } from "./relay-client.js"

export {
	applyQuestion,
	rejectQuestion,
	applyPermission,
	createOpencodeClient,
} from "./opencode-client.js"
export type { ApplyResult, ApplyQuestionParams, ApplyPermissionParams, OpencodeClient as RelayOpencodeClient } from "./opencode-client.js"

export { RelayBridge } from "./relay-bridge.js"
export type { IRelayClient, IRelayBridge, RelayClientFactory, RelayBridgeDeps } from "./relay-bridge.js"
