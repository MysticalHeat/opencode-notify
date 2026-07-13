import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import type Database from "better-sqlite3";
import type { Repository } from "./db/repository.js";
import type { PairingService } from "./pairing/service.js";
import { healthLiveHandler, healthReadyHandler, setDbReady, setBotReady } from "./health.js";
import { createConnectionRegistry } from "./relay/connections.js";
import { createDispatchService } from "./relay/dispatch.js";
import { createGatewayHandler } from "./relay/gateway.js";

export interface AppConfig {
  tokenAuth: boolean;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  maxMessageBytes: number;
  loggingLevel: string;
}

export interface AppOptions {
  db: Database.Database;
  repo: Repository;
  config: AppConfig;
  pairingService?: PairingService;
  ready?: { dbReady: boolean; botReady: boolean };
}

export async function createApp(options: AppOptions): Promise<ReturnType<typeof Fastify>> {
  const { db, repo, config, pairingService, ready } = options;

  setDbReady(ready?.dbReady ?? false);
  setBotReady(ready?.botReady ?? false);

  const app = Fastify({ logger: { level: config.loggingLevel } });
  await app.register(fastifyWebsocket, {
    options: { maxPayload: config.maxMessageBytes },
  });

  const registry = createConnectionRegistry(
    config.heartbeatIntervalMs,
    config.heartbeatTimeoutMs,
  );

  const dispatch = createDispatchService(repo, registry, config.heartbeatIntervalMs);

  const gatewayHandler = createGatewayHandler({
    repo,
    registry,
    dispatch,
    config: {
      maxMessageBytes: config.maxMessageBytes,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      heartbeatTimeoutMs: config.heartbeatTimeoutMs,
    },
    pairingService: pairingService
      ? {
          confirmPairingFromWs: pairingService.confirmPairingFromWs.bind(pairingService),
        }
      : undefined,
  });

  // Health endpoints
  app.get("/health/live", async () => healthLiveHandler(null, null));
  app.get("/health/ready", async (_request, reply) => healthReadyHandler(null, reply));

  // WebSocket endpoint
  app.register(async function wsScope(fastify) {
    fastify.get("/v1/ws", { websocket: true }, (connection, request) => {
      gatewayHandler(connection, request);
    });
  });

  // Start dispatch service
  dispatch.start();

  // Cleanup on close
  app.addHook("onClose", () => {
    dispatch.stop();
    registry.destroy();
  });

  return app;
}
