### Task 7 Report: Telegram Approval Workflows

**Status:** Complete

**Tests:** 28 new tests (152 total, all passing)

#### Files Created
- `apps/server/src/telegram/render.ts` — Permission and question keyboard rendering with opaque callback IDs (<=64 bytes)
- `apps/server/src/telegram/callbacks.ts` — Callback query handler with atomic claim, authorization, stale/expired detection
- `apps/server/src/telegram/text-replies.ts` — ForceReply text correlation via chat_id, user_id, reply_to_message.message_id
- `apps/server/test/telegram.test.ts` — 28 tests covering all flows
- `apps/server/migrations/005-callback-ids.sql` — Tables: telegram_callback_ids, telegram_freply_tracking, telegram_decision_state

#### Files Modified
- `apps/server/src/telegram/bot.ts` — grammY Bot adapter with long polling, webhook handler (secret-token validation, no webhook activation), enqueueDecision integration
- `apps/server/src/db/repository.ts` — Added findRequestById, callback ID CRUD, ForceReply tracking CRUD, decision state CRUD
- `apps/server/src/db/migrate.ts` — Added 005-callback-ids.sql
- `apps/server/src/config.ts` — Added webhook.secretToken field
- `apps/server/eslint.config.js` — Added `_` prefix ignore pattern for unused vars
- `apps/server/package.json` — Added grammy dependency

#### Verification
- Typecheck: PASS (tsc --noEmit)
- Lint: PASS (eslint)
- Tests: 152/152 PASS (4 test files)
  - repository: 49/49
  - pairing: 51/51
  - relay: 24/24
  - telegram: 28/28

#### Coverage Summary
| Area | Tests | Status |
|------|-------|--------|
| Permission rendering (3 buttons) | 2 | PASS |
| Single-select question rendering | 1 | PASS |
| Multi-select question rendering | 1 | PASS |
| Permission callbacks (approve/always/reject) | 6 | PASS |
| Question callbacks (select/multi-toggle/multi-done) | 3 | PASS |
| Text replies (correlation/orphan/stale) | 3 | PASS |
| Decision integration with outbox | 2 | PASS |
| Bot adapter creation (long poll, webhook, postRequest) | 3 | PASS |
| Legacy bot handler backward compat | 2 | PASS |
| Duplicate update handling | 1 | PASS |
| Callback ID lifecycle | 2 | PASS |
| ForceReply correlation | 1 | PASS |
| Decision state CRUD | 1 | PASS |

#### Key Design Decisions
- Callback IDs are 43-character base64url (32 random bytes), well under 64-byte limit
- Actual action values stored in SQLite telegram_callback_ids table
- Atomic claim via `UPDATE ... WHERE claimed_at IS NULL RETURNING *` prevents races
- ForceReply correlation uses (chat_id, user_id, reply_message_id) triple, not global flag
- Multi-select state tracked in telegram_decision_state with JSON selected values
- grammY webhook handler validates X-Telegram-Bot-Api-Secret-Token but does not call setWebhook
- Decisions integrate to existing outbox via enqueueDecision helper
- Terminal answers remove/replace inline keyboards by editing message text
- `answerCallbackQuery` is always called before remote API work
- Backward compatible: createBotHandler still exported for existing command handling

#### Commit Message
```
feat(server): add Telegram approval workflows
```
