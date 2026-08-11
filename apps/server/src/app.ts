import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import type Database from "better-sqlite3";
import type { Repository } from "./db/repository.js";
import type { PairingService } from "./pairing/service.js";
import type { BotAdapter } from "./telegram/bot.js";
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
  botAdapter?: BotAdapter;
  ready?: { dbReady: boolean; botReady: boolean };
}

export async function createApp(options: AppOptions): Promise<ReturnType<typeof Fastify>> {
  const { repo, config, pairingService, botAdapter, ready } = options;

  setDbReady(ready?.dbReady ?? false);
  setBotReady(ready?.botReady ?? false);

  const app = Fastify({ logger: { level: config.loggingLevel } });
  const pairingAttempts = new Map<string, number[]>();
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
    botAdapter,
  });

  // Health endpoints
  app.get("/health/live", async () => healthLiveHandler(null, null));
  app.get("/health/ready", async (_request, reply) => healthReadyHandler(null, reply));
  app.post("/v1/pairing", async (request, reply) => {
    if (!pairingService) return reply.code(503).send({ error: "pairing unavailable" });
    const address = request.ip;
    const now = Date.now();
    const recent = (pairingAttempts.get(address) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= 5) return reply.code(429).send({ error: "too many pairing attempts" });
    recent.push(now);
    pairingAttempts.set(address, recent);
    return pairingService.generatePairingCode();
  });

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
