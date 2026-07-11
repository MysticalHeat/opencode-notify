import { describe, it, expect } from "vitest";
import { transitionRequest } from "../src/request-state.js";
import type { RequestState } from "../src/request-state.js";

// ─── Helpers ─────────────────────────────────────────────

const expiresAt = new Date("2025-07-11T12:06:00.000Z");
const baseTime = new Date("2025-07-11T12:00:00.000Z");
const pastTime = new Date("2025-07-11T12:10:00.000Z"); // after expiresAt

function pending(overrides?: Partial<RequestState>): RequestState {
  return {
    requestId: "req-1",
    clientId: "client-1",
    sessionId: "session-1",
    status: "pending",
    expiresAt,
    ...overrides,
  };
}

// ─── ALLOWED TRANSITIONS ────────────────────────────────

describe("allowed transitions", () => {
  it("undefined + UPSERT → pending", () => {
    const result = transitionRequest(undefined, {
      type: "UPSERT",
      requestId: "req-1",
      clientId: "client-1",
      sessionId: "session-1",
      expiresAt,
    }, baseTime);

    expect(result).toBeDefined();
    expect(result!.status).toBe("pending");
    expect(result!.requestId).toBe("req-1");
    expect(result!.clientId).toBe("client-1");
    expect(result!.sessionId).toBe("session-1");
    expect(result!.expiresAt).toEqual(expiresAt);
  });

  it("pending + UPSERT → pending (idempotent refresh)", () => {
    const later = new Date("2025-07-11T12:02:00.000Z");
    const newExpiry = new Date("2025-07-11T12:08:00.000Z");

    const result = transitionRequest(pending(), {
      type: "UPSERT",
      requestId: "req-1",
      clientId: "client-1",
      sessionId: "session-1",
      expiresAt: newExpiry,
    }, later);

    expect(result).toBeDefined();
    expect(result!.status).toBe("pending");
    expect(result!.expiresAt).toEqual(newExpiry);
  });

  it("pending + CANCEL → cancelled", () => {
    const result = transitionRequest(pending(), {
      type: "CANCEL",
      requestId: "req-1",
      clientId: "client-1",
      sessionId: "session-1",
    }, baseTime);

    expect(result).toBeDefined();
    expect(result!.status).toBe("cancelled");
  });

  it("pending + DECISION → decided", () => {
    const result = transitionRequest(pending(), {
      type: "DECISION",
      requestId: "req-1",
      clientId: "client-1",
      sessionId: "session-1",
    }, baseTime);

    expect(result).toBeDefined();
    expect(result!.status).toBe("decided");
  });

  it("pending + DECISION (approved=false) → rejected", () => {
    const result = transitionRequest(pending(), {
      type: "DECISION",
      requestId: "req-1",
      clientId: "client-1",
      sessionId: "session-1",
      approved: false,
    }, baseTime);

    expect(result).toBeDefined();
    expect(result!.status).toBe("rejected");
  });

  it("pending + DECISION (after expiry) → expired", () => {
    const result = transitionRequest(pending(), {
      type: "DECISION",
      requestId: "req-1",
      clientId: "client-1",
      sessionId: "session-1",
    }, pastTime);

    expect(result).toBeDefined();
    expect(result!.status).toBe("expired");
  });

  it("pending + EXPIRE → expired", () => {
    const result = transitionRequest(pending(), {
      type: "EXPIRE",
      requestId: "req-1",
    }, pastTime);

    expect(result).toBeDefined();
    expect(result!.status).toBe("expired");
  });

  it("decided + DISPATCH → dispatching", () => {
    const result = transitionRequest(pending({ status: "decided" }), {
      type: "DISPATCH",
      requestId: "req-1",
      clientId: "client-1",
      sessionId: "session-1",
    }, baseTime);

    expect(result).toBeDefined();
    expect(result!.status).toBe("dispatching");
  });

  it("decided + CANCEL → cancelled", () => {
    const result = transitionRequest(pending({ status: "decided" }), {
      type: "CANCEL",
      requestId: "req-1",
      clientId: "client-1",
      sessionId: "session-1",
    }, baseTime);

    expect(result).toBeDefined();
    expect(result!.status).toBe("cancelled");
  });

  it("decided + EXPIRE → expired", () => {
    const result = transitionRequest(pending({ status: "decided" }), {
      type: "EXPIRE",
      requestId: "req-1",
    }, pastTime);

    expect(result).toBeDefined();
    expect(result!.status).toBe("expired");
  });

  it("dispatching + APPLY_RESULT (success) → applied", () => {
    const result = transitionRequest(pending({ status: "dispatching" }), {
      type: "APPLY_RESULT",
      requestId: "req-1",
      clientId: "client-1",
      sessionId: "session-1",
      success: true,
    }, baseTime);

    expect(result).toBeDefined();
    expect(result!.status).toBe("applied");
  });

  it("dispatching + APPLY_RESULT (failure) → failed", () => {
    const result = transitionRequest(pending({ status: "dispatching" }), {
      type: "APPLY_RESULT",
      requestId: "req-1",
      clientId: "client-1",
      sessionId: "session-1",
      success: false,
    }, baseTime);

    expect(result).toBeDefined();
    expect(result!.status).toBe("failed");
  });

  it("dispatching + ERROR → failed", () => {
    const result = transitionRequest(pending({ status: "dispatching" }), {
      type: "ERROR",
      requestId: "req-1",
      clientId: "client-1",
      sessionId: "session-1",
    }, baseTime);

    expect(result).toBeDefined();
    expect(result!.status).toBe("failed");
  });

  it("undefined + non-UPSERT events → undefined", () => {
    expect(transitionRequest(undefined, { type: "CANCEL", requestId: "req-1", clientId: "c", sessionId: "s" }, baseTime)).toBeUndefined();
    expect(transitionRequest(undefined, { type: "DECISION", requestId: "req-1", clientId: "c", sessionId: "s" }, baseTime)).toBeUndefined();
    expect(transitionRequest(undefined, { type: "DISPATCH", requestId: "req-1", clientId: "c", sessionId: "s" }, baseTime)).toBeUndefined();
    expect(transitionRequest(undefined, { type: "APPLY_RESULT", requestId: "req-1", clientId: "c", sessionId: "s", success: true }, baseTime)).toBeUndefined();
    expect(transitionRequest(undefined, { type: "ERROR", requestId: "req-1", clientId: "c", sessionId: "s" }, baseTime)).toBeUndefined();
    expect(transitionRequest(undefined, { type: "EXPIRE", requestId: "req-1" }, baseTime)).toBeUndefined();
  });
});

// ─── REJECTION: DUPLICATE ────────────────────────────────

describe("rejection: duplicate events", () => {
  it("rejects duplicate DECISION from decided", () => {
    const result = transitionRequest(pending({ status: "decided" }), {
      type: "DECISION",
      requestId: "req-1",
      clientId: "client-1",
      sessionId: "session-1",
    }, baseTime);
    expect(result).toBeUndefined();
  });

  it("rejects duplicate DISPATCH from dispatching", () => {
    const result = transitionRequest(pending({ status: "dispatching" }), {
      type: "DISPATCH",
      requestId: "req-1",
      clientId: "client-1",
      sessionId: "session-1",
    }, baseTime);
    expect(result).toBeUndefined();
  });

  it("rejects duplicate APPLY_RESULT from applied", () => {
    const result = transitionRequest(pending({ status: "applied" }), {
      type: "APPLY_RESULT",
      requestId: "req-1",
      clientId: "client-1",
      sessionId: "session-1",
      success: true,
    }, baseTime);
    expect(result).toBeUndefined();
  });
});

// ─── REJECTION: MISMATCHED CLIENT ───────────────────────

describe("rejection: mismatched client", () => {
  it("rejects UPSERT with different clientId", () => {
    const result = transitionRequest(pending(), {
      type: "UPSERT",
      requestId: "req-1",
      clientId: "client-2",
      sessionId: "session-1",
      expiresAt,
    }, baseTime);
    expect(result).toBeUndefined();
  });

  it("rejects CANCEL with different clientId", () => {
    const result = transitionRequest(pending(), {
      type: "CANCEL",
      requestId: "req-1",
      clientId: "client-2",
      sessionId: "session-1",
    }, baseTime);
    expect(result).toBeUndefined();
  });

  it("rejects DECISION with different clientId", () => {
    const result = transitionRequest(pending(), {
      type: "DECISION",
      requestId: "req-1",
      clientId: "client-2",
      sessionId: "session-1",
    }, baseTime);
    expect(result).toBeUndefined();
  });

  it("rejects DISPATCH with different clientId from decided", () => {
    const result = transitionRequest(pending({ status: "decided" }), {
      type: "DISPATCH",
      requestId: "req-1",
      clientId: "client-2",
      sessionId: "session-1",
    }, baseTime);
    expect(result).toBeUndefined();
  });

  it("rejects APPLY_RESULT with different clientId from dispatching", () => {
    const result = transitionRequest(pending({ status: "dispatching" }), {
      type: "APPLY_RESULT",
      requestId: "req-1",
      clientId: "client-2",
      sessionId: "session-1",
      success: true,
    }, baseTime);
    expect(result).toBeUndefined();
  });
});

// ─── REJECTION: STALE EVENTS ───────────────────────────

describe("rejection: stale events", () => {
  it("rejects UPSERT from decided (already decided)", () => {
    const result = transitionRequest(pending({ status: "decided" }), {
      type: "UPSERT",
      requestId: "req-1",
      clientId: "client-1",
      sessionId: "session-1",
      expiresAt,
    }, baseTime);
    expect(result).toBeUndefined();
  });

  it("rejects UPSERT from dispatching (already dispatching)", () => {
    const result = transitionRequest(pending({ status: "dispatching" }), {
      type: "UPSERT",
      requestId: "req-1",
      clientId: "client-1",
      sessionId: "session-1",
      expiresAt,
    }, baseTime);
    expect(result).toBeUndefined();
  });

  it("rejects CANCEL from dispatching (already dispatching)", () => {
    const result = transitionRequest(pending({ status: "dispatching" }), {
      type: "CANCEL",
      requestId: "req-1",
      clientId: "client-1",
      sessionId: "session-1",
    }, baseTime);
    expect(result).toBeUndefined();
  });

  it("rejects DECISION from dispatching (already past decision)", () => {
    const result = transitionRequest(pending({ status: "dispatching" }), {
      type: "DECISION",
      requestId: "req-1",
      clientId: "client-1",
      sessionId: "session-1",
    }, baseTime);
    expect(result).toBeUndefined();
  });

  it("rejects APPLY_RESULT from decided (not yet dispatching)", () => {
    const result = transitionRequest(pending({ status: "decided" }), {
      type: "APPLY_RESULT",
      requestId: "req-1",
      clientId: "client-1",
      sessionId: "session-1",
      success: true,
    }, baseTime);
    expect(result).toBeUndefined();
  });

  it("rejects DISPATCH from pending (not yet decided)", () => {
    const result = transitionRequest(pending(), {
      type: "DISPATCH",
      requestId: "req-1",
      clientId: "client-1",
      sessionId: "session-1",
    }, baseTime);
    expect(result).toBeUndefined();
  });
});

// ─── REJECTION: TERMINAL STATE ──────────────────────────

describe("rejection: terminal state actions", () => {
  const terminalStates: Array<RequestState["status"]> = [
    "applied",
    "rejected",
    "expired",
    "failed",
    "cancelled",
  ];

  for (const status of terminalStates) {
    describe(`from ${status}`, () => {
      it("rejects UPSERT", () => {
        const result = transitionRequest(pending({ status }), {
          type: "UPSERT",
          requestId: "req-1",
          clientId: "client-1",
          sessionId: "session-1",
          expiresAt,
        }, baseTime);
        expect(result).toBeUndefined();
      });

      it("rejects CANCEL", () => {
        const result = transitionRequest(pending({ status }), {
          type: "CANCEL",
          requestId: "req-1",
          clientId: "client-1",
          sessionId: "session-1",
        }, baseTime);
        expect(result).toBeUndefined();
      });

      it("rejects DECISION", () => {
        const result = transitionRequest(pending({ status }), {
          type: "DECISION",
          requestId: "req-1",
          clientId: "client-1",
          sessionId: "session-1",
        }, baseTime);
        expect(result).toBeUndefined();
      });

      it("rejects DISPATCH", () => {
        const result = transitionRequest(pending({ status }), {
          type: "DISPATCH",
          requestId: "req-1",
          clientId: "client-1",
          sessionId: "session-1",
        }, baseTime);
        expect(result).toBeUndefined();
      });

      it("rejects APPLY_RESULT", () => {
        const result = transitionRequest(pending({ status }), {
          type: "APPLY_RESULT",
          requestId: "req-1",
          clientId: "client-1",
          sessionId: "session-1",
          success: true,
        }, baseTime);
        expect(result).toBeUndefined();
      });

      it("rejects ERROR", () => {
        const result = transitionRequest(pending({ status }), {
          type: "ERROR",
          requestId: "req-1",
          clientId: "client-1",
          sessionId: "session-1",
        }, baseTime);
        expect(result).toBeUndefined();
      });

      it("rejects EXPIRE", () => {
        const result = transitionRequest(pending({ status }), {
          type: "EXPIRE",
          requestId: "req-1",
        }, baseTime);
        expect(result).toBeUndefined();
      });
    });
  }
});

// ─── ONLY ONE DECISION CAN WIN ─────────────────────────

describe("only one concurrent decision can win", () => {
  it("first DECISION transitions to decided", () => {
    const result = transitionRequest(pending(), {
      type: "DECISION",
      requestId: "req-1",
      clientId: "client-1",
      sessionId: "session-1",
    }, baseTime);
    expect(result).toBeDefined();
    expect(result!.status).toBe("decided");
  });

  it("second DECISION from same request is rejected", () => {
    const decided = pending({ status: "decided" });
    const result = transitionRequest(decided, {
      type: "DECISION",
      requestId: "req-1",
      clientId: "client-1",
      sessionId: "session-1",
    }, baseTime);
    expect(result).toBeUndefined();
  });

  it("second DECISION with different outcome (rejected) is still rejected", () => {
    const decided = pending({ status: "decided" });
    const result = transitionRequest(decided, {
      type: "DECISION",
      requestId: "req-1",
      clientId: "client-1",
      sessionId: "session-1",
      approved: false,
    }, baseTime);
    expect(result).toBeUndefined();
  });
});

// ─── EXPIRY PREVENTS DISPATCH ─────────────────────────

describe("expiry prevents dispatch", () => {
  it("DECISION on expired request transitions to expired, not decided", () => {
    const result = transitionRequest(pending(), {
      type: "DECISION",
      requestId: "req-1",
      clientId: "client-1",
      sessionId: "session-1",
    }, pastTime);
    expect(result).toBeDefined();
    expect(result!.status).toBe("expired");
  });

  it("DISPATCH on expired-but-decided request is rejected", () => {
    const decided = pending({
      status: "decided",
      expiresAt: new Date("2025-07-11T11:00:00.000Z"),
    });
    const result = transitionRequest(decided, {
      type: "DISPATCH",
      requestId: "req-1",
      clientId: "client-1",
      sessionId: "session-1",
    }, pastTime);
    expect(result).toBeUndefined();
  });

  it("DISPATCH on non-expired decided request succeeds", () => {
    const decided = pending({ status: "decided" });
    const result = transitionRequest(decided, {
      type: "DISPATCH",
      requestId: "req-1",
      clientId: "client-1",
      sessionId: "session-1",
    }, baseTime);
    expect(result).toBeDefined();
    expect(result!.status).toBe("dispatching");
  });
});

// ─── REQUEST IDENTITY PRESERVATION ─────────────────────

describe("request identity preservation", () => {
  it("fields propagate through full lifecycle", () => {
    let result: RequestState | undefined;

    // UPSERT → pending
    result = transitionRequest(undefined, {
      type: "UPSERT",
      requestId: "req-lifecycle",
      clientId: "client-main",
      sessionId: "session-main",
      expiresAt,
    }, baseTime);
    expect(result).toBeDefined();
    expect(result!.requestId).toBe("req-lifecycle");
    expect(result!.clientId).toBe("client-main");

    // DECISION → decided
    result = transitionRequest(result!, {
      type: "DECISION",
      requestId: "req-lifecycle",
      clientId: "client-main",
      sessionId: "session-main",
    }, baseTime);
    expect(result).toBeDefined();
    expect(result!.status).toBe("decided");

    // DISPATCH → dispatching
    result = transitionRequest(result!, {
      type: "DISPATCH",
      requestId: "req-lifecycle",
      clientId: "client-main",
      sessionId: "session-main",
    }, baseTime);
    expect(result).toBeDefined();
    expect(result!.status).toBe("dispatching");

    // APPLY_RESULT → applied
    result = transitionRequest(result!, {
      type: "APPLY_RESULT",
      requestId: "req-lifecycle",
      clientId: "client-main",
      sessionId: "session-main",
      success: true,
    }, baseTime);
    expect(result).toBeDefined();
    expect(result!.status).toBe("applied");
    expect(result!.requestId).toBe("req-lifecycle");
    expect(result!.clientId).toBe("client-main");
  });
});
