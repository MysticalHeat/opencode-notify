export interface HealthState {
  dbReady: boolean;
  schemaReady: boolean;
  botReady: boolean;
}

let state: HealthState = {
  dbReady: false,
  schemaReady: false,
  botReady: false,
};

export function setDbReady(ready: boolean): void {
  state = { ...state, dbReady: ready };
}

export function setSchemaReady(ready: boolean): void {
  state = { ...state, schemaReady: ready };
}

export function setBotReady(ready: boolean): void {
  state = { ...state, botReady: ready };
}

export function getHealthState(): Readonly<HealthState> {
  return { ...state };
}

export async function healthLiveHandler(
  _request: unknown,
  _reply: unknown,
): Promise<{ status: string }> {
  return { status: "ok" };
}

export async function healthReadyHandler(
  _request: unknown,
  reply: unknown,
): Promise<{ status: string } | unknown> {
  if (state.dbReady && state.schemaReady && state.botReady) {
    return { status: "ok" };
  }
  const r = reply as { code: (c: number) => { send: (b: unknown) => unknown } };
  return r.code(503).send({
    status: "error",
    dbReady: state.dbReady,
    schemaReady: state.schemaReady,
    botReady: state.botReady,
  });
}
