import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { setWorkspaceTransport } from "../src/session/transport.js";
import { markExecutedLocal } from "../src/session/protocol.js";
import { readSession, writeSession } from "../src/session/state.js";
import { storeBrowserReceipt } from "../src/session/browser-receipt.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(root, "src/cli/index.ts");
const CHAT = "https://chatgpt.com/c/123e4567-e89b-12d3-a456-426614174000";
const TASK = "CLI_PROTOCOL_R1";
const CONTROL = "CLI-CTRL-1";
const NOW = Date.now();

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

describe("session CLI receipt gate", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("refuses local-CDP EXECUTED_SENT without a receipt and advances with a stored match", () => {
    const stateDir = makeTmpDir("protocol-cli");
    dirs.push(stateDir);
    process.env.C2C_STATE_DIR = stateDir;
    const workspace = new Workspace(root);
    setWorkspaceTransport(workspace.id, "local-cdp");
    const local = markExecutedLocal(
      { url: CHAT, savedAt: new Date(NOW).toISOString() },
      { taskId: TASK, iteration: 1, controlId: CONTROL, chatUrl: CHAT, waitingFor: "none" }
    );
    writeSession(workspace.id, local);

    const blocked = runCli(stateDir, [
      "session", "set", "--workspace", root, "--task", TASK, "--iteration", "1", "--protocol-state", "EXECUTED_SENT",
    ]);
    expect(blocked.status).not.toBe(0);
    expect(`${blocked.stdout}\n${blocked.stderr}`).toContain("BROWSER_RECEIPT_REQUIRED");
    expect(readSession(workspace.id)?.checkpoint?.protocolState).toBe("EXECUTED_LOCAL");

    const responseText = `STATE: REVIEW\nCONTROL_ID: ${CONTROL}`;
    storeBrowserReceipt({
      schemaVersion: 1,
      workspaceId: workspace.id,
      taskId: TASK,
      round: 1,
      controlId: CONTROL,
      chatUrl: CHAT,
      requestState: "sent",
      requestTimestamp: new Date(NOW - 1000).toISOString(),
      requestPayloadHash: hash("request"),
      responseState: "received",
      responseTimestamp: new Date(NOW).toISOString(),
      responseControlId: CONTROL,
      responsePayloadHash: hash(responseText),
      validationStatus: "matched",
      responseText,
    }, NOW);

    const advanced = runCli(stateDir, [
      "session", "set", "--workspace", root, "--task", TASK, "--iteration", "1", "--protocol-state", "EXECUTED_SENT",
    ]);
    expect(advanced.status).toBe(0);
    expect(readSession(workspace.id)?.checkpoint).toEqual(
      expect.objectContaining({ protocolState: "EXECUTED_SENT", waitingFor: "GPT_REVIEW", controlId: CONTROL })
    );
  });
});
