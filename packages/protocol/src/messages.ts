import { z } from "zod";

// ─── PROTOCOL VERSION ──────────────────────────────────

export const PROTOCOL_VERSION = 1 as const;

// ─── FIELD SIZE CONSTANTS ──────────────────────────────

const MAX_ID_LENGTH = 256;
const MAX_PAIRING_CODE_LENGTH = 64;
const MAX_QUESTION_TEXT_LENGTH = 4096;
const MAX_OPTION_LABEL_LENGTH = 1024;
const MAX_PATTERN_LENGTH = 1024;
const MAX_DISPLAY_LENGTH = 4096;
const MAX_ERROR_CODE_LENGTH = 64;
const MAX_ERROR_MESSAGE_LENGTH = 4096;

// ─── SHARED FIELD SCHEMAS ─────────────────────────────

const idField = z
  .string()
  .min(1)
  .max(MAX_ID_LENGTH)
  .refine((s) => s.trim().length > 0, {
    message: "ID must contain non-whitespace characters",
  });
const isoDatetime = z.string().datetime();

const clientIdField = idField;
const sessionIdField = idField;
const requestIdField = idField;
const messageIdField = idField;

// ─── PAYLOAD SCHEMAS ──────────────────────────────────

const answerSchema = z.object({
  value: z.string().min(1).max(MAX_ID_LENGTH),
  label: z.string().min(1).max(MAX_OPTION_LABEL_LENGTH),
});

const optionSchema = z.object({
  label: z.string().min(1).max(MAX_OPTION_LABEL_LENGTH),
  value: z.string().min(1).max(MAX_ID_LENGTH),
});

// ─── ENVELOPE BASE ─────────────────────────────────────

const envelopeBase = {
  protocolVersion: z.literal(1),
  messageId: messageIdField,
  sentAt: isoDatetime,
} as const;

// ─── CLIENT MESSAGE SCHEMAS ────────────────────────────

const helloMessageSchema = z.object({
  ...envelopeBase,
  type: z.literal("hello"),
  payload: z.object({
    clientId: clientIdField,
    sessionId: sessionIdField,
  }),
});

const heartbeatMessageSchema = z.object({
  ...envelopeBase,
  type: z.literal("heartbeat"),
  payload: z.object({
    clientId: clientIdField,
    sessionId: sessionIdField,
  }),
});

const pairingMessageSchema = z.object({
  ...envelopeBase,
  type: z.literal("pairing"),
  payload: z.object({
    clientId: clientIdField,
    sessionId: sessionIdField,
    pairingCode: z.string().min(1).max(MAX_PAIRING_CODE_LENGTH),
  }),
});

const questionPayloadSchema = z.object({
  text: z.string().min(1).max(MAX_QUESTION_TEXT_LENGTH),
  options: z.array(optionSchema).min(1),
  multiSelect: z.boolean().optional(),
});

const permissionPayloadSchema = z.object({
  action: z.string().min(1).max(MAX_ERROR_CODE_LENGTH),
  patterns: z.array(z.string().min(1).max(MAX_PATTERN_LENGTH)).min(1),
  display: z.string().min(1).max(MAX_DISPLAY_LENGTH),
});

const requestUpsertMessageSchema = z.object({
  ...envelopeBase,
  type: z.literal("request_upsert"),
  payload: z
    .object({
      clientId: clientIdField,
      sessionId: sessionIdField,
      requestId: requestIdField,
      expiresAt: isoDatetime,
      question: questionPayloadSchema.optional(),
      permission: permissionPayloadSchema.optional(),
    })
    .refine(
      (p) =>
        (p.question !== undefined && p.permission === undefined) ||
        (p.question === undefined && p.permission !== undefined),
      {
        message: "request_upsert payload must contain exactly one of 'question' or 'permission'",
      },
    ),
});

const requestCancelMessageSchema = z.object({
  ...envelopeBase,
  type: z.literal("request_cancel"),
  payload: z.object({
    clientId: clientIdField,
    sessionId: sessionIdField,
    requestId: requestIdField,
  }),
});

const clientMessageSchema = z.discriminatedUnion("type", [
  helloMessageSchema,
  heartbeatMessageSchema,
  pairingMessageSchema,
  requestUpsertMessageSchema,
  requestCancelMessageSchema,
]);

// ─── SERVER MESSAGE SCHEMAS ────────────────────────────

const serverPairingMessageSchema = z.object({
  ...envelopeBase,
  type: z.literal("pairing"),
  payload: z.object({
    clientId: clientIdField,
    sessionId: sessionIdField,
    paired: z.boolean(),
  }),
});

const serverHeartbeatMessageSchema = z.object({
  ...envelopeBase,
  type: z.literal("heartbeat"),
  payload: z.object({
    clientId: clientIdField,
    sessionId: sessionIdField,
  }),
});

const decisionMessageSchema = z.object({
  ...envelopeBase,
  type: z.literal("decision"),
  payload: z
    .object({
      requestId: requestIdField,
      clientId: clientIdField,
      sessionId: sessionIdField,
      answers: z.array(answerSchema).optional(),
      approved: z.boolean().optional(),
      always: z.boolean().optional(),
    })
    .refine(
      (p) =>
        (p.answers !== undefined && p.approved === undefined) ||
        (p.answers === undefined && p.approved !== undefined),
      {
        message: "decision payload must contain exactly one of 'answers' or 'approved'",
      },
    ),
});

const applyResultMessageSchema = z.object({
  ...envelopeBase,
  type: z.literal("apply_result"),
  payload: z.object({
    requestId: requestIdField,
    clientId: clientIdField,
    sessionId: sessionIdField,
    success: z.boolean(),
    error: z.string().max(MAX_ERROR_MESSAGE_LENGTH).optional(),
  }),
});

const errorMessageSchema = z.object({
  ...envelopeBase,
  type: z.literal("error"),
  payload: z.object({
    code: z.string().min(1).max(MAX_ERROR_CODE_LENGTH),
    message: z.string().min(1).max(MAX_ERROR_MESSAGE_LENGTH),
    requestId: requestIdField.optional(),
  }),
});

const serverMessageSchema = z.discriminatedUnion("type", [
  serverPairingMessageSchema,
  serverHeartbeatMessageSchema,
  decisionMessageSchema,
  applyResultMessageSchema,
  errorMessageSchema,
]);

// ─── INFERRED TYPES ────────────────────────────────────

export type HelloMessage = z.infer<typeof helloMessageSchema>;
export type HeartbeatMessage = z.infer<typeof heartbeatMessageSchema>;
export type PairingMessage = z.infer<typeof pairingMessageSchema>;
export type RequestUpsertMessage = z.infer<typeof requestUpsertMessageSchema>;
export type RequestCancelMessage = z.infer<typeof requestCancelMessageSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type ServerPairingMessage = z.infer<typeof serverPairingMessageSchema>;
export type ServerHeartbeatMessage = z.infer<typeof serverHeartbeatMessageSchema>;
export type DecisionMessage = z.infer<typeof decisionMessageSchema>;
export type ApplyResultMessage = z.infer<typeof applyResultMessageSchema>;
export type ErrorMessage = z.infer<typeof errorMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export { answerSchema, optionSchema, questionPayloadSchema, permissionPayloadSchema };

// ─── ENVELOPE TYPE ─────────────────────────────────────

export type Envelope<TType extends string, TPayload> = {
  protocolVersion: 1;
  messageId: string;
  type: TType;
  sentAt: string;
  payload: TPayload;
};

// ─── PARSER FUNCTIONS ──────────────────────────────────

export function parseClientMessage(input: unknown): ClientMessage {
  return clientMessageSchema.parse(input);
}

export function parseServerMessage(input: unknown): ServerMessage {
  return serverMessageSchema.parse(input);
}
