import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION, runMigrations } from "../src/db/migrate.js";

const directories: string[] = [];

function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-notify-migrate-"));
  directories.push(dir);
  return join(dir, "relay.db");
}

afterEach(() => {
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("runMigrations", () => {
  it("is safe to run again after reopening a persisted database", () => {
    const path = databasePath();
    const first = new Database(path);
    runMigrations(first);
    expect(first.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    first.close();

    const second = new Database(path);
    expect(() => runMigrations(second)).not.toThrow();
    expect(second.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    second.close();
  });

  it("adopts a fully migrated database created before the version ledger", () => {
    const path = databasePath();
    const db = new Database(path);
    db.exec(`
      CREATE TABLE clients (id TEXT PRIMARY KEY, revoked_at TEXT);
      CREATE TABLE pairing_codes (id TEXT PRIMARY KEY);
      CREATE TABLE outbox (id TEXT PRIMARY KEY, request_id TEXT, expires_at TEXT);
      CREATE TABLE telegram_callback_ids (action_id TEXT PRIMARY KEY);
    `);

    runMigrations(db);

    expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  it("repairs a partially applied legacy column migration", () => {
    const path = databasePath();
    const db = new Database(path);
    db.exec(`
      CREATE TABLE clients (id TEXT PRIMARY KEY, token_hash TEXT, created_at TEXT, last_seen_at TEXT, revoked_at TEXT);
      CREATE TABLE pairing_codes (id TEXT PRIMARY KEY, code TEXT, consumed INTEGER, consumed_by_client_id TEXT, consumed_at TEXT, created_at TEXT, expires_at TEXT);
      CREATE TABLE outbox (id TEXT PRIMARY KEY, request_id TEXT);
    `);

    runMigrations(db);

    const outboxColumns = db.pragma("table_info(outbox)") as Array<{ name: string }>;
    expect(outboxColumns.map((column) => column.name)).toContain("expires_at");
    expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });
});
