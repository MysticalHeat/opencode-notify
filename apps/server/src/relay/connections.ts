export interface ConnectionEntry {
  clientId: string;
  sessionId: string;
  ws: { send: (data: string) => void; close: (code?: number, reason?: string) => void };
  lastHeartbeat: number;
  heartbeatTimer: ReturnType<typeof setInterval> | undefined;
}

export interface ConnectionRegistry {
  register(
    clientId: string,
    sessionId: string,
    ws: ConnectionEntry["ws"],
    onTimeout: (clientId: string) => void,
  ): void;
  unregister(clientId: string): void;
  get(clientId: string): ConnectionEntry | undefined;
  has(clientId: string): boolean;
  all(): ConnectionEntry[];
  updateHeartbeat(clientId: string): void;
  size(): number;
  destroy(): void;
}

export function createConnectionRegistry(
  heartbeatIntervalMs: number,
  heartbeatTimeoutMs: number,
): ConnectionRegistry {
  const connections = new Map<string, ConnectionEntry>();

  function register(
    clientId: string,
    sessionId: string,
    ws: ConnectionEntry["ws"],
    onTimeout: (clientId: string) => void,
  ): void {
    const existing = connections.get(clientId);
    if (existing) {
      if (existing.heartbeatTimer) clearInterval(existing.heartbeatTimer);
      existing.ws.close(4001, "replaced by newer connection");
    }

    const entry: ConnectionEntry = {
      clientId,
      sessionId,
      ws,
      lastHeartbeat: Date.now(),
      heartbeatTimer: undefined,
    };

    entry.heartbeatTimer = setInterval(() => {
      const elapsed = Date.now() - entry.lastHeartbeat;
      if (elapsed > heartbeatTimeoutMs) {
        if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer);
        entry.heartbeatTimer = undefined;
        entry.ws.close(4002, "heartbeat timeout");
        connections.delete(clientId);
        onTimeout(clientId);
      }
    }, heartbeatIntervalMs);

    connections.set(clientId, entry);
  }

  function unregister(clientId: string): void {
    const entry = connections.get(clientId);
    if (entry) {
      if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer);
      entry.heartbeatTimer = undefined;
      connections.delete(clientId);
    }
  }

  function get(clientId: string): ConnectionEntry | undefined {
    return connections.get(clientId);
  }

  function has(clientId: string): boolean {
    return connections.has(clientId);
  }

  function all(): ConnectionEntry[] {
    return [...connections.values()];
  }

  function updateHeartbeat(clientId: string): void {
    const entry = connections.get(clientId);
    if (entry) {
      entry.lastHeartbeat = Date.now();
    }
  }

  function size(): number {
    return connections.size;
  }

  function destroy(): void {
    for (const [, entry] of connections) {
      if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer);
      entry.ws.close(4000, "server shutdown");
    }
    connections.clear();
  }

  return { register, unregister, get, has, all, updateHeartbeat, size, destroy };
}
