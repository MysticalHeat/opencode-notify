import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseClientMessage, parseServerMessage } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readFixture(name: string): unknown {
  const path = resolve(__dirname, "..", "fixtures", name);
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw);
}

// ─── VALID CLIENT MESSAGES ────────────────────────────

describe("parseClientMessage (valid)", () => {
  it("parses a hello message", () => {
    const input = readFixture("valid-client-hello.json");
    const result = parseClientMessage(input);
    expect(result).toEqual({
      protocolVersion: 1,
      messageId: "msg-0001-aaaa-bbbb-cccc",
      type: "hello",
      sentAt: "2025-07-11T12:00:00.000Z",
      payload: {
        clientId: "client-opencode-001",
        sessionId: "session-abc123",
      },
    });
  });

  it("parses a heartbeat message", () => {
    const input = readFixture("valid-client-heartbeat.json");
    const result = parseClientMessage(input);
    expect(result).toEqual({
      protocolVersion: 1,
      messageId: "msg-0002-bbbb-cccc-dddd",
      type: "heartbeat",
      sentAt: "2025-07-11T12:00:30.000Z",
      payload: {
        clientId: "client-opencode-001",
        sessionId: "session-abc123",
      },
    });
  });

  it("parses a pairing message", () => {
    const input = readFixture("valid-client-pairing.json");
    const result = parseClientMessage(input);
    expect(result).toEqual({
      protocolVersion: 1,
      messageId: "msg-0003-cccc-dddd-eeee",
      type: "pairing",
      sentAt: "2025-07-11T12:00:01.000Z",
      payload: {
        clientId: "client-opencode-001",
        sessionId: "session-abc123",
        pairingCode: "123456",
      },
    });
  });

  it("parses a request-upsert message with a question payload", () => {
    const input = readFixture("valid-client-request-upsert-question.json");
    const result = parseClientMessage(input);
    expect(result.type).toBe("request_upsert");
    if (result.type !== "request_upsert") throw new Error("wrong type");
    expect(result.payload.clientId).toBe("client-opencode-001");
    expect(result.payload.sessionId).toBe("session-abc123");
    expect(result.payload.requestId).toBe("req-001");
    expect(result.payload.expiresAt).toBe("2025-07-11T12:06:00.000Z");
    expect(result.payload.question).toBeDefined();
    expect(result.payload.question?.text).toBe("Which file should I edit?");
    expect(result.payload.question?.options).toHaveLength(3);
    expect(result.payload.question?.options[0]).toEqual({
      label: "Publish configs for all services",
      value: "opt-configs",
    });
  });

  it("parses a request-upsert message with a permission payload", () => {
    const input = readFixture("valid-client-request-upsert-permission.json");
    const result = parseClientMessage(input);
    expect(result.type).toBe("request_upsert");
    if (result.type !== "request_upsert") throw new Error("wrong type");
    expect(result.payload.permission).toBeDefined();
    expect(result.payload.permission?.action).toBe("read");
    expect(result.payload.permission?.patterns).toEqual(["**/*.ts", "**/*.json"]);
    expect(result.payload.permission?.display).toBe("Read project source files");
  });

  it("parses a request-cancel message", () => {
    const input = readFixture("valid-client-request-cancel.json");
    const result = parseClientMessage(input);
    expect(result).toEqual({
      protocolVersion: 1,
      messageId: "msg-0006-ffff-0001-0002",
      type: "request_cancel",
      sentAt: "2025-07-11T12:03:00.000Z",
      payload: {
        clientId: "client-opencode-001",
        sessionId: "session-abc123",
        requestId: "req-001",
      },
    });
  });
});

// ─── VALID SERVER MESSAGES ────────────────────────────

describe("parseServerMessage (valid)", () => {
  it("parses a pairing message", () => {
    const input = readFixture("valid-server-pairing.json");
    const result = parseServerMessage(input);
    expect(result).toEqual({
      protocolVersion: 1,
      messageId: "srv-0001-aaaa-bbbb-cccc",
      type: "pairing",
      sentAt: "2025-07-11T12:00:02.000Z",
      payload: {
        clientId: "client-opencode-001",
        sessionId: "session-abc123",
        paired: true,
      },
    });
  });

  it("parses a heartbeat message", () => {
    const input = readFixture("valid-server-heartbeat.json");
    const result = parseServerMessage(input);
    expect(result).toEqual({
      protocolVersion: 1,
      messageId: "srv-0002-bbbb-cccc-dddd",
      type: "heartbeat",
      sentAt: "2025-07-11T12:00:30.100Z",
      payload: {
        clientId: "client-opencode-001",
        sessionId: "session-abc123",
      },
    });
  });

  it("parses a decision message with answers", () => {
    const input = readFixture("valid-server-decision-answers.json");
    const result = parseServerMessage(input);
    expect(result.type).toBe("decision");
    if (result.type !== "decision") throw new Error("wrong type");
    expect(result.payload.requestId).toBe("req-001");
    expect(result.payload.answers).toBeDefined();
    expect(result.payload.answers).toHaveLength(1);
    expect(result.payload.answers![0]).toEqual({
      value: "opt-configs",
      label: "Publish configs for all services",
    });
  });

  it("parses a decision message with approved", () => {
    const input = readFixture("valid-server-decision-approved.json");
    const result = parseServerMessage(input);
    expect(result.type).toBe("decision");
    if (result.type !== "decision") throw new Error("wrong type");
    expect(result.payload.requestId).toBe("req-002");
    expect(result.payload.approved).toBe(true);
    expect(result.payload.answers).toBeUndefined();
  });

  it("parses a decision message with approved and always flag", () => {
    const input = readFixture("valid-server-decision-approved-always.json");
    const result = parseServerMessage(input);
    expect(result.type).toBe("decision");
    if (result.type !== "decision") throw new Error("wrong type");
    expect(result.payload.requestId).toBe("req-003");
    expect(result.payload.approved).toBe(true);
    expect(result.payload.always).toBe(true);
    expect(result.payload.answers).toBeUndefined();
  });

  it("parses an apply-result message", () => {
    const input = readFixture("valid-server-apply-result.json");
    const result = parseServerMessage(input);
    expect(result.type).toBe("apply_result");
    if (result.type !== "apply_result") throw new Error("wrong type");
    expect(result.payload.requestId).toBe("req-001");
    expect(result.payload.success).toBe(true);
  });

  it("parses an error message", () => {
    const input = readFixture("valid-server-error.json");
    const result = parseServerMessage(input);
    expect(result.type).toBe("error");
    if (result.type !== "error") throw new Error("wrong type");
    expect(result.payload.code).toBe("REQUEST_EXPIRED");
    expect(result.payload.message).toBe("The request has expired");
    expect(result.payload.requestId).toBe("req-001");
  });
});

// ─── ERROR: UNKNOWN VERSION ────────────────────────────

describe("parseClientMessage (rejects)", () => {
  it("rejects an unknown protocol version", () => {
    const input = readFixture("invalid-unknown-version.json");
    expect(() => parseClientMessage(input)).toThrow();
  });

  it("rejects a malformed message ID (empty string)", () => {
    const input = readFixture("invalid-malformed-message-id-empty.json");
    expect(() => parseClientMessage(input)).toThrow();
  });

  it("rejects a malformed message ID (whitespace only)", () => {
    const input = readFixture("invalid-malformed-message-id-spaces-only.json");
    expect(() => parseClientMessage(input)).toThrow();
  });

  it("rejects an unknown message type", () => {
    const input = readFixture("invalid-unknown-type.json");
    expect(() => parseClientMessage(input)).toThrow();
  });

  it("rejects a client ID exceeding max length", () => {
    const input = readFixture("invalid-size-client-id.json");
    expect(() => parseClientMessage(input)).toThrow();
  });
});

// ─── ERROR: INVALID NESTED QUESTION ANSWERS ────────────

describe("parseServerMessage (rejects)", () => {
  it("rejects a decision with missing answer value", () => {
    const input = readFixture("invalid-nested-question-answer-no-value.json");
    expect(() => parseServerMessage(input)).toThrow();
  });

  it("rejects a decision with empty answer value", () => {
    const input = readFixture("invalid-nested-question-answer-empty-value.json");
    expect(() => parseServerMessage(input)).toThrow();
  });

  it("rejects an ambiguous decision payload (both answers and approved)", () => {
    const input = readFixture("invalid-nested-question-answer-ambiguous-payload.json");
    expect(() => parseServerMessage(input)).toThrow();
  });
});
