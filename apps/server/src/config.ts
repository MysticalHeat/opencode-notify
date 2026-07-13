const SECRET_PLACEHOLDER = "[REDACTED]" as const;

export interface ServerConfig {
  server: { host: string; port: number };
  database: { path: string };
  telegram: { botToken: string; userId: number };
  webhook?: { host: string; port: number; secretToken?: string };
  publicBaseUrl: string;
}

class Config implements ServerConfig {
  readonly server: { host: string; port: number };
  readonly database: { path: string };
  readonly #botToken: string;
  readonly #userId: number;
  readonly webhook?: { host: string; port: number; secretToken?: string };
  readonly publicBaseUrl: string;

  constructor(env: Record<string, string | undefined>) {
    this.server = {
      host: required(env, "SERVER_HOST"),
      port: requiredInt(env, "SERVER_PORT"),
    };
    this.database = {
      path: required(env, "DATABASE_PATH"),
    };
    this.#botToken = required(env, "TELEGRAM_BOT_TOKEN");
    this.#userId = requiredInt(env, "TELEGRAM_USER_ID");
    this.publicBaseUrl = required(env, "PUBLIC_BASE_URL");

    if (env.WEBHOOK_HOST && env.WEBHOOK_PORT) {
      this.webhook = {
        host: env.WEBHOOK_HOST,
        port: requiredInt(env, "WEBHOOK_PORT"),
        secretToken: env.TELEGRAM_WEBHOOK_SECRET,
      };
    }
  }

  get telegram(): { botToken: string; userId: number } {
    return { botToken: this.#botToken, userId: this.#userId };
  }

  toJSON(): unknown {
    return {
      server: this.server,
      database: this.database,
      telegram: { botToken: SECRET_PLACEHOLDER, userId: this.#userId },
      webhook: this.webhook,
      publicBaseUrl: this.publicBaseUrl,
    };
  }
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function requiredInt(
  env: Record<string, string | undefined>,
  key: string,
): number {
  const raw = required(env, key);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== raw.trim()) {
    throw new Error(
      `Environment variable ${key} must be a valid integer, got: ${raw}`,
    );
  }
  return parsed;
}

export function parseConfig(
  env: Record<string, string | undefined>,
): ServerConfig {
  return new Config(env);
}
