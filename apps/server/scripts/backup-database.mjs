import Database from "better-sqlite3";
import { log } from "node:console";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const databasePath = process.env.DATABASE_PATH ?? "/data/opencode-notify.db";
const backupDirectory = process.env.BACKUP_DIRECTORY ?? "/data/backups";
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = join(backupDirectory, `opencode-notify-${timestamp}.db`);

mkdirSync(backupDirectory, { recursive: true });

const database = new Database(databasePath, { readonly: true });
try {
  await database.backup(backupPath);
  log(backupPath);
} finally {
  database.close();
}
