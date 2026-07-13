import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATION_FILES = ["001-initial.sql", "002-pairing-codes.sql", "003-soft-revoke.sql", "004-outbox-expiry.sql", "005-callback-ids.sql"] as const;

function findMigrationsDir(): string {
  const bundled = join(__dirname, "..", "migrations");
  try {
    readFileSync(join(bundled, MIGRATION_FILES[0]), "utf-8");
    return bundled;
  } catch {
    /* not at bundled path */
  }
  return join(__dirname, "..", "..", "migrations");
}

export function runMigrations(db: Database.Database): void {
  const dir = findMigrationsDir();
  for (const file of MIGRATION_FILES) {
    const sql = readFileSync(join(dir, file), "utf-8");
    db.exec(sql);
  }
}
