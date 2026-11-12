ALTER TABLE requests ADD COLUMN telegram_send_state TEXT CHECK(telegram_send_state IN ('sending', 'sent'));
ALTER TABLE requests ADD COLUMN telegram_message_id INTEGER;
