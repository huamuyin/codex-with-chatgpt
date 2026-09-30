import { chromium, type Browser } from "playwright-core";
import type { SharedRuntimeConfig } from "../config/shared-runtime.js";

export interface CdpLocator {
  count(): Promise<number>;
  first(): CdpLocator;
  nth(index: number): CdpLocator;
  innerText(options?: { timeout?: number }): Promise<string>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  click(options?: { timeout?: number }): Promise<void>;
  press(value: string, options?: { timeout?: number }): Promise<void>;
}

/** Narrow visible-page surface. It intentionally exposes no storage, cookies, network, or raw CDP APIs. */
export interface CdpUiPage {
  url(): string;
  title(): Promise<string>;
  goto(url: string, options?: { waitUntil?: "domcontentloaded" | "load"; timeout?: number }): Promise<unknown>;
  locator(selector: string): CdpLocator;
  getByRole(role: string, options?: { name?: string | RegExp }): CdpLocator;
  waitForTimeout(milliseconds: number): Promise<void>;
}

export interface CdpTarget {
  type: string;
  url: string;
  title?: string;
  page?: CdpUiPage;
}

export interface CdpConnection {
  listTargets(): Promise<CdpTarget[]>;
  disconnect(): Promise<void>;
}

export interface CdpAdapterDependencies {
  fetchVersion(endpoint: string): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  connect(webSocketEndpoint: string): Promise<CdpConnection>;
}

export interface SelectedChatTarget {
  url: string;
  title: string;
  page: CdpUiPage;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const CDP_TIMEOUT_MS = 8_000;

function cdpError(code: string): Error {
  return new Error(code);
}

export function validateLoopbackCdpEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw cdpError("CDP_ENDPOINT_NOT_LOOPBACK");
  }
  const port = Number(url.port);
  if (
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) ||
    !url.port ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw cdpError("CDP_ENDPOINT_NOT_LOOPBACK");
  }
  return url;
}

function validateWebSocketEndpoint(value: unknown, endpoint: URL): string {
  if (typeof value !== "string") throw cdpError("CDP_WEBSOCKET_INVALID");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw cdpError("CDP_WEBSOCKET_INVALID");
  }
  if (
    url.protocol !== "ws:" ||
    !LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) ||
    url.hostname.toLowerCase() !== endpoint.hostname.toLowerCase() ||
    Number(url.port) !== Number(endpoint.port) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(url.pathname)
  ) {
    throw cdpError("CDP_WEBSOCKET_NOT_LOOPBACK");
  }
  return url.toString();
}

function defaultDependencies(): CdpAdapterDependencies {
  return {
    async fetchVersion(endpoint) {
      const response = await fetch(`${endpoint.replace(/\/$/, "")}/json/version`, {
        redirect: "manual",
        signal: AbortSignal.timeout(CDP_TIMEOUT_MS),
      });
      return { ok: response.ok, status: response.status, json: () => response.json() };
    },
    async connect(webSocketEndpoint) {
      const browser = await chromium.connectOverCDP(webSocketEndpoint, {
        timeout: CDP_TIMEOUT_MS,
        noDefaults: true,
      });
      return playwrightConnection(browser);
    },
  };
}

function playwrightConnection(browser: Browser): CdpConnection {
  return {
    async listTargets() {
      const targets: CdpTarget[] = [];
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          let title = "";
          try {
            title = (await page.title()).slice(0, 256);
          } catch {
            // A closing or navigating visible tab is ignored by the later selection checks.
          }
          targets.push({ type: "page", url: page.url().slice(0, 2048), title, page: page as unknown as CdpUiPage });
        }
      }
      return targets;
    },
    async disconnect() {
      // Playwright's connected Browser.close() disconnects the CDP client; it does not launch or own Edge.
      await browser.close();
    },
  };
}

export function canonicalChatTargetUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      (url.hostname !== "chatgpt.com" && url.hostname !== "www.chatgpt.com") ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    ) {
      return null;
    }
    const match = url.pathname.match(/^\/c\/([A-Za-z0-9-]{1,160})\/?$/);
    return match ? `https://chatgpt.com/c/${match[1]}` : null;
  } catch {
    return null;
  }
}

export function selectChatGPTTarget(targets: CdpTarget[], requestedChatUrl?: string): SelectedChatTarget {
  const candidates = targets.filter(
    (target): target is CdpTarget & { page: CdpUiPage } =>
      target.type === "page" &&
      Boolean(target.page) &&
      /^https:\/\/(?:www\.)?chatgpt\.com(?:\/|$)/i.test(target.url)
  );
  if (!candidates.length) throw cdpError("NO_CHATGPT_TARGET");

  let selected: CdpTarget & { page: CdpUiPage };
  if (requestedChatUrl !== undefined) {
    const expected = canonicalChatTargetUrl(requestedChatUrl);
    if (!expected) throw cdpError("CHATGPT_CHAT_URL_INVALID");
    const matches = candidates.filter((target) => canonicalChatTargetUrl(target.url) === expected);
    if (!matches.length) throw cdpError("CHATGPT_TARGET_NOT_FOUND");
    if (matches.length !== 1) throw cdpError("AMBIGUOUS_CHATGPT_TARGET");
    selected = matches[0]!;
  } else {
    if (candidates.length !== 1) throw cdpError("AMBIGUOUS_CHATGPT_TARGET");
    selected = candidates[0]!;
  }

  const url = canonicalChatTargetUrl(selected.url);
  if (!url) throw cdpError("CHATGPT_TARGET_NOT_FOUND");
  return { url, title: (selected.title ?? "").slice(0, 256), page: selected.page };
}

export class LocalCdpAdapter {
  private constructor(
    private readonly connection: CdpConnection,
    private readonly targets: CdpTarget[]
  ) {}

  static async attach(
    config: Pick<SharedRuntimeConfig, "cdpEndpoint">,
    dependencies: CdpAdapterDependencies = defaultDependencies()
  ): Promise<LocalCdpAdapter> {
    const endpoint = validateLoopbackCdpEndpoint(config.cdpEndpoint);
    let response: Awaited<ReturnType<CdpAdapterDependencies["fetchVersion"]>>;
    try {
      response = await dependencies.fetchVersion(endpoint.toString().replace(/\/$/, ""));
    } catch {
      throw cdpError("CDP_ATTACH_FAILED");
    }
    if (!response.ok) throw cdpError("CDP_ATTACH_FAILED");
    let discovery: unknown;
    try {
      discovery = await response.json();
    } catch {
      throw cdpError("CDP_DISCOVERY_INVALID");
    }
    if (!discovery || typeof discovery !== "object") throw cdpError("CDP_DISCOVERY_INVALID");
    const wsEndpoint = validateWebSocketEndpoint(
      (discovery as Record<string, unknown>).webSocketDebuggerUrl,
      endpoint
    );
    let connection: CdpConnection;
    try {
      connection = await dependencies.connect(wsEndpoint);
    } catch {
      throw cdpError("CDP_ATTACH_FAILED");
    }
    try {
      const targets = await connection.listTargets();
      return new LocalCdpAdapter(connection, targets);
    } catch {
      await connection.disconnect().catch(() => {});
      throw cdpError("CDP_TARGET_DISCOVERY_FAILED");
    }
  }

  listVisibleTargets(): Array<{ type: string; url: string; title: string }> {
    return this.targets
      .filter((target) => target.type === "page")
      .map((target) => ({ type: "page", url: target.url, title: (target.title ?? "").slice(0, 256) }));
  }

  selectChatPage(requestedChatUrl?: string): SelectedChatTarget {
    return selectChatGPTTarget(this.targets, requestedChatUrl);
  }

  async disconnect(): Promise<void> {
    await this.connection.disconnect();
  }
}
