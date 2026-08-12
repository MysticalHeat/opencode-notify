-- 006-pairing-confirmation.sql: Record Telegram approval for pairing codes.

ALTER TABLE pairing_codes ADD COLUMN confirmed_at TEXT;
ALTER TABLE pairing_codes ADD COLUMN confirmed_by_user_id INTEGER;
