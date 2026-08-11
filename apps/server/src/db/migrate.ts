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
] as const;

export const CURRENT_SCHEMA_VERSION = MIGRATIONS.at(-1)!.version;

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

function legacySchemaVersion(db: Database.Database): number {
  if (!tableExists(db, "clients")) return 0;
  if (!tableExists(db, "pairing_codes")) return 1;
  if (!columnExists(db, "clients", "revoked_at")) return 2;
  if (
    !columnExists(db, "outbox", "request_id") ||
    !columnExists(db, "outbox", "expires_at")
  ) {
    return 3;
  }
  if (!tableExists(db, "telegram_callback_ids")) return 4;
  return 5;
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
  let version = Number(db.pragma("user_version", { simple: true }));

  // Databases created before the version ledger have user_version = 0.
  // Infer their highest complete migration before applying only the remainder.
  if (version === 0) {
    version = legacySchemaVersion(db);
    if (version > 0) db.pragma(`user_version = ${version}`);
  }

  if (!Number.isInteger(version) || version < 0 || version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported SQLite schema version: ${version}`);
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue;
    const sql = readFileSync(join(dir, migration.file), "utf-8");
    db.transaction(() => {
      runMigrationSql(db, sql);
      db.pragma(`user_version = ${migration.version}`);
    })();
    version = migration.version;
  }
}
