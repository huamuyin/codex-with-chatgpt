import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getStateDir } from "../src/config/paths.js";
import type { CdpLocator, CdpUiPage } from "../src/browser/cdp-adapter.js";
import {
  deliverLocalControl,
  resumeLocalControl,
  type ControlBrowser,
  type ControlTransportDependencies,
} from "../src/browser/control-transport.js";
import { type SavedSession } from "../src/session/state.js";
import { markExecutedLocal } from "../src/session/protocol.js";
import type { BrowserReceipt, BrowserReceiptExpected } from "../src/session/browser-receipt.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const CHAT = "https://chatgpt.com/c/123e4567-e89b-12d3-a456-426614174000";
const CONTROL = "CTRL-CDP-R1-ABC";
const MESSAGE = [
  "[C2C-V2]",
  "STATE: TRANSPORT_PING",
  "MISSION_ID: CONTROL_TRANSPORT_TEST",
  "ROUND: 1",
  `CONTROL_ID: ${CONTROL}`,
  "REQUEST:",
  "Reply with STATE: REVIEW and echo the exact identity fields.",
].join("\n");

interface Fixture {
  deps: ControlTransportDependencies;
  input: BrowserReceiptExpected & { message: string };
  sent: string[];
  attachCount: () => number;
  session: () => SavedSession;
  setAssistant(text: string | null): void;
  setAutomaticReply(enabled: boolean): void;
  setReplyControlId(controlId: string): void;
  setVisibleRequest(): void;
}

function makeFixture(options: { conversationMode?: "project" | "long-chat"; composer?: boolean; send?: boolean } = {}): Fixture {
  const workspaceId = options.conversationMode === "project" ? "project-workspace" : "long-chat-workspace";
  let session = markExecutedLocal(
    options.conversationMode === "project"
      ? {
          conversationMode: "project",
          projectUrl: "https://chatgpt.com/g/g-p-abc123/project",
          url: CHAT,
          savedAt: "2026-09-30T07:00:00.000Z",
        }
      : { conversationMode: "long-chat", url: CHAT, savedAt: "2026-09-30T07:00:00.000Z" },
    {
      taskId: "CONTROL_TRANSPORT_TEST",
      iteration: 1,
      controlId: CONTROL,
      chatUrl: CHAT,
      waitingFor: "none",
      originalGoal: "verify UI control transport",
    }
  );
  let assistantText: string | null = null;
  let occurrences = 0;
  let automaticReply = true;
  let replyControlId = CONTROL;
  let clock = Date.parse("2026-09-30T08:00:00.000Z");
  let attached = 0;
  const sent: string[] = [];
  const receipts = new Map<string, BrowserReceipt>();
  const key = (expected: BrowserReceiptExpected): string => `${expected.workspaceId}|${expected.taskId}|${expected.round}|${expected.controlId}`;
  const locator = (selector: string): CdpLocator => ({
    count: async () => {
      if (selector === "div[data-chatgpt-selection-message-id]") return assistantText ? 1 : 0;
      if (selector === '[data-message-author-role="assistant"]') return 0;
      if (selector === '[data-message-author-role="user"]') return occurrences > 0 ? 1 : 0;
      if (selector.includes("prompt-textarea")) return options.composer === false ? 0 : 1;
      if (selector.includes("send-button")) return options.send === false ? 0 : 1;
      if (selector.includes("stop-button") || selector.includes("Stop") || selector.includes("停止")) return 0;
      return 0;
    },
    isVisible: async () => selector.includes("send-button")
      ? options.send !== false
      : selector.includes("prompt-textarea")
        ? options.composer !== false
        : !selector.includes("stop-button"),
    isEnabled: async () => options.send !== false,
    first() { return this; },
    nth() { return this; },
    innerText: async () => selector === '[data-message-author-role="user"]' ? sent.at(-1) ?? "" : assistantText ?? "",
    fill: async (text) => { sent.push(text); },
    click: async () => {
      occurrences = 1;
      const message = sent.at(-1) ?? "";
      if (message) occurrences = 1;
      if (automaticReply && message) assistantText = reviewerReply(replyControlId);
    },
    press: async () => {},
  });
  const page: CdpUiPage = {
    url: () => CHAT,
    title: async () => "Reviewer",
    goto: async () => {},
    locator,
    getByRole: () => locator("role"),
    getByText: () => ({ ...locator("control-text"), count: async () => occurrences + (assistantText ? 1 : 0) }),
    waitForTimeout: async (milliseconds) => { clock += milliseconds; },
  };
  const browser: ControlBrowser = {
    openOrSelectChatPage: async (chatUrl) => ({ url: chatUrl, title: "Reviewer", page }),
    disconnect: async () => {},
  };
  const deps: ControlTransportDependencies = {
    getTransport: () => "local-cdp",
    getConfig: () => ({
      schemaVersion: 1,
      transportMode: "local-cdp",
      cdpEndpoint: "http://127.0.0.1:9222",
      browser: "edge",
      profileIdentity: "test-profile",
      lifecycleMode: "external",
      configuredAt: "2026-09-30T07:00:00.000Z",
    }),
    readSession: () => session,
    writeSession: (_workspaceId, value) => { session = value; },
    getReceipt: (expected) => receipts.get(key(expected)) ?? null,
    listReceipts: () => [...receipts.values()],
    storeReceipt: (value) => { receipts.set(key(value), value); return value; },
    attach: async () => { attached += 1; return browser; },
    now: () => clock,
    wait: async (_page, ms) => { clock += ms; },
    waitTimeoutMs: 2_000,
  };
  const input = {
    workspaceId,
    taskId: "CONTROL_TRANSPORT_TEST",
    round: 1,
    controlId: CONTROL,
    chatUrl: CHAT,
    message: MESSAGE,
  };
  return {
    deps,
    input,
    sent,
    attachCount: () => attached,
    session: () => session,
    setAssistant(text) { assistantText = text; if (text) occurrences = 1; },
    setAutomaticReply(enabled) { automaticReply = enabled; },
    setReplyControlId(controlId) { replyControlId = controlId; },
    setVisibleRequest() { sent.push(MESSAGE); occurrences = 1; },
  };
}

function reviewerReply(controlId = CONTROL): string {
  return [
    "STATE: REVIEW",
    "MISSION_ID: CONTROL_TRANSPORT_TEST",
    "ROUND: 1",
    `CONTROL_ID: ${controlId}`,
    "Review result: accepted.",
  ].join("\n");
}

describe("local CDP control transport", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  function isolate(name: string): void {
    const dir = makeTmpDir(name);
    dirs.push(dir);
    process.env.C2C_STATE_DIR = dir;
  }

  it("sends once, reads the matching visible reply, stores a bounded receipt and gates EXECUTED_SENT", async () => {
    isolate("control-transport-success");
    const fixture = makeFixture({ conversationMode: "project" });
    const result = await deliverLocalControl(fixture.input, fixture.deps);
    expect(result.status).toBe("EXECUTED_SENT");
    expect(result.recovered).toBe(false);
    expect(result.receipt.controlId).toBe(CONTROL);
    expect(result.receipt.responseTextPresent).toBe(true);
    expect(fixture.sent).toEqual([MESSAGE]);
    expect(fixture.session().checkpoint?.protocolState).toBe("EXECUTED_SENT");
    expect(fixture.session().conversationMode).toBe("project");
    const journal = fs.readFileSync(path.join(getStateDir(), "deliveries", `${fixture.input.workspaceId}.json`), "utf8");
    expect(journal).not.toContain(MESSAGE);
    expect(journal).toContain("requestPayloadHash");
  });

  it("does not send without a visible composer or send control", async () => {
    isolate("control-transport-ui-gates");
    const noComposer = makeFixture({ composer: false });
    noComposer.deps.waitTimeoutMs = 0;
    await expect(deliverLocalControl(noComposer.input, noComposer.deps)).rejects.toThrow("CHAT_COMPOSER_NOT_READY");
    expect(noComposer.sent).toHaveLength(0);
    const noSend = makeFixture({ send: false });
    await expect(deliverLocalControl(noSend.input, noSend.deps)).rejects.toThrow("CHAT_SEND_CONTROL_NOT_FOUND");
    expect(noSend.sent).toHaveLength(0);
  });

  it("rejects a stale or mismatched CONTROL_ID response and never creates a receipt", async () => {
    isolate("control-transport-stale-response");
    const fixture = makeFixture();
    fixture.setReplyControlId("CTRL-STALE");
    await expect(deliverLocalControl(fixture.input, fixture.deps)).rejects.toThrow("CONTROL_RESPONSE_TIMEOUT");
    expect(fixture.sent).toHaveLength(1);
    expect(fixture.session().checkpoint?.protocolState).toBe("EXECUTED_LOCAL");
  });

  it("recovers a visible pending user control without resending after a process timeout", async () => {
    isolate("control-transport-reentry");
    const fixture = makeFixture();
    fixture.setAutomaticReply(false);
    await expect(deliverLocalControl(fixture.input, fixture.deps)).rejects.toThrow("CONTROL_RESPONSE_TIMEOUT");
    expect(fixture.sent).toHaveLength(1);
    fixture.setAssistant(reviewerReply());
    const result = await resumeLocalControl(fixture.input.workspaceId, MESSAGE, fixture.deps);
    expect(result).toMatchObject({ status: "EXECUTED_SENT", recovered: true });
    expect(fixture.sent).toHaveLength(1);
  });

  it("does not attach for legacy workspaces", async () => {
    isolate("control-transport-legacy");
    const fixture = makeFixture();
    fixture.deps.getTransport = () => "legacy";
    const result = await resumeLocalControl(fixture.input.workspaceId, MESSAGE, fixture.deps);
    expect(result).toEqual({ status: "LEGACY" });
    expect(fixture.attachCount()).toBe(0);
  });

  it("requires durable delivery intent before reconstructing a receipt from visible history", async () => {
    isolate("control-transport-no-intent");
    const fixture = makeFixture();
    fixture.setVisibleRequest();
    fixture.setAssistant(reviewerReply());
    await expect(deliverLocalControl(fixture.input, fixture.deps)).rejects.toThrow("DELIVERY_INTENT_MISSING");
  });

  it("fails closed on a wrong conversation target or attach failure and preserves EXECUTED_LOCAL", async () => {
    isolate("control-transport-target-failure");
    const wrongTarget = makeFixture();
    wrongTarget.deps.attach = async () => ({
      openOrSelectChatPage: async () => ({
        url: "https://chatgpt.com/c/223e4567-e89b-12d3-a456-426614174000",
        title: "Different chat",
        page: {} as CdpUiPage,
      }),
      disconnect: async () => {},
    });
    await expect(deliverLocalControl(wrongTarget.input, wrongTarget.deps)).rejects.toThrow("CHATGPT_TARGET_IDENTITY_MISMATCH");
    expect(wrongTarget.session().checkpoint?.protocolState).toBe("EXECUTED_LOCAL");

    const disconnected = makeFixture();
    disconnected.deps.attach = async () => { throw new Error("CDP unavailable"); };
    await expect(deliverLocalControl(disconnected.input, disconnected.deps)).rejects.toThrow("CDP unavailable");
    expect(disconnected.session().checkpoint?.protocolState).toBe("EXECUTED_LOCAL");
  });
});
