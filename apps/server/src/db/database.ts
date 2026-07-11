import Database from "better-sqlite3";

export interface DatabaseHandle {
  db: Database.Database;
  close: () => void;
}

export function openDatabase(path: string): DatabaseHandle {
  const db = new Database(path);

  // Enable WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");

  // Enforce foreign key constraints
  db.pragma("foreign_keys = ON");

  // Set busy timeout to 5 seconds to reduce SQLITE_BUSY errors
  db.pragma("busy_timeout = 5000");

  return {
    db,
    close: () => db.close(),
  };
}
