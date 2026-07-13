-- 003-soft-revoke.sql: Add revoked_at column for soft client revocation

ALTER TABLE clients ADD COLUMN revoked_at TEXT;
