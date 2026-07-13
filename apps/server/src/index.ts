import { PROTOCOL_VERSION } from "@repo/core";
import { parseConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import { runMigrations } from "./db/migrate.js";
import { createRepository } from "./db/repository.js";
import { createPairingService } from "./pairing/service.js";
import { createBotAdapter } from "./telegram/bot.js";
import { createApp, type AppConfig } from "./app.js";
import { setDbReady, setBotReady } from "./health.js";

const FAKE_TOKEN = "FAKE";

async function main() {
  const config = parseConfig(process.env as Record<string, string | undefined>);

  const { db, close } = openDatabase(config.database.path);
  runMigrations(db);
  const repo = createRepository(db);
  setDbReady(true);

  const pairingService = createPairingService(repo, config.telegram.userId);

  const isFakeTelegram = config.telegram.botToken === FAKE_TOKEN;
  let botAdapter;
  if (!isFakeTelegram) {
    botAdapter = createBotAdapter(
      config.telegram.botToken,
      config.telegram.userId,
      repo,
      pairingService,
    );
  }

  setBotReady(!isFakeTelegram);

  const appConfig: AppConfig = {
    tokenAuth: true,
    heartbeatIntervalMs: 300,
    heartbeatTimeoutMs: 10_000,
    maxMessageBytes: 65_536,
    loggingLevel: (process.env.LOGGING_LEVEL as string) ?? "info",
  };

  const app = await createApp({
    db,
    repo,
    config: appConfig,
    pairingService,
    botAdapter,
    ready: { dbReady: true, botReady: !isFakeTelegram },
  });

  if (botAdapter && !isFakeTelegram) {
    botAdapter.start().catch((err) => {
      app.log.error(err, "Bot polling failed");
    });
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`Received ${signal}, shutting down...`);
    try {
      await app.close();
    } catch {
      // Ignore close errors during shutdown
    }
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
