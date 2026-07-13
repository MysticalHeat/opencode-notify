-- 004-outbox-expiry.sql: Add request_id and expires_at to outbox for dispatch gating

ALTER TABLE outbox ADD COLUMN request_id TEXT;
ALTER TABLE outbox ADD COLUMN expires_at TEXT;
