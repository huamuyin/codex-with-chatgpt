import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStateDir } from "../src/config/paths.js";
import {
  LocalCdpAdapter,
  selectChatGPTTarget,
  validateLoopbackCdpEndpoint,
  type CdpAdapterDependencies,
  type CdpConnection,
  type CdpTarget,
  type CdpUiPage,
} from "../src/browser/cdp-adapter.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const CHAT_A = "https://chatgpt.com/c/123e4567-e89b-12d3-a456-426614174000";
const CHAT_B = "https://chatgpt.com/c/223e4567-e89b-12d3-a456-426614174000";

function page(url: string, title = "Reviewer"): CdpUiPage {
  const locator = {
    count: async () => 0,
    first() { return this; },
    nth() { return this; },
    innerText: async () => "",
    fill: async () => {},
    click: async () => {},
    press: async () => {},
  };
  return {
    url: () => url,
    title: async () => title,
    goto: async (target) => target,
    locator: () => locator,
    getByRole: () => locator,
    waitForTimeout: async () => {},
  };
}

function target(url: string, options: Partial<CdpTarget> = {}): CdpTarget {
  return { type: "page", url, title: "Reviewer", page: page(url), ...options };
}

function connection(targets: CdpTarget[]): CdpConnection {
  return { listTargets: async () => targets, disconnect: async () => {} };
}

function dependencies(targets: CdpTarget[], ws = "ws://127.0.0.1:9222/devtools/browser/test"): CdpAdapterDependencies {
  return {
    fetchVersion: async () => ({ ok: true, status: 200, json: async () => ({ webSocketDebuggerUrl: ws }) }),
    connect: async () => connection(targets),
  };
}

describe("LocalCdpAdapter", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it.each([
    "https://127.0.0.1:9222",
    "http://192.168.1.4:9222",
    "http://example.com:9222",
    "http://localhost",
    "http://localhost:65536",
  ])("rejects non-loopback or malformed CDP endpoint %s", (endpoint) => {
    expect(() => validateLoopbackCdpEndpoint(endpoint)).toThrow("CDP_ENDPOINT_NOT_LOOPBACK");
  });

  it("does not fetch or connect when endpoint is not loopback", async () => {
    const fetchVersion = vi.fn();
    const connect = vi.fn();
    await expect(
      LocalCdpAdapter.attach(
        { cdpEndpoint: "http://192.168.1.4:9222" },
        { fetchVersion, connect } as unknown as CdpAdapterDependencies
      )
    ).rejects.toThrow("CDP_ENDPOINT_NOT_LOOPBACK");
    expect(fetchVersion).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("returns stable errors for discovery and connection failures", async () => {
    await expect(
      LocalCdpAdapter.attach({ cdpEndpoint: "http://127.0.0.1:9222" }, {
        fetchVersion: async () => { throw new Error("network details hidden"); },
        connect: async () => connection([]),
      })
    ).rejects.toThrow("CDP_ATTACH_FAILED");
    await expect(
      LocalCdpAdapter.attach({ cdpEndpoint: "http://127.0.0.1:9222" }, {
        fetchVersion: async () => ({ ok: false, status: 302, json: async () => ({}) }),
        connect: async () => connection([]),
      })
    ).rejects.toThrow("CDP_ATTACH_FAILED");
    await expect(
      LocalCdpAdapter.attach({ cdpEndpoint: "http://127.0.0.1:9222" }, {
        fetchVersion: async () => ({ ok: true, status: 200, json: async () => ({ webSocketDebuggerUrl: "bad" }) }),
        connect: async () => connection([]),
      })
    ).rejects.toThrow("CDP_WEBSOCKET_INVALID");
    await expect(
      LocalCdpAdapter.attach({ cdpEndpoint: "http://127.0.0.1:9222" }, {
        fetchVersion: async () => ({ ok: true, status: 200, json: async () => ({ webSocketDebuggerUrl: "ws://evil.example:9222/devtools/browser/x" }) }),
        connect: async () => connection([]),
      })
    ).rejects.toThrow("CDP_WEBSOCKET_NOT_LOOPBACK");
    await expect(
      LocalCdpAdapter.attach({ cdpEndpoint: "http://127.0.0.1:9222" }, {
        fetchVersion: async () => ({ ok: true, status: 200, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/browser/x" }) }),
        connect: async () => connection([]),
      })
    ).rejects.toThrow("CDP_WEBSOCKET_NOT_LOOPBACK");
    await expect(
      LocalCdpAdapter.attach({ cdpEndpoint: "http://127.0.0.1:9222" }, {
        fetchVersion: async () => ({ ok: true, status: 200, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/x" }) }),
        connect: async () => { throw new Error("hidden connection detail"); },
      })
    ).rejects.toThrow("CDP_ATTACH_FAILED");
  });

  it("ignores non-page and unrelated targets, selecting the sole visible ChatGPT page", async () => {
    const adapter = await LocalCdpAdapter.attach(
      { cdpEndpoint: "http://127.0.0.1:9222" },
      dependencies([
        target("chrome-extension://abc/options.html"),
        target("https://example.com"),
        target(CHAT_A, { type: "service_worker", page: undefined }),
        target(CHAT_A, { title: "ChatGPT Reviewer" }),
      ])
    );
    expect(adapter.listVisibleTargets()).toHaveLength(3);
    expect(adapter.selectChatPage()).toEqual(expect.objectContaining({ url: CHAT_A, title: "ChatGPT Reviewer" }));
    await adapter.disconnect();
  });

  it("fails closed for zero, ambiguous and missing exact ChatGPT targets", () => {
    expect(() => selectChatGPTTarget([target("https://example.com")])).toThrow("NO_CHATGPT_TARGET");
    expect(() => selectChatGPTTarget([target(CHAT_A), target(CHAT_B)])).toThrow("AMBIGUOUS_CHATGPT_TARGET");
    expect(() => selectChatGPTTarget([target(CHAT_A)], CHAT_B)).toThrow("CHATGPT_TARGET_NOT_FOUND");
    expect(() => selectChatGPTTarget([target(CHAT_A)], "https://chatgpt.com/auth/login")).toThrow(
      "CHATGPT_CHAT_URL_INVALID"
    );
  });

  it("selects an exact canonical ChatGPT chat even when other eligible pages exist", () => {
    const selected = selectChatGPTTarget(
      [target("https://www.chatgpt.com/c/other?utm_source=smoke"), target(`${CHAT_A}/?model=latest`)],
      CHAT_A
    );
    expect(selected.url).toBe(CHAT_A);
  });

  it("does not create receipt or session state and exposes no auth/network collection surface", async () => {
    const dir = makeTmpDir("cdp-adapter-read-only");
    dirs.push(dir);
    process.env.C2C_STATE_DIR = dir;
    let disconnected = false;
    let fetched = "";
    let connected = "";
    const fakeConnection: CdpConnection = {
      listTargets: async () => [target(CHAT_A)],
      disconnect: async () => { disconnected = true; },
    };
    const adapter = await LocalCdpAdapter.attach({ cdpEndpoint: "http://127.0.0.1:9222" }, {
      fetchVersion: async (endpoint) => {
        fetched = endpoint;
        return { ok: true, status: 200, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/test" }) };
      },
      connect: async (ws) => { connected = ws; return fakeConnection; },
    });
    expect(adapter.selectChatPage(CHAT_A).url).toBe(CHAT_A);
    expect(Object.keys(adapter.selectChatPage(CHAT_A).page).sort()).toEqual([
      "getByRole", "goto", "locator", "title", "url", "waitForTimeout",
    ]);
    expect(fetched).toBe("http://127.0.0.1:9222");
    expect(connected).toBe("ws://127.0.0.1:9222/devtools/browser/test");
    await adapter.disconnect();
    expect(disconnected).toBe(true);
    expect(fs.existsSync(path.join(getStateDir(), "receipts"))).toBe(false);
    expect(fs.existsSync(path.join(getStateDir(), "sessions"))).toBe(false);
  });
});
