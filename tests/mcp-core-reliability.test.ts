import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { appendExecutionRecord } from "../src/execution/records.js";
import { saveExecutionOutput } from "../src/execution/output.js";
import { cleanup, git, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const readScopes = ["workspace.read", "workspace.search", "git.read", "execution.read"];
function connect(bridge: Bridge, token: string, name: string) {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  return { client, connected: client.connect(transport) };
}

describe("fresh stateless MCP core reliability", () => {
  it("serves 100 sequential alternating core requests across 10 fresh clients with identical complete schemas", async () => {
    const prior = process.env.C2C_STATE_DIR;
    const state = isolateStateDir();
    const root = makeTmpDir("mcp-core-repeat");
    makeGitRepo(root);
    const expectedHead = git(root, "rev-parse", "HEAD").trim();
    let bridge: Bridge | undefined;
    let count = 0;
    try {
      bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false, authStoreFile: path.join(state, "test-auth.json") });
      const token = bridge.authStore.issueTokens({ clientId: "core-reliability", scopes: readScopes });
      const output = saveExecutionOutput(bridge.workspace.id, { command: "synthetic-core", raw: "synthetic-core", exitCode: 0 });
      appendExecutionRecord(bridge.workspace.id, { taskId: "synthetic-core", iteration: 0, changedFiles: 0, tests: "fixture", exitStatus: "ok", timestamp: new Date().toISOString(), outputId: output.id, outputAvailable: true });
      let schemaHash: string | undefined;
      for (let session = 0; session < 10; session++) {
        const { client, connected } = connect(bridge, token.accessToken, `fresh-core-${session}`);
        await connected;
        try {
          const { tools } = await client.listTools();
          tools.sort((a, b) => a.name.localeCompare(b.name));
          const current = createHash("sha256").update(JSON.stringify(tools)).digest("hex");
          if (schemaHash === undefined) schemaHash = current;
          expect(current).toBe(schemaHash);
          const names = tools.map((tool) => tool.name);
          expect(names).toEqual(expect.arrayContaining(["workspace_info", "execution_output", "write_file", "apply_patch", "git_show", "git_log", "git_merge_base", "git_ancestry", "git_remote_refs", "create_branch", "create_worktree", "git_commit", "git_push", "git_merge_ff_only"]));
          for (const forbidden of ["execute_shell", "delete_file", "git_reset", "git_rebase", "delete_branch", "delete_worktree"]) expect(names).not.toContain(forbidden);
          const sequence = [
            ["workspace_info", {}], ["list_directory", { path: "." }], ["read_file", { path: "hello.txt" }], ["search_workspace", { query: "answer" }],
            ["git_status", {}], ["git_diff", { mode: "unstaged" }], ["execution_summary", { limit: 1 }], ["execution_output", { action: "list", limit: 1 }],
            ["execution_output", { action: "read", id: output.id }], ["workspace_info", {}],
          ] as const;
          for (const [name, args] of sequence) {
            const result = await client.callTool({ name, arguments: args });
            expect(result.isError ?? false).toBe(false);
            const data = result.structuredContent as Record<string, any>;
            expect(data).toBeDefined();
            if (name === "workspace_info") {
              expect(data.workspaceId).toBe(bridge.workspace.id);
              expect(data.git.branch).toBe("main");
              expect(data.git.dirty).toBe(false);
              expect(data.git.commit.length).toBeGreaterThanOrEqual(7);
              expect(expectedHead.startsWith(data.git.commit)).toBe(true);
            }
            if (name === "read_file") expect(data.content).toContain("Hello from Codex with ChatGPT!");
            if (name === "execution_output" && "id" in args) expect(data.text).toBe("synthetic-core");
            if (name === "git_diff") expect(data.diff).toBe("");
            count++;
          }
        } finally { await client.close(); }
      }
      expect(count).toBe(100);
    } finally {
      await bridge?.close();
      cleanup(root); cleanup(state);
      if (prior === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = prior;
    }
  }, 30_000);

  it("keeps identities, output records and token authorization bound to their workspace", async () => {
    const prior = process.env.C2C_STATE_DIR;
    const state = isolateStateDir();
    const roots = [makeTmpDir("mcp-a"), makeTmpDir("mcp-b")];
    const bridges: Bridge[] = [];
    try {
      for (let i = 0; i < roots.length; i++) {
        write(roots[i], "marker.txt", `workspace-${i}`);
        const bridge = await startBridge({ workspaceRoot: roots[i], port: 0, persistRuntime: false, authStoreFile: path.join(state, `auth-${i}.json`) });
        bridges.push(bridge);
        saveExecutionOutput(bridge.workspace.id, { command: `workspace-${i}`, raw: `workspace-${i}` });
      }
      expect(bridges[0].workspace.id).not.toBe(bridges[1].workspace.id);
      const tokens = bridges.map((b, i) => b.authStore.issueTokens({ clientId: `test-${i}`, scopes: readScopes }).accessToken);
      for (let i = 0; i < 2; i++) {
        const { client, connected } = connect(bridges[i], tokens[i], `isolated-${i}`);
        await connected;
        try {
          const identity = await client.callTool({ name: "workspace_info", arguments: {} });
          expect(identity.structuredContent?.workspaceId).toBe(bridges[i].workspace.id);
          const output = await client.callTool({ name: "execution_output", arguments: { action: "read", id: 1 } });
          expect(output.structuredContent?.text).toBe(`workspace-${i}`);
          const denied = await client.callTool({ name: "write_file", arguments: { path: "forbidden.txt", content: "bad" } });
          expect(denied.isError).toBe(true);
          expect(fs.existsSync(path.join(roots[i], "forbidden.txt"))).toBe(false);
        } finally { await client.close(); }
      }
      const denied = await fetch(`${bridges[1].localBaseUrl()}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tokens[0]}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
      expect(denied.status).toBe(401);
      await denied.body?.cancel();
    } finally {
      for (const b of bridges) await b.close();
      for (const root of roots) cleanup(root);
      cleanup(state);
      if (prior === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = prior;
    }
  });
});
