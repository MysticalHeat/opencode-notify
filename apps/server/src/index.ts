import { PROTOCOL_VERSION } from "@repo/core";
import { parseConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import { runMigrations } from "./db/migrate.js";
import { createRepository } from "./db/repository.js";
import { createPairingService } from "./pairing/service.js";
import { createBotAdapter, type BotAdapter } from "./telegram/bot.js";
import { createApp, type AppConfig } from "./app.js";
import { setBotReady, setDbReady, setSchemaReady } from "./health.js";

const FAKE_TOKEN = "FAKE";

async function main() {
  const config = parseConfig(process.env as Record<string, string | undefined>);

  const { db, close } = openDatabase(config.database.path);
  runMigrations(db);
  const repo = createRepository(db);
  setDbReady(true);
  setSchemaReady(true);

  const pairingService = createPairingService(repo, config.telegram.userId);

  const isFakeTelegram = config.telegram.botToken === FAKE_TOKEN;
  let botAdapter: BotAdapter | undefined;
  if (!isFakeTelegram) {
    botAdapter = createBotAdapter(
      config.telegram.botToken,
      config.telegram.userId,
      repo,
      pairingService,
    );
  }

  setBotReady(isFakeTelegram);

  const appConfig: AppConfig = {
    tokenAuth: true,
    heartbeatIntervalMs: 30_000,
    heartbeatTimeoutMs: 90_000,
    maxMessageBytes: 65_536,
    loggingLevel: (process.env.LOGGING_LEVEL as string) ?? "info",
  };

  const app = await createApp({
    db,
    repo,
    config: appConfig,
    pairingService,
    botAdapter,
    ready: {
      dbReady: true,
      schemaReady: true,
      botReady: isFakeTelegram,
    },
  });

  if (botAdapter && !isFakeTelegram) {
    await botAdapter.start(undefined, (err) => {
      setBotReady(false);
      app.log.error(err, "Bot polling failed");
    });
    setBotReady(true);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`Received ${signal}, shutting down...`);
    try {
      await botAdapter?.stop();
    } catch {
      // Continue shutdown if Telegram cannot confirm the final update offset.
    }
    try {
      await app.close();
    } catch {
      // Ignore close errors during shutdown
    }
    setBotReady(false);
    setDbReady(false);
    setSchemaReady(false);
    close();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  console.log(`Server starting, protocol v${PROTOCOL_VERSION}`);
  await app.listen({ host: config.server.host, port: config.server.port });
  app.log.info(
    `Server listening on ${config.server.host}:${config.server.port}`,
  );
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
