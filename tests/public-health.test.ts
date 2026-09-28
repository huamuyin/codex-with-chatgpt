import { describe, expect, it, vi } from "vitest";
import { checkPublicBridgeWithRepair, probePublicBridge } from "../src/bridge/public-health.js";

const URL = "https://synthetic.example.com";
const workspaceId = "synthetic-workspace";
const good = () => new Response(JSON.stringify({ service: "c2c-bridge", status: "ok", workspaceId }));

describe("strict public bridge health", () => {
  it("requires exact service/status/workspace identity with redirect denial and a bounded request", async () => {
    const fetchImpl = vi.fn(async () => good());
    expect((await probePublicBridge(URL, workspaceId, { fetchImpl })).ready).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(new globalThis.URL(`${URL}/health`), {
      redirect: "error", signal: expect.any(AbortSignal),
    });
  });

  it.each([
    { service: "another-service", status: "ok", workspaceId },
    { service: "c2c-bridge", status: "down", workspaceId },
    { service: "c2c-bridge", status: "ok", workspaceId: "another-workspace" },
    { service: "c2c-bridge", status: "ok" },
    null,
  ])("rejects HTTP 200 from the wrong identity %j", async (body) => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body)));
    expect((await probePublicBridge(URL, workspaceId, { fetchImpl })).ready).toBe(false);
  });

  it("rejects invalid JSON, HTTP failure and redirect responses", async () => {
    for (const response of [new Response("not json"), new Response(null, { status: 530 }), new Response(null, { status: 302 })]) {
      expect((await probePublicBridge(URL, workspaceId, { fetchImpl: async () => response })).ready).toBe(false);
    }
  });

  it("rejects a timed out request", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
    });
    expect((await probePublicBridge(URL, workspaceId, { fetchImpl, timeoutMs: 5 })).ready).toBe(false);
  });

  it("rejects credentials and non-HTTPS without sending a request", async () => {
    const fetchImpl = vi.fn(async () => good());
    for (const url of ["http://synthetic.example.com", "https://user:pass@synthetic.example.com"]) {
      expect((await probePublicBridge(url, workspaceId, { fetchImpl })).ready).toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("cannot turn a cached start URL into success after the public probe fails", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 530 }));
    const start = vi.fn(async () => URL);
    const result = await checkPublicBridgeWithRepair(URL, workspaceId, start, { fetchImpl });
    expect(result).toMatchObject({ ready: false, url: URL, started: true });
    expect(start).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("accepts a repaired URL only after fresh matching public health", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 530 }))
      .mockResolvedValueOnce(good());
    const result = await checkPublicBridgeWithRepair(URL, workspaceId, async () => URL, { fetchImpl });
    expect(result).toMatchObject({ ready: true, started: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not invoke start for healthy public identity or read-only diagnosis", async () => {
    const start = vi.fn(async () => URL);
    expect((await checkPublicBridgeWithRepair(URL, workspaceId, start, { fetchImpl: async () => good() })).started).toBe(false);
    expect(start).not.toHaveBeenCalled();
    expect((await checkPublicBridgeWithRepair(URL, workspaceId, undefined, { fetchImpl: async () => new Response(null, { status: 530 }) })).ready).toBe(false);
  });
});
