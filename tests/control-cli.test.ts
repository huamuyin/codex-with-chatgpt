import { createHash } from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { getStateDir } from "../src/config/paths.js";
import { writeSession } from "../src/session/state.js";
import { storeBrowserReceipt } from "../src/session/browser-receipt.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(root, "src/cli/index.ts");
const CHAT = "https://chatgpt.com/c/123e4567-e89b-12d3-a456-426614174000";
const RESPONSE = "STATE: REVIEW\nMISSION_ID: CLI_RECEIPT_TEST\nROUND: 2\nCONTROL_ID: CLI-CONTROL-2\nprivate review body";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function runCli(stateDir: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cliEntry, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, C2C_STATE_DIR: stateDir },
  });
}

describe("local CDP receipt and resume CLI", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("lists and validates receipt metadata without printing response text", () => {
    const stateDir = makeTmpDir("control-receipt-cli");
    dirs.push(stateDir);
    process.env.C2C_STATE_DIR = stateDir;
    const workspace = new Workspace(root);
    const now = Date.now();
    storeBrowserReceipt({
      schemaVersion: 1,
      workspaceId: workspace.id,
      taskId: "CLI_RECEIPT_TEST",
      round: 2,
      controlId: "CLI-CONTROL-2",
      chatUrl: CHAT,
      requestState: "sent",
      requestTimestamp: new Date(now - 1000).toISOString(),
      requestPayloadHash: hash("request"),
      responseState: "received",
      responseTimestamp: new Date(now).toISOString(),
      responseControlId: "CLI-CONTROL-2",
      responsePayloadHash: hash(RESPONSE),
      validationStatus: "matched",
      responseText: RESPONSE,
    }, now);

    const listed = runCli(stateDir, ["receipt", "list", "--workspace", root, "--json"]);
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain("CLI-CONTROL-2");
    expect(listed.stdout).not.toContain("private review body");
    expect(JSON.parse(listed.stdout).receipts[0]).toMatchObject({ responseTextPresent: true });

    const validated = runCli(stateDir, [
      "receipt", "validate", "--workspace", root, "--task", "CLI_RECEIPT_TEST", "--round", "2",
      "--control-id", "CLI-CONTROL-2", "--chat-url", CHAT, "--json",
    ]);
    expect(validated.status).toBe(0);
    expect(validated.stdout).toContain('"ok":true');
    expect(validated.stdout).not.toContain("private review body");
  });

  it("returns legacy without requiring a message file or attempting local browser work", () => {
    const stateDir = makeTmpDir("control-resume-legacy-cli");
    dirs.push(stateDir);
    process.env.C2C_STATE_DIR = stateDir;
    const workspace = new Workspace(root);
    writeSession(workspace.id, { url: CHAT, conversationMode: "long-chat", savedAt: new Date().toISOString() });
    const result = runCli(stateDir, ["control-resume", "--workspace", root, "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, result: { status: "LEGACY" } });
    expect(fs.existsSync(path.join(getStateDir(), "deliveries"))).toBe(false);
  });

  it("requires an absolute message path before local control delivery", () => {
    const stateDir = makeTmpDir("control-resume-path-cli");
    dirs.push(stateDir);
    const result = runCli(stateDir, ["control-resume", "--workspace", root, "--message-file", "control.txt", "--json"]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("MESSAGE_FILE_PATH_MUST_BE_ABSOLUTE");
  });
});
