# OpenCode Notification Relay — Wire Protocol v1

## Overview

This document defines the versioned wire protocol for the OpenCode Notification
Relay. The protocol specifies message contracts exchanged between the OpenCode
client plugin and the relay server over a persistent transport (e.g.,
WebSocket).

## Message Direction

Messages are discriminated by origin:

| Direction          | Parser                  | Description                              |
|--------------------|-------------------------|------------------------------------------|
| Client → Server    | `parseClientMessage`    | OpenCode plugin sends to relay server    |
| Server → Client    | `parseServerMessage`    | Relay server sends to OpenCode plugin    |

## Envelope

Every message wraps its payload in an envelope:

```ts
type Envelope<TType extends string, TPayload> = {
  protocolVersion: 1
  messageId: string
  type: TType
  sentAt: string    // ISO 8601 datetime
  payload: TPayload
}
```

## Client → Server Messages

| Type              | Payload Key       | Description                            |
|-------------------|-------------------|----------------------------------------|
| `auth`            | exactly one of `token`, `pairingCode` | Authenticate the connection before all other messages |
| `hello`           | `clientId`, `sessionId` | Identity announcement after authentication |
| `heartbeat`       | `clientId`, `sessionId` | Keep-alive ping                    |
| `request_upsert`  | `clientId`, `sessionId`, `requestId`, `expiresAt` + `question` XOR `permission` | Create or update a user-facing request |
| `request_cancel`  | `clientId`, `sessionId`, `requestId` | Cancel an outstanding request |

### `request_upsert` payload variants

**Question** (preserves question text, option order, and OpenCode option labels):

```ts
{
  question: {
    text: string
    options: Array<{ label: string; value: string }>
    multiSelect?: boolean
  }
}
```

**Permission** (preserves action/permission, resource patterns, and safe display metadata):

```ts
{
  permission: {
    action: string
    patterns: string[]
    display: string
  }
}
```

Exactly one of `question` or `permission` must be present.

## Server → Client Messages

| Type           | Payload Key       | Description                              |
|----------------|-------------------|------------------------------------------|
| `pairing`      | `clientId`, `sessionId`, `paired` | Pairing confirmation      |
| `heartbeat`    | `clientId`, `sessionId` | Keep-alive acknowledgement          |
| `decision`     | `requestId`, `clientId`, `sessionId` + `answers` XOR `approved` | User decision |
| `apply_result` | `requestId`, `clientId`, `sessionId`, `success`, `error?` | Apply outcome |
| `error`        | `code`, `message`, `requestId?` | Protocol or application error |

### `decision` payload variants

**Answers** (question response — order preserved, carries OpenCode option labels):

```ts
{
  answers: Array<{ value: string; label: string }>
}
```

**Approved** (permission response):

```ts
{
  approved: boolean
}
```

Exactly one of `answers` or `approved` must be present.

## Compatibility Rule

Only `protocolVersion: 1` is accepted. Any message carrying a different
`protocolVersion` value is rejected with a schema error. Future protocol
versions that are not backwards-compatible must bump the version number and
require both sides to negotiate the version during the initial handshake
(see `hello` / `pairing`).

## Reconnect Behavior

Each connection begins with an `auth` message followed by `hello` after the
server confirms authentication. If the transport disconnects, the client must
re-authenticate and re-send `hello` on reconnection. The
server may re-deliver outstanding requests after receiving `hello` (typically
identified by `sessionId`).

Heartbeats (`heartbeat`) are expected at a transport-defined interval from
both sides. A missing heartbeat after a timeout should trigger
disconnection and reconnection by the client.

## Size Limits

The following field-level size limits are enforced by the Zod schemas:

| Field            | Max Length |
|------------------|-----------|
| `messageId`      | 256       |
| `clientId`       | 256       |
| `sessionId`      | 256       |
| `requestId`      | 256       |
| `pairingCode`    | 64        |
| Question `text`  | 4096      |
| Option `label`   | 1024      |
| Option `value`   | 256       |
| Permission `action` | 64     |
| Pattern          | 1024      |
| Permission `display` | 4096  |
| Error `code`     | 64        |
| Error `message`  | 4096      |
| Answer `value`   | 256       |
| Answer `label`   | 1024      |

All ID fields additionally require non-whitespace characters.
