// ─── Types ──────────────────────────────────────────────

export type RequestStatus =
  | "pending"
  | "decided"
  | "dispatching"
  | "applied"
  | "rejected"
  | "expired"
  | "failed"
  | "cancelled";

export interface RequestState {
  readonly requestId: string;
  readonly clientId: string;
  readonly sessionId: string;
  readonly status: RequestStatus;
  readonly expiresAt: Date;
}

export type RequestEvent =
  | { type: "UPSERT"; requestId: string; clientId: string; sessionId: string; expiresAt: Date }
  | { type: "CANCEL"; requestId: string; clientId: string; sessionId: string }
  | { type: "DECISION"; requestId: string; clientId: string; sessionId: string; approved?: boolean }
  | { type: "DISPATCH"; requestId: string; clientId: string; sessionId: string }
  | { type: "APPLY_RESULT"; requestId: string; clientId: string; sessionId: string; success: boolean }
  | { type: "ERROR"; requestId: string; clientId: string; sessionId: string }
  | { type: "EXPIRE"; requestId: string };

// ─── Internal helpers ───────────────────────────────────

function identityMatches(current: RequestState, event: RequestEvent): boolean {
  // EXPIRE has no clientId/sessionId; skip identity check
  if (event.type === "EXPIRE") return true;
  if (event.clientId !== current.clientId) return false;
  if (event.sessionId !== current.sessionId) return false;
  return true;
}

function requestIdMatches(current: RequestState, event: RequestEvent): boolean {
  return current.requestId === event.requestId;
}

function isExpired(current: RequestState, now: Date): boolean {
  return now.getTime() >= current.expiresAt.getTime();
}

// ─── Transition function ───────────────────────────────

export function transitionRequest(
  current: RequestState | undefined,
  event: RequestEvent,
  now: Date,
): RequestState | undefined {
  // Type-narrowing check: terminal states are caught here so the switch
  // below only sees undefined | "pending" | "decided" | "dispatching".
  const s = current?.status;
  if (s !== undefined && s !== "pending" && s !== "decided" && s !== "dispatching") {
    return undefined;
  }

  switch (s) {
    case undefined:
      return transitionFromUndefined(event);
    case "pending":
      return transitionFromPending(current!, event, now);
    case "decided":
      return transitionFromDecided(current!, event, now);
    case "dispatching":
      return transitionFromDispatching(current!, event);
    default:
      return assertNever(s);
  }
}

function transitionFromUndefined(
  event: RequestEvent,
): RequestState | undefined {
  if (event.type === "UPSERT") {
    return {
      requestId: event.requestId,
      clientId: event.clientId,
      sessionId: event.sessionId,
      status: "pending",
      expiresAt: event.expiresAt,
    };
  }
  return undefined;
}

function transitionFromPending(
  current: RequestState,
  event: RequestEvent,
  now: Date,
): RequestState | undefined {
  if (!identityMatches(current, event)) return undefined;
  if (!requestIdMatches(current, event)) return undefined;

  switch (event.type) {
    case "UPSERT":
      return { ...current, expiresAt: event.expiresAt };
    case "CANCEL":
      return { ...current, status: "cancelled" };
    case "DECISION":
      if (isExpired(current, now)) {
        return { ...current, status: "expired" };
      }
      if (event.approved === false) {
        return { ...current, status: "rejected" };
      }
      return { ...current, status: "decided" };
    case "EXPIRE":
      return { ...current, status: "expired" };
    default:
      return undefined;
  }
}

function transitionFromDecided(
  current: RequestState,
  event: RequestEvent,
  now: Date,
): RequestState | undefined {
  if (!identityMatches(current, event)) return undefined;
  if (!requestIdMatches(current, event)) return undefined;

  switch (event.type) {
    case "DISPATCH":
      if (isExpired(current, now)) return undefined;
      return { ...current, status: "dispatching" };
    case "CANCEL":
      return { ...current, status: "cancelled" };
    case "EXPIRE":
      return { ...current, status: "expired" };
    default:
      return undefined;
  }
}

function transitionFromDispatching(
  current: RequestState,
  event: RequestEvent,
): RequestState | undefined {
  if (!identityMatches(current, event)) return undefined;
  if (!requestIdMatches(current, event)) return undefined;

  switch (event.type) {
    case "APPLY_RESULT":
      return { ...current, status: event.success ? "applied" : "failed" };
    case "ERROR":
      return { ...current, status: "failed" };
    default:
      return undefined;
  }
}

function assertNever(value: never): never {
  throw new Error(`Unreachable state: ${value}`);
}
