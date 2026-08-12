import { afterEach, describe, expect, it } from "vitest";
import {
  healthReadyHandler,
  setBotReady,
  setDbReady,
  setSchemaReady,
} from "../src/health.js";

function replyDouble(): {
  reply: { code: (status: number) => { send: (body: unknown) => unknown } };
  getStatus: () => number;
  getBody: () => unknown;
} {
  let status = 200;
  let body: unknown;
  return {
    reply: {
      code(nextStatus: number) {
        status = nextStatus;
        return {
          send(nextBody: unknown) {
            body = nextBody;
            return nextBody;
          },
        };
      },
    },
    getStatus: () => status,
    getBody: () => body,
  };
}

afterEach(() => {
  setDbReady(false);
  setSchemaReady(false);
  setBotReady(false);
});

describe("health readiness", () => {
  it("does not become ready until the schema is validated", async () => {
    setDbReady(true);
    setBotReady(true);
    setSchemaReady(false);
    const double = replyDouble();

    await healthReadyHandler(null, double.reply);

    expect(double.getStatus()).toBe(503);
    expect(double.getBody()).toEqual({
      status: "error",
      dbReady: true,
      schemaReady: false,
      botReady: true,
    });
  });

  it("returns ready after database, schema, and bot initialization", async () => {
    setDbReady(true);
    setSchemaReady(true);
    setBotReady(true);

    await expect(healthReadyHandler(null, null)).resolves.toEqual({ status: "ok" });
  });
});
