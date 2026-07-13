import type { Repository, OutboxRow } from "../db/repository.js";
import type { ConnectionRegistry } from "./connections.js";

const TERMINAL_REQUEST_STATUSES = new Set([
  "applied",
  "rejected",
  "cancelled",
  "expired",
  "failed",
]);

export interface DispatchService {
  start(): void;
  stop(): void;
  dispatchPending(clientId: string): Promise<number>;
  handleApplyAcknowledgement(
    requestId: string,
    clientId: string,
    sessionId: string,
    success: boolean,
  ): Promise<void>;
}

export function createDispatchService(
  repo: Repository,
  registry: ConnectionRegistry,
  pollIntervalMs: number,
): DispatchService {
  let timer: ReturnType<typeof setInterval> | undefined;

  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      pollOutbox().catch(() => {});
    }, pollIntervalMs);
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  async function pollOutbox(): Promise<void> {
    const batchSize = 50;
    let pending = repo.dequeuePending(batchSize);

    while (pending.length > 0) {
      for (const entry of pending) {
        await dispatchOne(entry);
      }
      pending = repo.dequeuePending(batchSize);
    }
  }

  async function dispatchOne(entry: OutboxRow): Promise<void> {
    const conn = registry.get(entry.recipientId);
    if (!conn) return;

    if (!shouldDispatch(entry)) return;

    try {
      const payload = JSON.parse(entry.payloadJson);
      const msg = {
        protocolVersion: 1,
        messageId: entry.idempotencyKey,
        sentAt: new Date().toISOString(),
        type: entry.messageType,
        payload,
      };
      conn.ws.send(JSON.stringify(msg));
      repo.markSent(entry.id);
    } catch {
      repo.markFailed(entry.id);
    }
  }

  async function dispatchPending(clientId: string): Promise<number> {
    const batchSize = 50;
    const pending = repo.dequeuePending(batchSize);
    let dispatched = 0;

    for (const entry of pending) {
      if (entry.recipientId !== clientId) continue;

      const conn = registry.get(entry.recipientId);
      if (!conn) continue;

      if (!shouldDispatch(entry)) continue;

      try {
        const payload = JSON.parse(entry.payloadJson);
        const msg = {
          protocolVersion: 1,
          messageId: entry.idempotencyKey,
          sentAt: new Date().toISOString(),
          type: entry.messageType,
          payload,
        };
        conn.ws.send(JSON.stringify(msg));
        repo.markSent(entry.id);
        dispatched++;
      } catch {
        repo.markFailed(entry.id);
      }
    }

    return dispatched;
  }

  function shouldDispatch(entry: OutboxRow): boolean {
    if (entry.messageType !== "decision") return true;
    if (!entry.requestId) return true;

    const req = repo.findRequestByRequestIdAndClient(
      entry.requestId,
      entry.recipientId,
    );

    if (!req) {
      repo.markSent(entry.id);
      return false;
    }

    if (TERMINAL_REQUEST_STATUSES.has(req.status)) {
      repo.markSent(entry.id);
      return false;
    }

    if (req.status === "dispatching") return true;

    if (req.status === "decided") {
      try {
        repo.updateRequestStatus(req.id, "dispatching");
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }

  async function handleApplyAcknowledgement(
    requestId: string,
    clientId: string,
    sessionId: string,
    success: boolean,
  ): Promise<void> {
    const req = repo.findRequest(requestId, clientId, sessionId);
    if (!req) return;

    if (req.status !== "dispatching") return;

    const newStatus = success ? "applied" : "failed";
    repo.updateRequestStatus(req.id, newStatus);

    repo.markSentByRequestAndClient(requestId, clientId);
  }

  return { start, stop, dispatchPending, handleApplyAcknowledgement };
}
