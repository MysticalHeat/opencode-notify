import type { Repository, OutboxRow } from "../db/repository.js";
import type { ConnectionRegistry } from "./connections.js";

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

    const applyIdempotencyKey = `apply:${requestId}:${clientId}:${sessionId}`;
    const pending = repo.dequeuePending(50);
    for (const entry of pending) {
      if (entry.idempotencyKey === applyIdempotencyKey) {
        return;
      }
      if (entry.recipientId === clientId && entry.status === "pending") {
        const payload = JSON.parse(entry.payloadJson);
        if (payload.requestId === requestId) {
          repo.markSent(entry.id);
        }
      }
    }
  }

  return { start, stop, dispatchPending, handleApplyAcknowledgement };
}
