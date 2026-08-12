import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";

// ─── Row types ────────────────────────────────────────────

export interface ClientRow {
  id: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

export interface PairingRow {
  id: string;
  clientAId: string;
  clientBId: string;
  pairingCode: string;
  createdAt: string;
  expiresAt: string;
}

export interface PairingCodeRow {
  id: string;
  code: string;
  consumed: number;
  consumedByClientId: string | null;
  consumedAt: string | null;
  createdAt: string;
  expiresAt: string;
  confirmedAt: string | null;
  confirmedByUserId: number | null;
}

export type RequestStatus =
  | "pending"
  | "decided"
  | "dispatching"
  | "applied"
  | "rejected"
  | "expired"
  | "failed"
  | "cancelled";

export interface RequestRow {
  id: string;
  requestId: string;
  clientId: string;
  sessionId: string;
  status: RequestStatus;
  expiresAt: string;
  payloadType: string | null;
  payloadJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RequestAnswerRow {
  id: string;
  requestFk: string;
  value: string;
  label: string;
  createdAt: string;
}

export interface TelegramUpdateRow {
  updateId: number;
  payloadJson: string;
  processedAt: string;
}

export interface OutboxRow {
  id: string;
  idempotencyKey: string;
  recipientId: string;
  messageType: string;
  payloadJson: string;
  status: "pending" | "sent" | "failed";
  createdAt: string;
  sentAt: string | null;
  requestId: string | null;
  expiresAt: string | null;
}

export interface CallbackIdRow {
  actionId: string;
  requestFk: string;
  actionType: string;
  payloadJson: string | null;
  createdAt: string;
  expiresAt: string;
  claimedAt: string | null;
}

export interface FreplyTrackingRow {
  id: string;
  chatId: number;
  userId: number;
  replyMessageId: number;
  requestFk: string;
  createdAt: string;
  expiresAt: string;
}

export interface DecisionStateRow {
  id: string;
  requestFk: string;
  chatId: number;
  userId: number;
  messageId: number;
  selectedJson: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Repository interface ─────────────────────────────────

export interface Repository {
  // clients
  createClient(token: string): ClientRow;
  findClientByTokenHash(tokenHash: string): ClientRow | undefined;
  updateLastSeen(clientId: string): void;

  // pairings
  createPairing(
    clientAId: string,
    clientBId: string,
    pairingCode: string,
    expiresAt: Date,
  ): PairingRow;
  findActivePairing(clientId: string): PairingRow | undefined;
  expirePairings(): number;

  // requests
  upsertRequest(params: UpsertRequestParams): RequestRow;
  findRequest(
    requestId: string,
    clientId: string,
    sessionId: string,
  ): RequestRow | undefined;
  findRequestByRequestIdAndClient(
    requestId: string,
    clientId: string,
  ): RequestRow | undefined;
  findRequestById(id: string): RequestRow | undefined;
  updateRequestStatus(id: string, status: RequestStatus): RequestRow;
  expireRequests(): number;

  // request_answers
  saveAnswers(
    requestFk: string,
    answers: Array<{ value: string; label: string }>,
  ): void;
  findAnswers(requestFk: string): RequestAnswerRow[];

  // telegram_updates
  insertTelegramUpdate(updateId: number, payload: unknown): boolean;
  findTelegramUpdate(updateId: number): TelegramUpdateRow | undefined;

  // outbox
  enqueue(params: EnqueueParams): OutboxRow;
  dequeuePending(limit: number): OutboxRow[];
  markSent(id: string): void;
  markFailed(id: string): void;
  markSentByRequestAndClient(requestId: string, clientId: string): number;

  // pairing codes (one-time, short-lived)
  createPairingCode(code: string, expiresAt: Date): PairingCodeRow;
  findPairingCodeByCode(code: string): PairingCodeRow | undefined;
  consumePairingCode(code: string, clientId: string): boolean;
  confirmAndConsumePairingCode(code: string, clientId: string, telegramUserId: number): boolean;
  expirePairingCodes(): number;

  // client management
  createClientWithId(id: string, token: string): ClientRow;
  deleteClient(clientId: string): boolean;
  revokeClient(clientId: string): boolean;
  listAllClients(): ClientRow[];

  // pairing code cleanup
  unconsumePairingCode(code: string): boolean;

  // atomic compensation: delete client + unconsume pairing code in one transaction
  compensateCallbackFailure(clientId: string, code: string): boolean;

  // callback IDs
  createCallbackId(
    actionId: string,
    requestFk: string,
    actionType: string,
    expiresAt: Date,
    payload: unknown,
  ): CallbackIdRow;
  findAndClaimCallbackId(actionId: string): CallbackIdRow | undefined;

  // ForceReply tracking
  createFreplyTracking(
    chatId: number,
    userId: number,
    replyMessageId: number,
    requestFk: string,
    expiresAt: Date,
  ): FreplyTrackingRow;
  findFreplyTracking(
    chatId: number,
    userId: number,
    replyMessageId: number,
  ): FreplyTrackingRow | undefined;
  deleteFreplyTracking(id: string): void;

  // multi-select decision state
  createDecisionState(
    requestFk: string,
    chatId: number,
    userId: number,
    messageId: number,
    selectedValues: string[],
  ): DecisionStateRow;
  findDecisionState(requestFk: string, chatId: number, userId: number): DecisionStateRow | undefined;
  updateDecisionState(id: string, selectedJson: string): void;
  deleteDecisionState(id: string): void;
}

export interface UpsertRequestParams {
  requestId: string;
  clientId: string;
  sessionId: string;
  status: RequestStatus;
  expiresAt: Date;
  payloadType?: "question" | "permission";
  payloadJson?: string;
}

export interface EnqueueParams {
  idempotencyKey: string;
  recipientId: string;
  messageType: string;
  payload: unknown;
  requestId?: string;
  expiresAt?: Date;
}

// ─── Helpers ──────────────────────────────────────────────

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function mapClient(row: Record<string, unknown>): ClientRow {
  return {
    id: row.id as string,
    tokenHash: row.token_hash as string,
    createdAt: row.created_at as string,
    lastSeenAt: row.last_seen_at as string,
    revokedAt: (row.revoked_at as string) ?? null,
  };
}

function mapPairing(row: Record<string, unknown>): PairingRow {
  return {
    id: row.id as string,
    clientAId: row.client_a_id as string,
    clientBId: row.client_b_id as string,
    pairingCode: row.pairing_code as string,
    createdAt: row.created_at as string,
    expiresAt: row.expires_at as string,
  };
}

function mapRequest(row: Record<string, unknown>): RequestRow {
  return {
    id: row.id as string,
    requestId: row.request_id as string,
    clientId: row.client_id as string,
    sessionId: row.session_id as string,
    status: row.status as RequestStatus,
    expiresAt: row.expires_at as string,
    payloadType: row.payload_type as string | null,
    payloadJson: row.payload_json as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapAnswer(row: Record<string, unknown>): RequestAnswerRow {
  return {
    id: row.id as string,
    requestFk: row.request_fk as string,
    value: row.value as string,
    label: row.label as string,
    createdAt: row.created_at as string,
  };
}

function mapTelegram(row: Record<string, unknown>): TelegramUpdateRow {
  return {
    updateId: row.update_id as number,
    payloadJson: row.payload_json as string,
    processedAt: row.processed_at as string,
  };
}

function mapPairingCode(row: Record<string, unknown>): PairingCodeRow {
  return {
    id: row.id as string,
    code: row.code as string,
    consumed: row.consumed as number,
    consumedByClientId: row.consumed_by_client_id as string | null,
    consumedAt: row.consumed_at as string | null,
    createdAt: row.created_at as string,
    expiresAt: row.expires_at as string,
    confirmedAt: row.confirmed_at as string | null,
    confirmedByUserId: row.confirmed_by_user_id as number | null,
  };
}

function mapOutbox(row: Record<string, unknown>): OutboxRow {
  return {
    id: row.id as string,
    idempotencyKey: row.idempotency_key as string,
    recipientId: row.recipient_id as string,
    messageType: row.message_type as string,
    payloadJson: row.payload_json as string,
    status: row.status as OutboxRow["status"],
    createdAt: row.created_at as string,
    sentAt: row.sent_at as string | null,
    requestId: (row.request_id as string) ?? null,
    expiresAt: (row.expires_at as string) ?? null,
  };
}

function toIso(date: Date): string {
  // Store full ISO 8601 UTC text so new Date() roundtrips correctly
  return date.toISOString();
}

function mapCallbackId(row: Record<string, unknown>): CallbackIdRow {
  return {
    actionId: row.action_id as string,
    requestFk: row.request_fk as string,
    actionType: row.action_type as string,
    payloadJson: (row.payload_json as string) ?? null,
    createdAt: row.created_at as string,
    expiresAt: row.expires_at as string,
    claimedAt: (row.claimed_at as string) ?? null,
  };
}

function mapFreply(row: Record<string, unknown>): FreplyTrackingRow {
  return {
    id: row.id as string,
    chatId: row.chat_id as number,
    userId: row.user_id as number,
    replyMessageId: row.reply_message_id as number,
    requestFk: row.request_fk as string,
    createdAt: row.created_at as string,
    expiresAt: row.expires_at as string,
  };
}

function mapDecisionState(row: Record<string, unknown>): DecisionStateRow {
  return {
    id: row.id as string,
    requestFk: row.request_fk as string,
    chatId: row.chat_id as number,
    userId: row.user_id as number,
    messageId: row.message_id as number,
    selectedJson: row.selected_json as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

const VALID_TRANSITIONS: Record<string, ReadonlySet<RequestStatus>> = {
  pending: new Set<RequestStatus>(["decided", "cancelled", "expired"]),
  decided: new Set<RequestStatus>(["dispatching", "cancelled", "expired"]),
  dispatching: new Set<RequestStatus>(["applied", "failed"]),
};

// ─── Repository implementation ────────────────────────────

export function createRepository(db: Database.Database): Repository {
  // ── Clients ──────────────────────────────────────────

  const createClientStmt = db.prepare(`
    INSERT INTO clients (id, token_hash, created_at, last_seen_at)
    VALUES (?, ?, datetime('now'), datetime('now'))
  `);

  const findClientByHashStmt = db.prepare(`
    SELECT * FROM clients WHERE token_hash = ? AND revoked_at IS NULL
  `);

  const updateLastSeenStmt = db.prepare(`
    UPDATE clients SET last_seen_at = datetime('now') WHERE id = ?
  `);

  // ── Pairings ─────────────────────────────────────────

  const createPairingStmt = db.prepare(`
    INSERT INTO pairings (id, client_a_id, client_b_id, pairing_code, created_at, expires_at)
    VALUES (?, ?, ?, ?, datetime('now'), ?)
  `);

  const findActivePairingStmt = db.prepare(`
    SELECT * FROM pairings
    WHERE (client_a_id = ? OR client_b_id = ?)
      AND datetime(expires_at) > datetime('now')
    LIMIT 1
  `);

  const expirePairingsStmt = db.prepare(`
    DELETE FROM pairings WHERE datetime(expires_at) <= datetime('now')
  `);

  // ── Requests ─────────────────────────────────────────

  const upsertRequestStmt = db.prepare(`
    INSERT INTO requests (id, request_id, client_id, session_id, status, expires_at, payload_type, payload_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(request_id, client_id, session_id) DO UPDATE SET
      expires_at = excluded.expires_at,
      payload_type = excluded.payload_type,
      payload_json = excluded.payload_json,
      updated_at = datetime('now')
    RETURNING *
  `);

  const findRequestStmt = db.prepare(`
    SELECT * FROM requests
    WHERE request_id = ? AND client_id = ? AND session_id = ?
  `);

  const updateRequestStatusStmt = db.prepare(`
    UPDATE requests
    SET status = ?, updated_at = datetime('now')
    WHERE id = ?
      AND status = ?
  `);

  const expireRequestsStmt = db.prepare(`
    UPDATE requests
    SET status = 'expired', updated_at = datetime('now')
    WHERE status = 'pending'
      AND datetime(expires_at) <= datetime('now')
  `);

  const countChangedStmt = db.prepare("SELECT changes() AS cnt");

  // ── Answers ──────────────────────────────────────────

  const insertAnswerStmt = db.prepare(`
    INSERT INTO request_answers (id, request_fk, value, label, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);

  const findAnswersStmt = db.prepare(`
    SELECT * FROM request_answers WHERE request_fk = ?
  `);

  // ── Telegram updates ─────────────────────────────────

  const insertTelegramStmt = db.prepare(`
    INSERT OR IGNORE INTO telegram_updates (update_id, payload_json, processed_at)
    VALUES (?, ?, datetime('now'))
  `);

  const findTelegramStmt = db.prepare(`
    SELECT * FROM telegram_updates WHERE update_id = ?
  `);

  // ── Outbox ───────────────────────────────────────────

  const enqueueStmt = db.prepare(`
    INSERT INTO outbox (id, idempotency_key, recipient_id, message_type, payload_json, status, created_at, request_id, expires_at)
    VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'), ?, ?)
  `);

  const dequeueStmt = db.prepare(`
    SELECT * FROM outbox
    WHERE status = 'pending'
      AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
    ORDER BY created_at ASC
    LIMIT ?
  `);

  const markSentStmt = db.prepare(`
    UPDATE outbox SET status = 'sent', sent_at = datetime('now') WHERE id = ?
  `);

  const markFailedStmt = db.prepare(`
    UPDATE outbox SET status = 'failed', sent_at = datetime('now') WHERE id = ?
  `);

  const markSentByRequestAndClientStmt = db.prepare(`
    UPDATE outbox SET status = 'sent', sent_at = datetime('now')
    WHERE recipient_id = ? AND request_id = ? AND status = 'pending'
  `);

  const findRequestByFieldsStmt = db.prepare(`
    SELECT * FROM requests
    WHERE request_id = ? AND client_id = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `);

  // ── Pairing Codes ─────────────────────────────────────

  const createPairingCodeStmt = db.prepare(`
    INSERT INTO pairing_codes (id, code, created_at, expires_at)
    VALUES (?, ?, datetime('now'), ?)
  `);

  const findPairingCodeByCodeStmt = db.prepare(`
    SELECT * FROM pairing_codes WHERE code = ?
  `);

  const consumePairingCodeStmt = db.prepare(`
    UPDATE pairing_codes
    SET consumed = 1,
        consumed_by_client_id = ?,
        consumed_at = datetime('now')
    WHERE code = ?
      AND consumed = 0
      AND datetime(expires_at) > datetime('now')
  `);

  const confirmAndConsumePairingCodeStmt = db.prepare(`
    UPDATE pairing_codes
    SET consumed = 1,
        consumed_by_client_id = ?,
        consumed_at = datetime('now'),
        confirmed_at = datetime('now'),
        confirmed_by_user_id = ?
    WHERE code = ?
      AND consumed = 0
      AND datetime(expires_at) > datetime('now')
  `);

  const expirePairingCodesStmt = db.prepare(`
    DELETE FROM pairing_codes WHERE datetime(expires_at) <= datetime('now')
  `);

  const deleteClientStmt = db.prepare(`
    DELETE FROM clients WHERE id = ?
  `);

  const revokeClientStmt = db.prepare(`
    UPDATE clients SET revoked_at = datetime('now') WHERE id = ?
  `);

  const listAllClientsStmt = db.prepare(`
    SELECT * FROM clients ORDER BY created_at ASC
  `);

  const unconsumePairingCodeStmt = db.prepare(`
    UPDATE pairing_codes
    SET consumed = 0,
        consumed_by_client_id = NULL,
        consumed_at = NULL,
        confirmed_at = NULL,
        confirmed_by_user_id = NULL
    WHERE code = ?
  `);

  // ── Callback IDs ─────────────────────────────────

  const createCallbackIdStmt = db.prepare(`
    INSERT INTO telegram_callback_ids (action_id, request_fk, action_type, payload_json, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const findAndClaimCallbackIdStmt = db.prepare(`
    UPDATE telegram_callback_ids
    SET claimed_at = datetime('now')
    WHERE action_id = ?
      AND claimed_at IS NULL
      AND datetime(expires_at) > datetime('now')
    RETURNING *
  `);

  // ── ForceReply tracking ──────────────────────────

  const createFreplyStmt = db.prepare(`
    INSERT INTO telegram_freply_tracking (id, chat_id, user_id, reply_message_id, request_fk, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const findFreplyStmt = db.prepare(`
    SELECT * FROM telegram_freply_tracking
    WHERE chat_id = ? AND user_id = ? AND reply_message_id = ?
      AND datetime(expires_at) > datetime('now')
  `);

  const deleteFreplyStmt = db.prepare(`
    DELETE FROM telegram_freply_tracking WHERE id = ?
  `);

  // ── Multi-select decision state ──────────────────

  const createDecisionStateStmt = db.prepare(`
    INSERT INTO telegram_decision_state (id, request_fk, chat_id, user_id, message_id, selected_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const findDecisionStateStmt = db.prepare(`
    SELECT * FROM telegram_decision_state
    WHERE request_fk = ? AND chat_id = ? AND user_id = ?
  `);

  const updateDecisionStateStmt = db.prepare(`
    UPDATE telegram_decision_state
    SET selected_json = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

  const deleteDecisionStateStmt = db.prepare(`
    DELETE FROM telegram_decision_state WHERE id = ?
  `);

  // ── Public API ───────────────────────────────────────

  return {
    createClient(token: string): ClientRow {
      const id = randomUUID();
      const tokenHash = hashToken(token);
      return db.transaction(() => {
        createClientStmt.run(id, tokenHash);
        return mapClient(
          db.prepare("SELECT * FROM clients WHERE id = ?").get(id) as Record<
            string,
            unknown
          >,
        );
      })();
    },

    findClientByTokenHash(tokenHash: string): ClientRow | undefined {
      const row = findClientByHashStmt.get(tokenHash) as
        | Record<string, unknown>
        | undefined;
      return row ? mapClient(row) : undefined;
    },

    updateLastSeen(clientId: string): void {
      db.transaction(() => {
        updateLastSeenStmt.run(clientId);
      })();
    },

    createPairing(
      clientAId: string,
      clientBId: string,
      pairingCode: string,
      expiresAt: Date,
    ): PairingRow {
      const id = randomUUID();
      const expiresStr = toIso(expiresAt);
      return db.transaction(() => {
        createPairingStmt.run(id, clientAId, clientBId, pairingCode, expiresStr);
        return mapPairing(
          db.prepare("SELECT * FROM pairings WHERE id = ?").get(id) as Record<
            string,
            unknown
          >,
        );
      })();
    },

    findActivePairing(clientId: string): PairingRow | undefined {
      const row = findActivePairingStmt.get(clientId, clientId) as
        | Record<string, unknown>
        | undefined;
      return row ? mapPairing(row) : undefined;
    },

    expirePairings(): number {
      return db.transaction(() => {
        const info = expirePairingsStmt.run();
        return info.changes;
      })();
    },

    upsertRequest(params: UpsertRequestParams): RequestRow {
      const id = randomUUID();
      const expiresStr = toIso(params.expiresAt);
      const payloadType = params.payloadType ?? null;
      const payloadJson = params.payloadJson ?? null;
      return db.transaction(() => {
        const row = upsertRequestStmt.get(
          id,
          params.requestId,
          params.clientId,
          params.sessionId,
          params.status,
          expiresStr,
          payloadType,
          payloadJson,
        ) as Record<string, unknown>;
        return mapRequest(row);
      })();
    },

    findRequest(
      requestId: string,
      clientId: string,
      sessionId: string,
    ): RequestRow | undefined {
      const row = findRequestStmt.get(requestId, clientId, sessionId) as
        | Record<string, unknown>
        | undefined;
      return row ? mapRequest(row) : undefined;
    },

    findRequestByRequestIdAndClient(
      requestId: string,
      clientId: string,
    ): RequestRow | undefined {
      const row = findRequestByFieldsStmt.get(requestId, clientId) as
        | Record<string, unknown>
        | undefined;
      return row ? mapRequest(row) : undefined;
    },

    findRequestById(id: string): RequestRow | undefined {
      const row = db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      return row ? mapRequest(row) : undefined;
    },

    updateRequestStatus(id: string, status: RequestStatus): RequestRow {
      return db.transaction(() => {
        // Determine allowed previous states for this transition
        const allowedPrev = new Set<RequestStatus>();
        for (const [prev, nexts] of Object.entries(VALID_TRANSITIONS)) {
          if (nexts.has(status)) {
            allowedPrev.add(prev as RequestStatus);
          }
        }

        // Try each allowed previous state via UPDATE then SELECT
        for (const prev of allowedPrev) {
          const info = updateRequestStatusStmt.run(status, id, prev);
          if (info.changes > 0) {
            const row = db
              .prepare("SELECT * FROM requests WHERE id = ?")
              .get(id) as Record<string, unknown>;
            return mapRequest(row);
          }
        }

        throw new Error(
          `Invalid state transition: cannot transition to ${status} for request ${id}`,
        );
      })();
    },

    expireRequests(): number {
      return db.transaction(() => {
        expireRequestsStmt.run();
        const cnt = countChangedStmt.get() as { cnt: number };
        return cnt.cnt;
      })();
    },

    saveAnswers(
      requestFk: string,
      answers: Array<{ value: string; label: string }>,
    ): void {
      db.transaction(() => {
        for (const a of answers) {
          insertAnswerStmt.run(randomUUID(), requestFk, a.value, a.label);
        }
      })();
    },

    findAnswers(requestFk: string): RequestAnswerRow[] {
      const rows = findAnswersStmt.all(requestFk) as Array<
        Record<string, unknown>
      >;
      return rows.map(mapAnswer);
    },

    insertTelegramUpdate(updateId: number, payload: unknown): boolean {
      const payloadJson = JSON.stringify(payload);
      return db.transaction(() => {
        insertTelegramStmt.run(updateId, payloadJson);
        const cnt = countChangedStmt.get() as { cnt: number };
        return cnt.cnt > 0;
      })();
    },

    findTelegramUpdate(updateId: number): TelegramUpdateRow | undefined {
      const row = findTelegramStmt.get(updateId) as
        | Record<string, unknown>
        | undefined;
      return row ? mapTelegram(row) : undefined;
    },

    enqueue(params: EnqueueParams): OutboxRow {
      const id = randomUUID();
      const payloadJson = JSON.stringify(params.payload);
      const requestId = params.requestId ?? null;
      const expiresAtStr = params.expiresAt ? toIso(params.expiresAt) : null;
      return db.transaction(() => {
        enqueueStmt.run(
          id,
          params.idempotencyKey,
          params.recipientId,
          params.messageType,
          payloadJson,
          requestId,
          expiresAtStr,
        );
        return mapOutbox(
          db.prepare("SELECT * FROM outbox WHERE id = ?").get(id) as Record<
            string,
            unknown
          >,
        );
      })();
    },

    dequeuePending(limit: number): OutboxRow[] {
      const rows = dequeueStmt.all(limit) as Array<Record<string, unknown>>;
      return rows.map(mapOutbox);
    },

    markSent(id: string): void {
      db.transaction(() => {
        markSentStmt.run(id);
      })();
    },

    markFailed(id: string): void {
      db.transaction(() => {
        markFailedStmt.run(id);
      })();
    },

    markSentByRequestAndClient(requestId: string, clientId: string): number {
      return db.transaction(() => {
        const info = markSentByRequestAndClientStmt.run(clientId, requestId);
        return info.changes;
      })();
    },

    // ── Pairing Codes ─────────────────────────────────

    createPairingCode(code: string, expiresAt: Date): PairingCodeRow {
      const id = randomUUID();
      const expiresStr = toIso(expiresAt);
      return db.transaction(() => {
        createPairingCodeStmt.run(id, code, expiresStr);
        return mapPairingCode(
          db
            .prepare("SELECT * FROM pairing_codes WHERE id = ?")
            .get(id) as Record<string, unknown>,
        );
      })();
    },

    findPairingCodeByCode(code: string): PairingCodeRow | undefined {
      const row = findPairingCodeByCodeStmt.get(code) as
        | Record<string, unknown>
        | undefined;
      return row ? mapPairingCode(row) : undefined;
    },

    consumePairingCode(code: string, clientId: string): boolean {
      return db.transaction(() => {
        const info = consumePairingCodeStmt.run(clientId, code);
        return info.changes > 0;
      })();
    },

    confirmAndConsumePairingCode(code: string, clientId: string, telegramUserId: number): boolean {
      confirmAndConsumePairingCodeStmt.run(clientId, telegramUserId, code);
      return (countChangedStmt.get() as { cnt: number }).cnt === 1;
    },

    expirePairingCodes(): number {
      return db.transaction(() => {
        const info = expirePairingCodesStmt.run();
        return info.changes;
      })();
    },

    // ── Client Management ──────────────────────────────

    createClientWithId(id: string, token: string): ClientRow {
      const tokenHash = hashToken(token);
      return db.transaction(() => {
        createClientStmt.run(id, tokenHash);
        return mapClient(
          db.prepare("SELECT * FROM clients WHERE id = ?").get(id) as Record<
            string,
            unknown
          >,
        );
      })();
    },

    deleteClient(clientId: string): boolean {
      return db.transaction(() => {
        const info = deleteClientStmt.run(clientId);
        return info.changes > 0;
      })();
    },

    revokeClient(clientId: string): boolean {
      return db.transaction(() => {
        const info = revokeClientStmt.run(clientId);
        return info.changes > 0;
      })();
    },

    listAllClients(): ClientRow[] {
      const rows = listAllClientsStmt.all() as Array<Record<string, unknown>>;
      return rows.map(mapClient);
    },

    // ── Pairing Code Cleanup ───────────────────────────

    unconsumePairingCode(code: string): boolean {
      return db.transaction(() => {
        const info = unconsumePairingCodeStmt.run(code);
        return info.changes > 0;
      })();
    },

    compensateCallbackFailure(clientId: string, code: string): boolean {
      return db.transaction(() => {
        const delInfo = deleteClientStmt.run(clientId);
        const uncInfo = unconsumePairingCodeStmt.run(code);
        return delInfo.changes > 0 || uncInfo.changes > 0;
      })();
    },

    // ── Callback IDs ───────────────────────────────

    createCallbackId(
      actionId: string,
      requestFk: string,
      actionType: string,
      expiresAt: Date,
      payload: unknown,
    ): CallbackIdRow {
      const payloadJson = JSON.stringify(payload);
      const expiresStr = toIso(expiresAt);
      return db.transaction(() => {
        createCallbackIdStmt.run(actionId, requestFk, actionType, payloadJson, expiresStr);
        return mapCallbackId(
          db.prepare("SELECT * FROM telegram_callback_ids WHERE action_id = ?").get(actionId) as Record<string, unknown>,
        );
      })();
    },

    findAndClaimCallbackId(actionId: string): CallbackIdRow | undefined {
      return db.transaction(() => {
        const row = findAndClaimCallbackIdStmt.get(actionId) as Record<string, unknown> | undefined;
        return row ? mapCallbackId(row) : undefined;
      })();
    },

    // ── ForceReply tracking ────────────────────────

    createFreplyTracking(
      chatId: number,
      userId: number,
      replyMessageId: number,
      requestFk: string,
      expiresAt: Date,
    ): FreplyTrackingRow {
      const id = randomUUID();
      const expiresStr = toIso(expiresAt);
      return db.transaction(() => {
        createFreplyStmt.run(id, chatId, userId, replyMessageId, requestFk, expiresStr);
        return mapFreply(
          db.prepare("SELECT * FROM telegram_freply_tracking WHERE id = ?").get(id) as Record<string, unknown>,
        );
      })();
    },

    findFreplyTracking(
      chatId: number,
      userId: number,
      replyMessageId: number,
    ): FreplyTrackingRow | undefined {
      const row = findFreplyStmt.get(chatId, userId, replyMessageId) as Record<string, unknown> | undefined;
      return row ? mapFreply(row) : undefined;
    },

    deleteFreplyTracking(id: string): void {
      db.transaction(() => {
        deleteFreplyStmt.run(id);
      })();
    },

    // ── Multi-select decision state ────────────────

    createDecisionState(
      requestFk: string,
      chatId: number,
      userId: number,
      messageId: number,
      selectedValues: string[],
    ): DecisionStateRow {
      const id = randomUUID();
      const selectedJson = JSON.stringify(selectedValues);
      return db.transaction(() => {
        createDecisionStateStmt.run(id, requestFk, chatId, userId, messageId, selectedJson);
        return mapDecisionState(
          db.prepare("SELECT * FROM telegram_decision_state WHERE id = ?").get(id) as Record<string, unknown>,
        );
      })();
    },

    findDecisionState(requestFk: string, chatId: number, userId: number): DecisionStateRow | undefined {
      const row = findDecisionStateStmt.get(requestFk, chatId, userId) as Record<string, unknown> | undefined;
      return row ? mapDecisionState(row) : undefined;
    },

    updateDecisionState(id: string, selectedJson: string): void {
      db.transaction(() => {
        updateDecisionStateStmt.run(selectedJson, id);
      })();
    },

    deleteDecisionState(id: string): void {
      db.transaction(() => {
        deleteDecisionStateStmt.run(id);
      })();
    },
  };
}
