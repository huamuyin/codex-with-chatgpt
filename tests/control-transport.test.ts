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
  clickCount: () => number;
  draft: () => string;
  session: () => SavedSession;
  setAssistant(text: string | null): void;
  setAutomaticReply(enabled: boolean): void;
  setReplyControlId(controlId: string): void;
  setVisibleRequest(text?: string): void;
  setSession(value: SavedSession): void;
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
  let draft = "";
  let submittedMessage = "";
  let clickCount = 0;
  const locator = (selector: string): CdpLocator => ({
    count: async () => {
      if (selector === "div[data-chatgpt-selection-message-id]") return assistantText ? 1 : 0;
      if (selector === '[data-message-author-role="assistant"]') return assistantText ? 1 : 0;
      if (selector === '[data-message-author-role="user"]') return occurrences > 0 ? 1 : 0;
      if (selector.includes("prompt-textarea") || selector.includes("contenteditable")) return options.composer === false ? 0 : 1;
      if (selector.includes("send-button") || selector.includes("composer-submit-button") || selector.includes("aria-label") || selector === "role") {
        return options.send === false || !draft ? 0 : 1;
      }
      if (selector.includes("stop-button") || selector.includes("Stop") || selector.includes("停止")) return 0;
      return 0;
    },
    isVisible: async () => selector.includes("send-button") || selector.includes("composer-submit-button") || selector.includes("aria-label") || selector === "role"
      ? options.send !== false && Boolean(draft)
      : selector.includes("prompt-textarea") || selector.includes("contenteditable")
        ? options.composer !== false
        : !selector.includes("stop-button"),
    isEnabled: async () => options.send !== false && Boolean(draft),
    first() { return this; },
    nth() { return this; },
    innerText: async () => selector === '[data-message-author-role="user"]' ? submittedMessage : assistantText ?? "",
    fill: async (text) => { draft = text; },
    click: async () => {
      occurrences = 1;
      const message = draft;
      if (message) occurrences = 1;
      if (message) {
        submittedMessage = message;
        sent.push(message);
        clickCount += 1;
        draft = "";
      }
      if (automaticReply && message) {
        const taskId = message.split(/\r?\n/).find((line) => line.startsWith("MISSION_ID: "))?.slice("MISSION_ID: ".length) ?? "";
        const round = Number(message.split(/\r?\n/).find((line) => line.startsWith("ROUND: "))?.slice("ROUND: ".length) ?? 0);
        assistantText = reviewerReply(replyControlId, taskId, round);
      }
    },
    press: async () => {},
  });
  const page: CdpUiPage = {
    url: () => CHAT,
    title: async () => "Reviewer",
    goto: async () => {},
    locator,
    getByRole: () => locator("role"),
    getByText: (text) => {
      const user = locator('[data-message-author-role="user"]');
      const assistant = locator('[data-message-author-role="assistant"]');
      return {
        count: async () => (occurrences > 0 && submittedMessage.includes(text) ? 1 : 0) + (assistantText?.includes(text) ? 1 : 0),
        first() { return this.nth(0); },
        nth(index) { return index === 0 && occurrences > 0 && submittedMessage.includes(text) ? user : assistant; },
        isVisible: async () => false,
        isEnabled: async () => false,
        innerText: async () => "",
        fill: async () => {},
        click: async () => {},
        press: async () => {},
      };
    },
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
    clickCount: () => clickCount,
    draft: () => draft,
    session: () => session,
    setAssistant(text) { assistantText = text; if (text) occurrences = 1; },
    setAutomaticReply(enabled) { automaticReply = enabled; },
    setReplyControlId(controlId) { replyControlId = controlId; },
    setVisibleRequest(text = MESSAGE) { submittedMessage = text; occurrences = 1; },
    setSession(value) { session = value; },
  };
}

function reviewerReply(controlId = CONTROL, taskId = "CONTROL_TRANSPORT_TEST", round = 1): string {
  return [
    "STATE: REVIEW",
    `MISSION_ID: ${taskId}`,
    `ROUND: ${round}`,
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
    noSend.deps.waitTimeoutMs = 0;
    await expect(deliverLocalControl(noSend.input, noSend.deps)).rejects.toThrow("CHAT_SEND_CONTROL_NOT_READY");
    expect(noSend.sent).toHaveLength(0);
    expect(noSend.draft()).toBe("");

    const invalidIdentity = makeFixture();
    invalidIdentity.input.controlId = `C${"x".repeat(160)}`;
    invalidIdentity.input.message = MESSAGE.replace(CONTROL, invalidIdentity.input.controlId);
    await expect(deliverLocalControl(invalidIdentity.input, invalidIdentity.deps)).rejects.toThrow("CONTROL_MESSAGE_IDENTITY_INVALID");
    expect(invalidIdentity.attachCount()).toBe(0);
  });

  it("rejects a stale or mismatched CONTROL_ID response and never creates a receipt", async () => {
    isolate("control-transport-stale-response");
    const fixture = makeFixture();
    fixture.setReplyControlId("CTRL-STALE");
    await expect(deliverLocalControl(fixture.input, fixture.deps)).rejects.toThrow("CONTROL_RESPONSE_TIMEOUT");
    expect(fixture.sent).toHaveLength(1);
    expect(fixture.clickCount()).toBe(1);
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

  it("rejects same identity with a different visible body and leaves EXECUTED_LOCAL", async () => {
    isolate("control-transport-recovery-body-mismatch");
    const fixture = makeFixture();
    fixture.setAutomaticReply(false);
    await expect(deliverLocalControl(fixture.input, fixture.deps)).rejects.toThrow("CONTROL_RESPONSE_TIMEOUT");
    const altered = `${MESSAGE}\nAltered payload with the same identity.`;
    fixture.setVisibleRequest(altered);
    fixture.setAssistant(reviewerReply());
    await expect(resumeLocalControl(fixture.input.workspaceId, MESSAGE, fixture.deps)).rejects.toThrow(
      "CONTROL_REQUEST_PAYLOAD_MISMATCH"
    );
    expect(fixture.clickCount()).toBe(1);
    expect(fixture.deps.getReceipt(fixture.input, Date.now())).toBeNull();
    expect(fixture.session().checkpoint?.protocolState).toBe("EXECUTED_LOCAL");
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

  it("writes and rereads the largest bounded delivery journal without exceeding its byte cap", async () => {
    isolate("control-transport-journal-roundtrip");
    const fixture = makeFixture();
    const deliveriesDir = path.join(getStateDir(), "deliveries");
    fs.mkdirSync(deliveriesDir, { recursive: true });
    const operations = Array.from({ length: 100 }, (_, index) => ({
      workspaceId: fixture.input.workspaceId,
      taskId: `T${String(index).padStart(2, "0")}${"x".repeat(157)}`,
      round: index,
      controlId: `C${String(index).padStart(2, "0")}${"x".repeat(157)}`,
      chatUrl: CHAT,
      requestTimestamp: "2026-09-30T07:00:00.000Z",
      requestPayloadHash: "a".repeat(64),
      status: "completed" as const,
      sendAttemptedAt: "2026-09-30T07:00:01.000Z",
      completedAt: "2026-09-30T07:00:02.000Z",
    }));
    fs.writeFileSync(path.join(deliveriesDir, `${fixture.input.workspaceId}.json`), JSON.stringify({ schemaVersion: 1, workspaceId: fixture.input.workspaceId, operations }, null, 2));

    await deliverLocalControl(fixture.input, fixture.deps);
    const file = path.join(deliveriesDir, `${fixture.input.workspaceId}.json`);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(512 * 1024);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).operations).toHaveLength(100);

    const secondControl = "CTRL-ROUNDTRIP-2";
    const secondTask = "CONTROL_TRANSPORT_ROUNDTRIP_2";
    const secondMessage = ["STATE: REVIEW_REQUEST", `MISSION_ID: ${secondTask}`, "ROUND: 2", `CONTROL_ID: ${secondControl}`].join("\n");
    fixture.setSession(markExecutedLocal(
      { conversationMode: "long-chat", url: CHAT, savedAt: "2026-09-30T07:00:00.000Z" },
      { taskId: secondTask, iteration: 2, controlId: secondControl, chatUrl: CHAT, waitingFor: "none" }
    ));
    fixture.input.taskId = secondTask;
    fixture.input.round = 2;
    fixture.input.controlId = secondControl;
    fixture.input.message = secondMessage;
    fixture.setReplyControlId(secondControl);
    await deliverLocalControl(fixture.input, fixture.deps);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).operations).toHaveLength(100);
    expect(fixture.session().checkpoint?.protocolState).toBe("EXECUTED_SENT");
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
