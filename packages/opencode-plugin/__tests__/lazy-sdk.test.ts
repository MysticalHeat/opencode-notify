import { describe, it, expect, vi, beforeEach } from "vitest"

describe("lazy SDK loading – SDK available", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("createNotifyPlugin can be imported without triggering @opencode-ai/sdk load", async () => {
    const { createNotifyPlugin } = await import("../src/notify.js")
    expect(typeof createNotifyPlugin).toBe("function")
    expect(createNotifyPlugin()).toBeDefined()
  })

  it("createOpencodeClient resolves with a client object", async () => {
    const { createOpencodeClient } = await import("../src/opencode-client.js")
    const client = await createOpencodeClient(new URL("http://localhost:4096"))
    expect(client).toBeDefined()
    expect(typeof client).toBe("object")
  })

  it("module-level imports of notify plugin succeed without SDK dependency", async () => {
    const { createNotifyPlugin, createOpencodeClient } = await import("../src/index.js")
    expect(typeof createNotifyPlugin).toBe("function")
    expect(typeof createOpencodeClient).toBe("function")
  })
})

describe("lazy SDK loading – SDK unavailable", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("createOpencodeClient throws when @opencode-ai/sdk v2 is missing", async () => {
    vi.doMock("@opencode-ai/sdk/v2", () => ({}))
    const { createOpencodeClient } = await import("../src/opencode-client.js")
    await expect(
      createOpencodeClient(new URL("http://localhost:4096")),
    ).rejects.toThrow("required to create an OpenCode client")
  })

  it("second call also throws (cached null result)", async () => {
    vi.doMock("@opencode-ai/sdk/v2", () => ({}))
    const { createOpencodeClient } = await import("../src/opencode-client.js")
    await expect(createOpencodeClient(new URL("http://localhost:4096"))).rejects.toThrow()
    await expect(createOpencodeClient(new URL("http://localhost:4096"))).rejects.toThrow()
  })

  it("createNotifyPlugin is still importable even if SDK is unavailable", async () => {
    vi.doMock("@opencode-ai/sdk/v2", () => ({}))
    const { createNotifyPlugin } = await import("../src/notify.js")
    expect(typeof createNotifyPlugin).toBe("function")
  })
})
