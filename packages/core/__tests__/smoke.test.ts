import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@repo/protocol";

describe("workspace smoke", () => {
  it("@repo/core imports @repo/protocol", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
