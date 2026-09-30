import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { configureSharedRuntime } from "../src/config/shared-runtime.js";
import { getWorkspaceTransport, setWorkspaceTransport } from "../src/session/transport.js";
import { markExecutedLocal } from "../src/session/protocol.js";
import { readSession, writeSession, resolveConversation } from "../src/session/state.js";
import { getBrowserReceipt, storeBrowserReceipt } from "../src/session/browser-receipt.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const CHAT_A = "https://chatgpt.com/c/123e4567-e89b-12d3-a456-426614174000";
const CHAT_B = "https://chatgpt.com/c/223e4567-e89b-12d3-a456-426614174000";
const PROJECT_A = "https://chatgpt.com/g/g-p-abc123/project";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("multi-workspace runtime and receipt isolation", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("isolates project, long-chat and legacy workspace bindings under one machine runtime", () => {
    const dir = makeTmpDir("multi-workspace-isolation");
    dirs.push(dir);
    process.env.C2C_STATE_DIR = dir;
    configureSharedRuntime({
      transportMode: "local-cdp",
      cdpEndpoint: "http://127.0.0.1:9222",
      browser: "edge",
      profileIdentity: "dedicated-reviewer",
      lifecycleMode: "external",
    });

    setWorkspaceTransport("project-a", "local-cdp");
    setWorkspaceTransport("long-chat-b", "local-cdp");
    setWorkspaceTransport("legacy-c", "legacy");

    const project = markExecutedLocal(
      { conversationMode: "project", projectUrl: PROJECT_A, url: CHAT_A, savedAt: "2026-09-30T07:00:00.000Z" },
      { taskId: "PROJECT_TASK", iteration: 1, controlId: "PROJECT-CTRL", chatUrl: CHAT_A, waitingFor: "none" }
    );
    const longChat = markExecutedLocal(
      { conversationMode: "long-chat", url: CHAT_B, savedAt: "2026-09-30T07:00:00.000Z" },
      { taskId: "LONG_TASK", iteration: 4, controlId: "LONG-CTRL", chatUrl: CHAT_B, waitingFor: "none" }
    );
    const legacy = {
      conversationMode: "long-chat" as const,
      url: "https://chatgpt.com/c/323e4567-e89b-12d3-a456-426614174000",
      taskId: "LEGACY_TASK",
      iteration: 2,
      savedAt: "2026-09-30T07:00:00.000Z",
    };
    writeSession("project-a", project);
    writeSession("long-chat-b", longChat);
    writeSession("legacy-c", legacy);

    const responseText = "STATE: REVIEW\nMISSION_ID: PROJECT_TASK\nROUND: 1\nCONTROL_ID: PROJECT-CTRL";
    storeBrowserReceipt({
      schemaVersion: 1,
      workspaceId: "project-a",
      taskId: "PROJECT_TASK",
      round: 1,
      controlId: "PROJECT-CTRL",
      chatUrl: CHAT_A,
      requestState: "sent",
      requestTimestamp: "2026-09-30T07:59:00.000Z",
      requestPayloadHash: hash("request"),
      responseState: "received",
      responseTimestamp: "2026-09-30T07:59:10.000Z",
      responseControlId: "PROJECT-CTRL",
      responsePayloadHash: hash(responseText),
      validationStatus: "matched",
      responseText,
    }, Date.parse("2026-09-30T08:00:00.000Z"));

    expect(getWorkspaceTransport("project-a").mode).toBe("local-cdp");
    expect(getWorkspaceTransport("long-chat-b").mode).toBe("local-cdp");
    expect(getWorkspaceTransport("legacy-c").mode).toBe("legacy");
    expect(resolveConversation(readSession("project-a")).mode).toBe("project");
    expect(resolveConversation(readSession("project-a")).projectUrl).toBe(PROJECT_A);
    expect(resolveConversation(readSession("long-chat-b")).mode).toBe("long-chat");
    expect(resolveConversation(readSession("legacy-c")).mode).toBe("long-chat");
    expect(readSession("long-chat-b")?.checkpoint?.taskId).toBe("LONG_TASK");
    expect(readSession("legacy-c")?.checkpoint).toBeUndefined();
    expect(getBrowserReceipt({
      workspaceId: "project-a", taskId: "PROJECT_TASK", round: 1, controlId: "PROJECT-CTRL", chatUrl: CHAT_A,
    }, Date.parse("2026-09-30T08:00:00.000Z"))).toMatchObject({ workspaceId: "project-a" });
    expect(getBrowserReceipt({
      workspaceId: "long-chat-b", taskId: "PROJECT_TASK", round: 1, controlId: "PROJECT-CTRL", chatUrl: CHAT_A,
    }, Date.parse("2026-09-30T08:00:00.000Z"))).toBeNull();
    expect(getBrowserReceipt({
      workspaceId: "legacy-c", taskId: "PROJECT_TASK", round: 1, controlId: "PROJECT-CTRL", chatUrl: CHAT_A,
    }, Date.parse("2026-09-30T08:00:00.000Z"))).toBeNull();
  });
});
