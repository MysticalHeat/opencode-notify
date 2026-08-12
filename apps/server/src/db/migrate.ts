import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATIONS = [
  { version: 1, file: "001-initial.sql" },
  { version: 2, file: "002-pairing-codes.sql" },
  { version: 3, file: "003-soft-revoke.sql" },
  { version: 4, file: "004-outbox-expiry.sql" },
  { version: 5, file: "005-callback-ids.sql" },
  { version: 6, file: "006-pairing-confirmation.sql" },
] as const;

export const CURRENT_SCHEMA_VERSION = MIGRATIONS.at(-1)!.version;

const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  clients: ["id", "token_hash", "created_at", "last_seen_at"],
  pairings: [
    "id",
    "client_a_id",
    "client_b_id",
    "pairing_code",
    "created_at",
    "expires_at",
  ],
  requests: [
    "id",
    "request_id",
    "client_id",
    "session_id",
    "status",
    "expires_at",
    "payload_type",
    "payload_json",
    "created_at",
    "updated_at",
  ],
  request_answers: ["id", "request_fk", "value", "label", "created_at"],
  telegram_updates: ["update_id", "payload_json", "processed_at"],
  outbox: [
    "id",
    "idempotency_key",
    "recipient_id",
    "message_type",
    "payload_json",
    "status",
    "created_at",
    "sent_at",
  ],
  pairing_codes: [
    "id",
    "code",
    "consumed",
    "consumed_by_client_id",
    "consumed_at",
    "created_at",
    "expires_at",
  ],
  telegram_callback_ids: [
    "action_id",
    "request_fk",
    "action_type",
    "payload_json",
    "created_at",
    "expires_at",
    "claimed_at",
  ],
  telegram_freply_tracking: [
    "id",
    "chat_id",
    "user_id",
    "reply_message_id",
    "request_fk",
    "created_at",
    "expires_at",
  ],
  telegram_decision_state: [
    "id",
    "request_fk",
    "chat_id",
    "user_id",
    "message_id",
    "selected_json",
    "created_at",
    "updated_at",
  ],
};

const SCHEMA_REQUIREMENTS = [
  {
    version: 1,
    tables: [
      "clients",
      "pairings",
      "requests",
      "request_answers",
      "telegram_updates",
      "outbox",
    ],
  },
  { version: 2, tables: ["pairing_codes"] },
  { version: 3, tables: ["clients.revoked_at"] },
  { version: 4, tables: ["outbox.request_id", "outbox.expires_at"] },
  {
    version: 5,
    tables: [
      "telegram_callback_ids",
      "telegram_freply_tracking",
      "telegram_decision_state",
    ],
  },
  { version: 6, tables: ["pairing_codes.confirmed_at", "pairing_codes.confirmed_by_user_id"] },
] as const;

function findMigrationsDir(): string {
  const bundled = join(__dirname, "..", "migrations");
  try {
    readFileSync(join(bundled, MIGRATIONS[0].file), "utf-8");
    return bundled;
  } catch {
    /* not at bundled path */
  }
  return join(__dirname, "..", "..", "migrations");
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table),
  );
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return columns.some((entry) => entry.name === column);
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(
      (entry) => entry.name,
    ),
  );
}

function requiredTables(version: number): string[] {
  const tables = new Set<string>();
  for (const requirement of SCHEMA_REQUIREMENTS) {
    if (requirement.version > version) break;
    for (const table of requirement.tables) {
      if (!table.includes(".")) tables.add(table);
    }
  }
  return [...tables];
}

function missingSchemaObjects(db: Database.Database, version: number): string[] {
  const missing: string[] = [];

  for (const table of requiredTables(version)) {
    if (!tableExists(db, table)) {
      missing.push(`${table} table`);
      continue;
    }

    const columns = tableColumns(db, table);
    for (const column of REQUIRED_COLUMNS[table] ?? []) {
      if (!columns.has(column)) missing.push(`${table}.${column}`);
    }
  }

  for (const requirement of SCHEMA_REQUIREMENTS) {
    if (requirement.version > version) break;
    for (const object of requirement.tables) {
      const separator = object.indexOf(".");
      if (separator === -1) continue;
      const table = object.slice(0, separator);
      const column = object.slice(separator + 1);
      if (!columnExists(db, table, column)) missing.push(object);
    }
  }

  return missing;
}

export function validateSchema(
  db: Database.Database,
  version: number = CURRENT_SCHEMA_VERSION,
): void {
  if (!Number.isInteger(version) || version < 0 || version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported SQLite schema version: ${version}`);
  }

  const missing = missingSchemaObjects(db, version);
  if (missing.length > 0) {
    throw new Error(
      `SQLite schema version ${version} is missing required objects: ${missing.join(", ")}`,
    );
  }
}

function legacySchemaVersion(db: Database.Database): number {
  let version = 0;
  for (const migration of MIGRATIONS) {
    if (missingSchemaObjects(db, migration.version).length > 0) break;
    version = migration.version;
  }
  return version;
}

function runMigrationSql(db: Database.Database, sql: string): void {
  const statements = sql
    .replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    const addColumn = statement.match(
      /^ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/i,
    );
    if (addColumn && columnExists(db, addColumn[1]!, addColumn[2]!)) continue;
    db.exec(statement);
  }
}

export function runMigrations(db: Database.Database): void {
  const dir = findMigrationsDir();
  const recordedVersion = Number(db.pragma("user_version", { simple: true }));

  if (
    !Number.isInteger(recordedVersion) ||
    recordedVersion < 0 ||
    recordedVersion > CURRENT_SCHEMA_VERSION
  ) {
    throw new Error(`Unsupported SQLite schema version: ${recordedVersion}`);
  }

  let version = recordedVersion;

  // Databases created before the version ledger have user_version = 0.
  // Infer their highest complete migration before applying only the remainder.
  if (version === 0) {
    version = legacySchemaVersion(db);
  }

  if (version > 0) validateSchema(db, version);

  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue;
    const sql = readFileSync(join(dir, migration.file), "utf-8");
    db.transaction(() => {
      runMigrationSql(db, sql);
      validateSchema(db, migration.version);
      db.pragma(`user_version = ${migration.version}`);
    })();
    version = migration.version;
  }

  validateSchema(db, CURRENT_SCHEMA_VERSION);
  if (recordedVersion === 0) {
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
  }
}
