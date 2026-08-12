import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CURRENT_SCHEMA_VERSION, runMigrations } from "../src/db/migrate.js";

const directories: string[] = [];
const databases: Database.Database[] = [];
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const migrationFiles = [
  "001-initial.sql",
  "002-pairing-codes.sql",
  "003-soft-revoke.sql",
  "004-outbox-expiry.sql",
  "005-callback-ids.sql",
] as const;

function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-notify-migrate-"));
  directories.push(dir);
  return join(dir, "relay.db");
}

function openDatabase(path = databasePath()): Database.Database {
  const db = new Database(path);
  databases.push(db);
  return db;
}

function applyLegacyMigrations(db: Database.Database, through: number): void {
  for (const file of migrationFiles.slice(0, through)) {
    db.exec(readFileSync(join(migrationsDir, file), "utf-8"));
  }
}

afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // A test may close a database before cleanup.
    }
  }
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("runMigrations", () => {
  it("is safe to run again after reopening a persisted database", () => {
    const path = databasePath();
    const first = openDatabase(path);
    runMigrations(first);
    expect(first.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    first.close();

    const second = openDatabase(path);
    expect(() => runMigrations(second)).not.toThrow();
    expect(second.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("adopts a fully migrated database created before the version ledger", () => {
    const db = openDatabase();
    applyLegacyMigrations(db, migrationFiles.length);

    runMigrations(db);

    expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("repairs a partially applied legacy column migration", () => {
    const db = openDatabase();
    applyLegacyMigrations(db, 3);
    db.exec("ALTER TABLE outbox ADD COLUMN request_id TEXT");

    runMigrations(db);

    const outboxColumns = db.pragma("table_info(outbox)") as Array<{ name: string }>;
    expect(outboxColumns.map((column) => column.name)).toContain("expires_at");
    expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("does not treat a partial clients table as a completed legacy schema", () => {
    const db = openDatabase();
    db.exec("CREATE TABLE clients (id TEXT PRIMARY KEY)");

    expect(() => runMigrations(db)).toThrow(/missing required objects.*clients\.token_hash/);
  });

  it("rejects a recorded version whose schema is incomplete", () => {
    const db = openDatabase();
    applyLegacyMigrations(db, 1);
    db.pragma("user_version = 5");

    expect(() => runMigrations(db)).toThrow(/schema version 5.*pairing_codes table/);
  });

  it("rejects unsupported recorded schema versions", () => {
    const db = openDatabase();
    db.pragma("user_version = 999");

    expect(() => runMigrations(db)).toThrow("Unsupported SQLite schema version: 999");
  });
});
