import { createHash, randomUUID } from "node:crypto";
import type { Repository } from "../db/repository.js";
import type { ConnectionRegistry } from "./connections.js";
import type { DispatchService } from "./dispatch.js";

interface GatewayOptions {
  repo: Repository;
  registry: ConnectionRegistry;
  dispatch: DispatchService;
  config: {
    maxMessageBytes: number;
    heartbeatIntervalMs: number;
    heartbeatTimeoutMs: number;
  };
  pairingService?: {
    confirmPairingFromWs: (code: string) => {
      success: boolean;
      clientId?: string;
      token?: string;
      error?: string;
    };
  };
}

interface WsConnection {
  send: (data: string) => void;
  on: (event: string, fn: (arg: unknown) => void) => void;
  close: (code?: number, reason?: string) => void;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createGatewayHandler(options: GatewayOptions) {
  const { repo, registry, dispatch, config, pairingService } = options;

  return function wsHandler(connection: WsConnection, request: { url?: string }): void {
    const url = new URL(request.url ?? "/", "ws://localhost");
    const token = url.searchParams.get("token");
    const pairingCode = url.searchParams.get("pairing_code");

    let clientId: string | null = null;

    // ── Pairing code flow ──
    if (pairingCode && !token) {
      if (!pairingService) {
        connection.send(JSON.stringify(errorMsg("PAIRING_UNAVAILABLE", "pairing not available")));
        connection.close(4003, "pairing not available");
        return;
      }

      const result = pairingService.confirmPairingFromWs(pairingCode);
      if (!result.success || !result.clientId || !result.token) {
        connection.send(JSON.stringify(errorMsg("PAIRING_FAILED", result.error ?? "invalid pairing code")));
        connection.close(4003, result.error ?? "invalid pairing code");
        return;
      }

      clientId = result.clientId;
      const sessionId = randomUUID();
      const pairingMsg = {
        protocolVersion: 1,
        messageId: randomUUID(),
        sentAt: new Date().toISOString(),
        type: "pairing",
        payload: {
          clientId: result.clientId,
          sessionId,
          paired: true,
          token: result.token,
        },
      };

      connection.send(JSON.stringify(pairingMsg));

      registry.register(result.clientId, sessionId, connection, (id) => {
        registry.unregister(id);
      });

      const tokenHash = hashToken(result.token);
      const client = repo.findClientByTokenHash(tokenHash);
      if (client) {
        repo.updateLastSeen(client.id);
      }
    }

    // ── Token auth flow ──
    if (token && !pairingCode) {
      const tokenHashVal = hashToken(token);
      const client = repo.findClientByTokenHash(tokenHashVal);

      if (!client) {
        connection.send(JSON.stringify(errorMsg("AUTH_FAILED", "invalid token")));
        connection.close(4003, "invalid token");
        return;
      }

      clientId = client.id;

      // Register immediately with a placeholder session
      registry.register(client.id, "pending", connection, (id) => {
        registry.unregister(id);
      });

      repo.updateLastSeen(client.id);
    }

    // ── Reject unauthenticated ──
    if (!clientId) {
      connection.send(JSON.stringify(errorMsg("AUTH_REQUIRED", "authentication required")));
      connection.close(4003, "authentication required");
      return;
    }

    const cid = clientId;

    // ── Dispatch pending outbox on connect (for token auth) ──
    if (token) {
      dispatch.dispatchPending(cid).catch(() => {});
    }

    // ── Message handler ──
    connection.on("message", (raw: unknown) => {
      const data = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString() : "";

      if (Buffer.byteLength(data) > config.maxMessageBytes) {
        connection.send(JSON.stringify(errorMsg("MESSAGE_TOO_LARGE", "message exceeds maximum size")));
        connection.close(4003, "message too large");
        return;
      }

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data);
      } catch {
        connection.send(JSON.stringify(errorMsg("BAD_JSON", "invalid JSON")));
        return;
      }

      handleMessage(cid, msg);
    });

    // ── Close handler ──
    connection.on("close", () => {
      registry.unregister(cid);
    });

    function handleMessage(id: string, msg: Record<string, unknown>): void {
      const msgType = msg.type as string | undefined;

      switch (msgType) {
        case "hello": {
          const payload = msg.payload as Record<string, unknown> | undefined;
          if (!payload) break;
          const sessionId = (payload.sessionId as string) || "unknown";

          // Re-register with the real session ID
          registry.unregister(id);
          registry.register(id, sessionId, connection, (c) => {
            registry.unregister(c);
          });

          repo.updateLastSeen(id);
          break;
        }

        case "heartbeat": {
          registry.updateHeartbeat(id);
          const hbPayload = (msg.payload ?? {}) as Record<string, unknown>;
          const sessionId = (hbPayload.sessionId as string) || "unknown";

          connection.send(JSON.stringify({
            protocolVersion: 1,
            messageId: randomUUID(),
            sentAt: new Date().toISOString(),
            type: "heartbeat",
            payload: { clientId: id, sessionId },
          }));
          break;
        }

        case "request_upsert": {
          const payload = msg.payload as Record<string, unknown> | undefined;
          if (!payload) break;

          const requestId = payload.requestId as string;
          const sessionId = (payload.sessionId as string) || "unknown";
          const expiresAt = new Date(payload.expiresAt as string);
          const question = payload.question as Record<string, unknown> | undefined;
          const permission = payload.permission as Record<string, unknown> | undefined;

          let payloadType: "question" | "permission" | undefined;
          let payloadJson: string | undefined;

          if (question) {
            payloadType = "question";
            payloadJson = JSON.stringify(question);
          } else if (permission) {
            payloadType = "permission";
            payloadJson = JSON.stringify(permission);
          }

          repo.upsertRequest({
            requestId,
            clientId: id,
            sessionId,
            status: "pending",
            expiresAt,
            payloadType,
            payloadJson,
          });

          connection.send(JSON.stringify({
            protocolVersion: 1,
            messageId: randomUUID(),
            sentAt: new Date().toISOString(),
            type: "heartbeat",
            payload: { clientId: id, sessionId },
          }));
          break;
        }

        case "request_cancel": {
          const payload = msg.payload as Record<string, unknown> | undefined;
          if (!payload) break;

          const requestId = payload.requestId as string;
          const sessionId = (payload.sessionId as string) || "unknown";

          const req = repo.findRequest(requestId, id, sessionId);
          if (req && req.status === "pending") {
            repo.updateRequestStatus(req.id, "cancelled");
          }

          connection.send(JSON.stringify({
            protocolVersion: 1,
            messageId: randomUUID(),
            sentAt: new Date().toISOString(),
            type: "heartbeat",
            payload: { clientId: id, sessionId },
          }));
          break;
        }

        case "apply_result": {
          const payload = msg.payload as Record<string, unknown> | undefined;
          if (!payload) break;

          const requestId = payload.requestId as string;
          const sessionId = (payload.sessionId as string) || "unknown";
          const success = payload.success as boolean;

          dispatch.handleApplyAcknowledgement(
            requestId,
            id,
            sessionId,
            success,
          ).catch(() => {});

          connection.send(JSON.stringify({
            protocolVersion: 1,
            messageId: randomUUID(),
            sentAt: new Date().toISOString(),
            type: "heartbeat",
            payload: { clientId: id, sessionId },
          }));
          break;
        }

        default: {
          connection.send(JSON.stringify(errorMsg("UNKNOWN_TYPE", `unknown message type: ${msgType}`)));
          break;
        }
      }
    }
  };
}

function errorMsg(code: string, message: string) {
  return {
    protocolVersion: 1,
    messageId: randomUUID(),
    sentAt: new Date().toISOString(),
    type: "error",
    payload: { code, message },
  };
}
