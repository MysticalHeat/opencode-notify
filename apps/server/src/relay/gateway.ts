import { createHash, randomUUID } from "node:crypto";
import { parseClientMessage, type ClientMessage } from "@repo/protocol";
import type { Repository } from "../db/repository.js";
import type { ConnectionRegistry } from "./connections.js";
import type { DispatchService } from "./dispatch.js";
import type { BotAdapter } from "../telegram/bot.js";

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
    waitForPairingConfirmation: (code: string) => {
      success: boolean;
      wait?: Promise<{ clientId: string; token: string }>;
      cancel?: () => void;
      error?: string;
    };
  };
  botAdapter?: BotAdapter;
}

interface WsConnection {
  send: (data: string) => void;
  on: (event: string, fn: (arg: unknown) => void) => void;
  close: (code?: number, reason?: string) => void;
}

const AUTH_TIMEOUT_MS = 15_000;
const PAIRING_WAIT_TIMEOUT_MS = 5 * 60_000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createGatewayHandler(options: GatewayOptions) {
  const { repo, registry, dispatch, config, pairingService, botAdapter } = options;

  return function wsHandler(connection: WsConnection, request: { url?: string }): void {
    const legacyToken = new URL(request.url ?? "/", "ws://localhost").searchParams.get("token");
    let clientId: string | null = null;
    let cancelPairingWait: (() => void) | undefined;
    let authenticated = false;
    let authTimer = setTimeout(() => {
      if (!authenticated) {
        connection.send(JSON.stringify(errorMsg("AUTH_TIMEOUT", "authentication timed out")));
        connection.close(4003, "authentication timed out");
      }
    }, AUTH_TIMEOUT_MS);

    function authenticate(id: string, token?: string): void {
      if (authenticated) return;
      authenticated = true;
      clientId = id;
      clearTimeout(authTimer);
      const sessionId = randomUUID();
      registry.register(id, sessionId, connection, (registeredId) => {
        registry.unregister(registeredId);
      });
      repo.updateLastSeen(id);
      connection.send(JSON.stringify({
        protocolVersion: 1,
        messageId: randomUUID(),
        sentAt: new Date().toISOString(),
        type: "pairing",
        payload: { clientId: id, sessionId, paired: true, ...(token ? { token } : {}) },
      }));
      dispatch.dispatchPending(id).catch(() => {});
    }

    // Preserve existing token-only clients for one migration cycle. New clients
    // authenticate in-band and never place credentials in their connection URL.
    if (legacyToken) {
      const client = repo.findClientByTokenHash(hashToken(legacyToken));
      if (!client) {
        connection.send(JSON.stringify(errorMsg("AUTH_FAILED", "invalid token")));
        connection.close(4003, "invalid token");
        return;
      }
      authenticate(client.id);
    }

    // ── Message handler ──
    connection.on("message", (raw: unknown) => {
      const data = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString() : "";

      if (Buffer.byteLength(data) > config.maxMessageBytes) {
        connection.send(JSON.stringify(errorMsg("MESSAGE_TOO_LARGE", "message exceeds maximum size")));
        connection.close(4003, "message too large");
        return;
      }

      let msg: ClientMessage;
      try {
        msg = parseClientMessage(JSON.parse(data));
      } catch {
        connection.send(JSON.stringify(errorMsg("PROTOCOL_VIOLATION", "invalid protocol message")));
        return;
      }

      if (!authenticated) {
        if (msg.type !== "auth") {
          connection.send(JSON.stringify(errorMsg("AUTH_REQUIRED", "authenticate before sending relay messages")));
          connection.close(4003, "authentication required");
          return;
        }

        if (msg.payload.token) {
          const client = repo.findClientByTokenHash(hashToken(msg.payload.token));
          if (!client) {
            connection.send(JSON.stringify(errorMsg("AUTH_FAILED", "invalid token")));
            connection.close(4003, "invalid token");
            return;
          }
          authenticate(client.id);
          return;
        }

        if (!pairingService || !msg.payload.pairingCode) {
          connection.send(JSON.stringify(errorMsg("PAIRING_UNAVAILABLE", "pairing not available")));
          connection.close(4003, "pairing not available");
          return;
        }

        const waiting = pairingService.waitForPairingConfirmation(msg.payload.pairingCode);
        if (!waiting.success || !waiting.wait) {
          connection.send(JSON.stringify(errorMsg("PAIRING_FAILED", waiting.error ?? "invalid pairing code")));
          connection.close(4003, waiting.error ?? "invalid pairing code");
          return;
        }
        clearTimeout(authTimer);
        authTimer = setTimeout(() => {
          connection.send(JSON.stringify(errorMsg("PAIRING_FAILED", "pairing confirmation timed out")));
          connection.close(4003, "pairing confirmation timed out");
        }, PAIRING_WAIT_TIMEOUT_MS);
        cancelPairingWait = waiting.cancel;
        waiting.wait.then(({ clientId: issuedClientId, token }) => {
          cancelPairingWait = undefined;
          authenticate(issuedClientId, token);
        }).catch(() => {
          connection.send(JSON.stringify(errorMsg("PAIRING_FAILED", "pairing failed")));
          connection.close(4003, "pairing failed");
        });
        return;
      }

      if (msg.type === "auth") {
        connection.send(JSON.stringify(errorMsg("PROTOCOL_VIOLATION", "connection is already authenticated")));
        return;
      }
      handleMessage(clientId!, msg);
    });

    // ── Close handler ──
    connection.on("close", () => {
      clearTimeout(authTimer);
      cancelPairingWait?.();
      if (clientId) registry.unregister(clientId);
    });

    function handleMessage(id: string, msg: ClientMessage): void {
      if (msg.type === "auth") return;
      const msgType = msg.type;

      if (msg.payload.clientId !== id) {
        connection.send(JSON.stringify(errorMsg("CLIENT_ID_MISMATCH", "client ID does not match authenticated connection")));
        return;
      }

      switch (msgType) {
        case "hello": {
          const payload = msg.payload;
          const sessionId = payload.sessionId;

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
          const sessionId = msg.payload.sessionId;

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
          const payload = msg.payload;

          const requestId = payload.requestId;
          const sessionId = payload.sessionId;
          const expiresAt = new Date(payload.expiresAt);
          const question = payload.question;
          const permission = payload.permission;

          let payloadType: "question" | "permission" | undefined;
          let payloadJson: string | undefined;

          if (question) {
            payloadType = "question";
            payloadJson = JSON.stringify(question);
          } else if (permission) {
            payloadType = "permission";
            payloadJson = JSON.stringify(permission);
          }

          const row = repo.upsertRequest({
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

          if (botAdapter) {
            botAdapter.postRequest(row).catch(() => {});
          }
          break;
        }

        case "request_cancel": {
          const payload = msg.payload;

          const requestId = payload.requestId;
          const sessionId = payload.sessionId;

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
          const payload = msg.payload;

          const requestId = payload.requestId;
          const sessionId = payload.sessionId;
          const success = payload.success;

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
