import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

const MIGRATION_FILES = ["001-initial.sql", "002-pairing-codes.sql", "003-soft-revoke.sql", "004-outbox-expiry.sql"] as const;

export function runMigrations(db: Database.Database): void {
  for (const file of MIGRATION_FILES) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    db.exec(sql);
  }
}
