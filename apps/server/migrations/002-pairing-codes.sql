-- 002-pairing-codes.sql: Add pairing codes table for one-time Telegram pairing

CREATE TABLE IF NOT EXISTS pairing_codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  consumed INTEGER NOT NULL DEFAULT 0,
  consumed_by_client_id TEXT,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pairing_codes_code ON pairing_codes(code);
