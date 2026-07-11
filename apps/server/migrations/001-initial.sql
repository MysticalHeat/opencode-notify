-- 001-initial.sql: Create all tables for the notification relay server

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pairings (
  id TEXT PRIMARY KEY,
  client_a_id TEXT NOT NULL REFERENCES clients(id),
  client_b_id TEXT NOT NULL REFERENCES clients(id),
  pairing_code TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  UNIQUE(client_a_id, client_b_id)
);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES clients(id),
  session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','decided','dispatching','applied','rejected','expired','failed','cancelled')),
  expires_at TEXT NOT NULL,
  payload_type TEXT CHECK(payload_type IN ('question','permission')),
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(request_id, client_id, session_id)
);

CREATE TABLE IF NOT EXISTS request_answers (
  id TEXT PRIMARY KEY,
  request_fk TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id INTEGER PRIMARY KEY,
  payload_json TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  recipient_id TEXT NOT NULL REFERENCES clients(id),
  message_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);
