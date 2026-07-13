-- 005-callback-ids.sql: Tables for Telegram callback IDs, ForceReply tracking, and multi-select state

CREATE TABLE IF NOT EXISTS telegram_callback_ids (
  action_id TEXT PRIMARY KEY,
  request_fk TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK(action_type IN (
    'permission_approve','permission_always','permission_reject',
    'question_select','question_multi_toggle','question_multi_done',
    'question_custom_text'
  )),
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  claimed_at TEXT
);

CREATE TABLE IF NOT EXISTS telegram_freply_tracking (
  id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  reply_message_id INTEGER NOT NULL,
  request_fk TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_decision_state (
  id TEXT PRIMARY KEY,
  request_fk TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  selected_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
