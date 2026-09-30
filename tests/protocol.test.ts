import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStateDir } from "../src/config/paths.js";
import { setWorkspaceTransport } from "../src/session/transport.js";
import { readSession, writeSession, type SavedSession } from "../src/session/state.js";
import { storeBrowserReceipt, type BrowserReceipt, type BrowserReceiptExpected } from "../src/session/browser-receipt.js";
import {
  advanceExecutedSent,
  markExecutedLocal,
  type ProtocolDependencies,
} from "../src/session/protocol.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const NOW = Date.parse("2026-09-30T08:00:00.000Z");
const PROJECT = "https://chatgpt.com/g/g-p-abc123/project";
const CHAT = "https://chatgpt.com/c/123e4567-e89b-12d3-a456-426614174000";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function localSession(workspaceId: string, conversationMode: "project" | "long-chat" = "long-chat"): SavedSession {
  setWorkspaceTransport(workspaceId, "local-cdp");
  return markExecutedLocal(
    conversationMode === "project"
      ? { conversationMode, projectUrl: PROJECT, url: CHAT, savedAt: "2026-09-30T07:00:00.000Z" }
      : { conversationMode, url: CHAT, savedAt: "2026-09-30T07:00:00.000Z" },
    {
      taskId: "C2C_PROTOCOL_TEST",
      iteration: 2,
      controlId: "CTRL-R2-ABC",
      chatUrl: CHAT,
      waitingFor: "none",
      originalGoal: "exercise receipt gate",
    }
  );
}

function expected(workspaceId: string): BrowserReceiptExpected {
  return {
    workspaceId,
    taskId: "C2C_PROTOCOL_TEST",
    round: 2,
    controlId: "CTRL-R2-ABC",
    chatUrl: CHAT,
  };
}

function receipt(overrides: Partial<BrowserReceipt> = {}): BrowserReceipt {
  const responseText = "STATE: REVIEW\nCONTROL_ID: CTRL-R2-ABC";
  return {
    schemaVersion: 1,
    workspaceId: "workspace-a",
    taskId: "C2C_PROTOCOL_TEST",
    round: 2,
    controlId: "CTRL-R2-ABC",
    chatUrl: CHAT,
    requestState: "sent",
    requestTimestamp: "2026-09-30T07:59:00.000Z",
    requestPayloadHash: hash("control message"),
    responseState: "received",
    responseTimestamp: "2026-09-30T07:59:10.000Z",
    responseControlId: "CTRL-R2-ABC",
    responsePayloadHash: hash(responseText),
    validationStatus: "matched",
    responseText,
    ...overrides,
  };
}

describe("receipt-aware protocol gate", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  function isolate(name: string): string {
    const dir = makeTmpDir(name);
    dirs.push(dir);
    process.env.C2C_STATE_DIR = dir;
    return dir;
  }

  it("persists local completion as EXECUTED_LOCAL before any delivery evidence", () => {
    isolate("protocol-local-state");
    const local = markExecutedLocal(
      { conversationMode: "long-chat", url: CHAT, savedAt: "2026-09-30T07:00:00.000Z" },
      { taskId: "MISSION", iteration: 1, controlId: "CTRL-1", chatUrl: CHAT, waitingFor: "none" }
    );
    writeSession("workspace-a", local);
    expect(readSession("workspace-a")?.checkpoint).toEqual(
      expect.objectContaining({ protocolState: "EXECUTED_LOCAL", waitingFor: "none", controlId: "CTRL-1" })
    );
  });

  it("keeps local-CDP checkpoint at EXECUTED_LOCAL without a receipt", () => {
    isolate("protocol-no-receipt");
    const session = localSession("workspace-a");
    expect(() => advanceExecutedSent(session, "workspace-a", { kind: "browser-receipt" }, undefined, NOW)).toThrow(
      "BROWSER_RECEIPT_REQUIRED"
    );
    expect(session.checkpoint?.protocolState).toBe("EXECUTED_LOCAL");
  });

  it("advances with an exact stored BrowserReceipt and preserves Project / long-chat fields", () => {
    isolate("protocol-valid-receipt");
    const a = localSession("workspace-a", "project");
    storeBrowserReceipt(receipt(), NOW);
    const next = advanceExecutedSent(a, "workspace-a", { kind: "browser-receipt" }, undefined, NOW);
    expect(next.checkpoint?.protocolState).toBe("EXECUTED_SENT");
    expect(next.checkpoint?.waitingFor).toBe("GPT_REVIEW");
    expect(next.projectUrl).toBe(PROJECT);
    expect(next.conversationMode).toBe("project");

    const b = localSession("workspace-b", "long-chat");
    setWorkspaceTransport("workspace-b", "local-cdp");
    storeBrowserReceipt(receipt({ workspaceId: "workspace-b" }), NOW);
    const long = advanceExecutedSent(b, "workspace-b", { kind: "browser-receipt" }, undefined, NOW);
    expect(long.conversationMode).toBe("long-chat");
    expect(long.url).toBe(CHAT);
    expect(long.checkpoint?.protocolState).toBe("EXECUTED_SENT");
  });

  it.each([
    [{ workspaceId: "workspace-b" }, "RECEIPT_WORKSPACE_MISMATCH"],
    [{ taskId: "OTHER_TASK" }, "RECEIPT_TASK_MISMATCH"],
    [{ round: 1 }, "RECEIPT_ROUND_MISMATCH"],
    [{ controlId: "OTHER_CONTROL", responseControlId: "OTHER_CONTROL" }, "RECEIPT_CONTROL_ID_MISMATCH"],
    [{ chatUrl: "https://chatgpt.com/c/other" }, "RECEIPT_CHAT_MISMATCH"],
    [{ requestTimestamp: "2026-08-01T00:00:00.000Z" }, "RECEIPT_EXPIRED"],
  ] as Array<[Partial<BrowserReceipt>, string]>)("rejects bad receipt and does not mutate session (%s)", (changes, code) => {
    isolate("protocol-invalid-receipt");
    const session = localSession("workspace-a");
    writeSession("workspace-a", session);
    const deps: ProtocolDependencies = {
      getTransport: () => "local-cdp",
      getReceipt: () => receipt(changes),
    };
    expect(() => advanceExecutedSent(session, "workspace-a", { kind: "browser-receipt" }, deps, NOW)).toThrow(code);
    expect(session.checkpoint?.protocolState).toBe("EXECUTED_LOCAL");
    expect(session.checkpoint?.waitingFor).toBe("none");
    expect(readSession("workspace-a")?.checkpoint?.protocolState).toBe("EXECUTED_LOCAL");
  });

  it("fails closed on malformed receipt persistence without changing session", () => {
    const dir = isolate("protocol-malformed-store");
    const session = localSession("workspace-a");
    writeSession("workspace-a", session);
    const folder = path.join(getStateDir(), "receipts");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "workspace-a.json"), "{not-json");
    expect(() => advanceExecutedSent(session, "workspace-a", { kind: "browser-receipt" }, undefined, NOW)).toThrow(
      "RECEIPT_STORE_INVALID"
    );
    expect(readSession("workspace-a")?.checkpoint?.protocolState).toBe("EXECUTED_LOCAL");
    expect(dir).toBeTruthy();
  });

  it("makes exact receipt replay idempotent and rejects conflicting replay without state mutation", () => {
    isolate("protocol-replay");
    const session = localSession("workspace-a");
    const stored = receipt();
    storeBrowserReceipt(stored, NOW);
    const sent = advanceExecutedSent(session, "workspace-a", { kind: "browser-receipt" }, undefined, NOW);
    expect(advanceExecutedSent(sent, "workspace-a", { kind: "browser-receipt" }, undefined, NOW)).toBe(sent);
    expect(() =>
      storeBrowserReceipt(
        receipt({ responseText: "different", responsePayloadHash: hash("different") }),
        NOW
      )
    ).toThrow("RECEIPT_REPLAY_CONFLICT");
    expect(sent.checkpoint?.protocolState).toBe("EXECUTED_SENT");
    expect(sent.checkpoint?.iteration).toBe(2);
  });

  it("does not use a prior-round or another-workspace receipt for the current checkpoint", () => {
    isolate("protocol-cross-workspace");
    const session = localSession("workspace-a");
    const wrongRound = receipt({ round: 1 });
    const deps: ProtocolDependencies = { getTransport: () => "local-cdp", getReceipt: () => wrongRound };
    expect(() => advanceExecutedSent(session, "workspace-a", { kind: "browser-receipt" }, deps, NOW)).toThrow(
      "RECEIPT_ROUND_MISMATCH"
    );
    expect(() => advanceExecutedSent(session, "workspace-b", { kind: "browser-receipt" }, {
      getTransport: () => "local-cdp",
      getReceipt: (identity) => identity.workspaceId === "workspace-a" ? receipt() : null,
    }, NOW)).toThrow("BROWSER_RECEIPT_REQUIRED");
    expect(session.checkpoint?.protocolState).toBe("EXECUTED_LOCAL");
  });

  it("keeps legacy v1 independent of BrowserReceipt and requires its explicit legacy acknowledgement", () => {
    isolate("protocol-legacy");
    const legacy = { url: CHAT, taskId: "LEGACY_TASK", iteration: 1, savedAt: "2026-09-30T07:00:00.000Z" };
    const ack: ProtocolDependencies = { getTransport: () => "legacy", getReceipt: vi.fn(() => null) };
    expect(() => advanceExecutedSent(legacy, "legacy-workspace", { kind: "legacy-ack", acknowledged: false }, ack, NOW)).toThrow(
      "LEGACY_ACK_REQUIRED"
    );
    const sent = advanceExecutedSent(legacy, "legacy-workspace", { kind: "legacy-ack", acknowledged: true }, ack, NOW);
    expect(sent.checkpoint?.protocolState).toBe("EXECUTED_SENT");
    expect(sent.checkpoint?.waitingFor).toBe("GPT_REVIEW");
    expect(ack.getReceipt).not.toHaveBeenCalled();
  });

  it("has no CDP sender dependency", () => {
    isolate("protocol-no-cdp");
    const sent = vi.fn();
    const deps = { getTransport: () => "legacy" as const, getReceipt: vi.fn(() => null), send: sent };
    advanceExecutedSent(
      { url: CHAT, taskId: "LEGACY_TASK", iteration: 1, savedAt: "2026-09-30T07:00:00.000Z" },
      "legacy-workspace",
      { kind: "legacy-ack", acknowledged: true },
      deps,
      NOW
    );
    expect(sent).not.toHaveBeenCalled();
  });
});
