import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { appendExecutionRecord } from "../src/execution/records.js";
import { saveExecutionOutput } from "../src/execution/output.js";
import { makeTmpDir, cleanup, write, makeGitRepo, git, isolateStateDir } from "./helpers.js";

let root: string;
let bridge: Bridge;
let client: Client;
let accessToken: string;
let stateDir: string;

function textOf(result: { content?: unknown }): string {
  const content = result.content as { type: string; text: string }[];
  return content?.[0]?.text ?? "";
}

function jsonOf<T = Record<string, unknown>>(result: { content?: unknown }): T {
  return JSON.parse(textOf(result)) as T;
}

function structuredJsonOf<T = Record<string, unknown>>(result: { content?: unknown; structuredContent?: unknown }): T {
  const parsed = jsonOf<T>(result);
  expect(result.structuredContent).toEqual(parsed);
  return parsed;
}

function expectToolOutputSchema(
  tools: Awaited<ReturnType<Client["listTools"]>>["tools"],
  name: string,
  properties: string[]
): void {
  const schema = tools.find((tool) => tool.name === name)?.outputSchema as
    | { type?: string; properties?: Record<string, unknown> }
    | undefined;
  expect(schema?.type).toBe("object");
  expect(Object.keys(schema?.properties ?? {})).toEqual(expect.arrayContaining(properties));
}

beforeAll(async () => {
  stateDir = isolateStateDir();
  root = makeTmpDir("mcp-ws");
  makeGitRepo(root);
  write(root, "package.json", JSON.stringify({ name: "demo", scripts: { test: "vitest run" }, dependencies: { react: "^19.0.0" } }));
  write(root, ".env", "API_KEY=supersecret\n");
  // an uncommitted change so git_diff has content
  write(root, "src/index.ts", "export const answer = 43; // changed\n");

  bridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(makeTmpDir("auth"), "store.json"),
  });
  const tokens = bridge.authStore.issueTokens({
    clientId: "it-client",
    scopes: ["workspace.read", "workspace.search", "git.read", "execution.read"],
  });
  accessToken = tokens.accessToken;

  client = new Client({ name: "c2c-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  await bridge.close();
  cleanup(root);
});

describe("MCP tools over Streamable HTTP", () => {
  it("advertises the read and governed mutation tool surface", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "apply_patch",
      "create_branch",
      "create_worktree",
      "execution_output",
      "execution_summary",
      "git_ancestry",
      "git_commit",
      "git_diff",
      "git_log",
      "git_merge_base",
      "git_merge_ff_only",
      "git_push",
      "git_remote_refs",
      "git_show",
      "git_status",
      "list_directory",
      "read_file",
      "search_workspace",
      "test_status",
      "workspace_info",
      "write_file",
    ]);
    for (const forbidden of ["delete_file", "execute_shell", "install_package", "git_reset", "git_rebase"]) expect(names).not.toContain(forbidden);

    expectToolOutputSchema(tools, "workspace_info", ["workspaceId", "workspaceName", "projectType", "git"]);
    expectToolOutputSchema(tools, "list_directory", ["path", "entries", "total", "hasMore"]);
    expectToolOutputSchema(tools, "read_file", ["path", "content", "startLine", "endLine", "nextStartLine"]);
    expectToolOutputSchema(tools, "search_workspace", ["matches", "matchCount", "truncated", "engine"]);
    expectToolOutputSchema(tools, "git_status", ["isRepo", "branch", "staged", "unstaged", "untracked", "hidden"]);
    expectToolOutputSchema(tools, "git_diff", ["isRepo", "mode", "diff", "hasMore", "nextOffset"]);
    expectToolOutputSchema(tools, "test_status", ["available", "tests", "outputAvailable", "outputId"]);
    expectToolOutputSchema(tools, "execution_summary", ["records"]);
    expectToolOutputSchema(tools, "execution_output", ["action", "items", "text"]);
    expectToolOutputSchema(tools, "write_file", ["path", "root", "action", "byteCount", "previous_sha256", "sha256", "diff"]);
    expectToolOutputSchema(tools, "apply_patch", ["root", "changedFiles", "diff"]);
    expectToolOutputSchema(tools, "git_show", ["commit", "parents", "changedPaths"]);
    expectToolOutputSchema(tools, "git_log", ["entries"]);
    expectToolOutputSchema(tools, "git_merge_base", ["left", "right", "mergeBase"]);
    expectToolOutputSchema(tools, "git_ancestry", ["ancestor", "descendant", "isAncestor"]);
    expectToolOutputSchema(tools, "create_branch", ["branch", "base", "commit"]);
    expectToolOutputSchema(tools, "create_worktree", ["name", "rootAlias", "path", "branch", "head", "clean", "expectedSourceSha"]);
    expectToolOutputSchema(tools, "git_commit", ["parent", "commit", "committedPaths", "expectedFiles", "expectedBranch", "expectedHead", "observedHead"]);
    expectToolOutputSchema(tools, "git_push", ["remote", "remoteBranch", "expectedLocalSha", "expectedRemoteSha", "pushedSha", "remoteReadbackSha"]);
    expectToolOutputSchema(tools, "git_merge_ff_only", ["before", "after", "changedPaths", "expectedBranch", "expectedHead", "status"]);
    expectToolOutputSchema(tools, "git_remote_refs", ["remote", "refs"]);
    const input = (name: string) => tools.find((tool) => tool.name === name)?.inputSchema as { required?: string[]; properties?: Record<string, unknown>; additionalProperties?: boolean };
    expect(input("git_commit").required).toEqual(expect.arrayContaining(["expected_branch", "expected_head", "expected_files"]));
    expect(input("apply_patch").required).toContain("expected_files");
    expect(input("create_worktree").required).toEqual(expect.arrayContaining(["branch", "expected_source_sha"]));
    expect(input("create_worktree").properties).not.toHaveProperty("branch_or_ref");
    expect(input("git_merge_ff_only").required).toEqual(expect.arrayContaining(["expected_branch", "expected_head"]));
    expect(input("git_push").required).toEqual(expect.arrayContaining(["expected_local_sha", "expected_remote_sha"]));
    expect(input("git_push")).toHaveProperty("additionalProperties", false);
    expect(Object.keys(input("git_push").properties ?? {})).not.toEqual(expect.arrayContaining(["force", "lease", "refspec"]));
    const commitDescription = tools.find((tool) => tool.name === "git_commit")?.description ?? "";
    expect(commitDescription).toContain("staged index blob");
    expect(commitDescription).toContain("verified index snapshot");
    expect(input("write_file").required).not.toContain("expected_sha256");
    expect(tools.find((tool) => tool.name === "read_file")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === "git_remote_refs")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === "write_file")?.annotations?.readOnlyHint).toBe(false);
  });

  it("documents git_diff pagination with its output field names", async () => {
    const { tools } = await client.listTools();
    const description = tools.find((tool) => tool.name === "git_diff")?.description;
    expect(description).toContain("hasMore");
    expect(description).toContain("nextOffset");
    expect(description).not.toContain("has_more");
    expect(description).not.toContain("next_offset");
  });

  it("workspace_info returns identity and project detection", async () => {
    const result = await client.callTool({ name: "workspace_info", arguments: {} });
    const info = structuredJsonOf<{ workspaceId: string; projectType: string; frameworks: string[]; git: { isRepo: boolean; branch: string } }>(result);
    expect(info.workspaceId).toBe(bridge.workspace.id);
    expect(info.projectType).toBe("node");
    expect(info.frameworks).toContain("React");
    expect(info.git.isRepo).toBe(true);
    expect(info.git.branch).toBe("main");
  });

  it("read_file returns hello.txt", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: "hello.txt" } });
    const file = structuredJsonOf<{ content: string; totalLines: number }>(result);
    expect(file.content).toContain("Hello from Codex with ChatGPT!");
  });

  it("read_file denies .env with ACCESS_DENIED_SENSITIVE_FILE and no content", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: ".env" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("ACCESS_DENIED_SENSITIVE_FILE");
    expect(textOf(result)).not.toContain("supersecret");
  });

  it("read_file denies paths outside the workspace", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: "../../etc/hosts" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("PATH_OUTSIDE_WORKSPACE");
  });

  it("list_directory lists the tree", async () => {
    const result = await client.callTool({ name: "list_directory", arguments: { path: ".", depth: 2 } });
    const listing = structuredJsonOf<{ entries: { path: string }[] }>(result);
    const paths = listing.entries.map((entry) => entry.path);
    expect(paths).toContain("hello.txt");
    expect(paths).toContain("src/index.ts");
    expect(paths).not.toContain(".env");
  });

  it("search_workspace finds matches", async () => {
    const result = await client.callTool({ name: "search_workspace", arguments: { query: "answer" } });
    const search = structuredJsonOf<{ matches: { path: string; line: number }[] }>(result);
    expect(search.matches.some((match) => match.path === "src/index.ts")).toBe(true);
  });

  it("git_status reports the dirty file", async () => {
    const result = await client.callTool({ name: "git_status", arguments: {} });
    const status = structuredJsonOf<{ isRepo: boolean; unstaged: { path: string }[] }>(result);
    expect(status.isRepo).toBe(true);
    expect(status.unstaged.some((entry) => entry.path === "src/index.ts")).toBe(true);
  });

  it("git_diff shows the change", async () => {
    const result = await client.callTool({ name: "git_diff", arguments: { mode: "unstaged" } });
    const diff = structuredJsonOf<{ diff: string; hasMore: boolean }>(result);
    expect(diff.diff).toContain("answer = 43");
    expect(diff.hasMore).toBe(false);
  });

  it("git_diff paginates large diffs", async () => {
    const big = Array.from({ length: 20000 }, (_, i) => `content line ${i}`).join("\n");
    write(root, "big-change.txt", big);
    git(root, "add", "big-change.txt");
    const first = structuredJsonOf<{ hasMore: boolean; nextOffset: number; totalBytes: number; returnedBytes: number }>(
      await client.callTool({ name: "git_diff", arguments: { mode: "staged", max_bytes: 4096 } })
    );
    expect(first.hasMore).toBe(true);
    expect(first.returnedBytes).toBeLessThanOrEqual(4096);
    const second = structuredJsonOf<{ offset: number; diff: string }>(
      await client.callTool({
        name: "git_diff",
        arguments: { mode: "staged", max_bytes: 4096, offset: first.nextOffset },
      })
    );
    expect(second.offset).toBe(first.nextOffset);
    expect(second.diff.length).toBeGreaterThan(0);
    git(root, "reset", "big-change.txt");
  });

  it("execution_summary and test_status read harness records", async () => {
    appendExecutionRecord(bridge.workspace.id, {
      taskId: "c2c_test1",
      iteration: 1,
      changedFiles: ["src/index.ts"],
      tests: "27 passed",
      exitStatus: "ok",
      timestamp: new Date().toISOString(),
    });
    const summary = structuredJsonOf<{ records: { taskId: string }[] }>(
      await client.callTool({ name: "execution_summary", arguments: {} })
    );
    expect(summary.records[0].taskId).toBe("c2c_test1");

    const status = structuredJsonOf<{ available: boolean; tests: string; outputAvailable: boolean; outputId: number | null }>(
      await client.callTool({ name: "test_status", arguments: {} })
    );
    expect(status.available).toBe(true);
    expect(status.tests).toBe("27 passed");
    expect(status.outputAvailable).toBe(false);
    expect(status.outputId).toBeNull();
  });

  it("skips invalid persisted records when reporting execution status", async () => {
    appendExecutionRecord(bridge.workspace.id, {
      taskId: "c2c_valid_before_invalid",
      iteration: 2,
      changedFiles: 0,
      tests: "31 passed",
      exitStatus: "ok",
      timestamp: new Date().toISOString(),
    });
    fs.appendFileSync(
      path.join(stateDir, "executions", `${bridge.workspace.id}.jsonl`),
      JSON.stringify({
        taskId: "c2c_invalid",
        iteration: null,
        changedFiles: 0,
        tests: null,
        exitStatus: "ok",
        timestamp: new Date().toISOString(),
      }) + "\n"
    );

    const statusResult = await client.callTool({ name: "test_status", arguments: {} });
    expect(statusResult.isError ?? false).toBe(false);
    const status = structuredJsonOf<{ taskId: string; iteration: number }>(statusResult);
    expect(status.taskId).toBe("c2c_valid_before_invalid");
    expect(status.iteration).toBe(2);

    const summaryResult = await client.callTool({ name: "execution_summary", arguments: { limit: 1 } });
    expect(summaryResult.isError ?? false).toBe(false);
    const summary = structuredJsonOf<{ records: { taskId: string }[] }>(summaryResult);
    expect(summary.records.map((record) => record.taskId)).toEqual(["c2c_valid_before_invalid"]);
  });

  it("execution_output lists readable items and refuses restricted bodies", async () => {
    const readable = saveExecutionOutput(bridge.workspace.id, {
      command: "pnpm test",
      raw: "FAIL src/a.test.ts\nAssertionError: expected true",
      exitCode: 1,
    });
    const hidden = saveExecutionOutput(bridge.workspace.id, {
      command: "print-key",
      raw: "-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----",
      exitCode: 0,
    });
    const listResult = await client.callTool({
      name: "execution_output",
      arguments: { action: "list" },
    });
    const list = structuredJsonOf<{
      action: "list";
      items: { id: number; status: string; command: string; text?: string }[];
    }>(listResult);
    expect(list.action).toBe("list");
    expect(list.items.some((item) => item.id === readable.id && item.status === "readable")).toBe(true);
    expect(list.items.some((item) => item.id === hidden.id && item.status === "restricted")).toBe(true);
    expect(list.items.every((item) => item.text === undefined)).toBe(true);

    const readResult = await client.callTool({
      name: "execution_output",
      arguments: { action: "read", id: readable.id },
    });
    const body = structuredJsonOf<{ action: "read"; text: string }>(readResult);
    expect(body.action).toBe("read");
    expect(body.text).toContain("AssertionError");

    const denied = await client.callTool({
      name: "execution_output",
      arguments: { action: "read", id: hidden.id },
    });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("OUTPUT_RESTRICTED");
    expect(textOf(denied)).not.toContain("BEGIN RSA");

    const missing = await client.callTool({
      name: "execution_output",
      arguments: { action: "read", id: 999999 },
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("NOT_FOUND");
  });

  it("enforces scopes per tool", async () => {
    const limited = bridge.authStore.issueTokens({ clientId: "limited", scopes: ["workspace.read"] });
    const limitedClient = new Client({ name: "limited", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${limited.accessToken}` } },
    });
    await limitedClient.connect(transport);
    const denied = await limitedClient.callTool({ name: "git_diff", arguments: {} });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("INSUFFICIENT_SCOPE");
    const outputDenied = await limitedClient.callTool({
      name: "execution_output",
      arguments: { action: "list" },
    });
    expect(outputDenied.isError).toBe(true);
    expect(textOf(outputDenied)).toContain("INSUFFICIENT_SCOPE");
    const allowed = await limitedClient.callTool({ name: "read_file", arguments: { path: "hello.txt" } });
    expect(allowed.isError ?? false).toBe(false);
    const writeDenied = await limitedClient.callTool({ name: "write_file", arguments: { path: "no.txt", content: "x" } });
    expect(writeDenied.isError).toBe(true);
    expect(textOf(writeDenied)).toContain("INSUFFICIENT_SCOPE");
    await limitedClient.close();
  });

  it("documents the exact leased fast-forward push and rejects caller-supplied push controls", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((entry) => entry.name === "git_push");
    expect(tool?.description).toContain("EXACT LEASED FAST_FORWARD_PUSH");
    expect(tool?.description).toContain("never authorizes history rewriting");
    expect(tool?.inputSchema?.additionalProperties).toBe(false);
    expect(Object.keys((tool?.inputSchema?.properties ?? {}) as Record<string, unknown>)).not.toEqual(expect.arrayContaining(["force", "lease", "refspec"]));

    // MCP input validation rejects unknown controls before the scope-gated handler runs.
    const result = await client.callTool({ name: "git_push", arguments: {
      branch: "main", remote_branch: "candidate", expected_local_sha: "a".repeat(40), expected_remote_sha: null,
      lease: "--force", refspec: "refs/heads/main:refs/heads/main",
    } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Unrecognized key|unrecognized_keys|lease|refspec/i);
  });

  it("requires the distinct git.push scope in addition to git.write", async () => {
    const token = bridge.authStore.issueTokens({ clientId: "git-writer", scopes: ["workspace.read", "git.read", "git.write"] });
    const scoped = new Client({ name: "git-writer", version: "1.0.0" });
    await scoped.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token.accessToken}` } },
    }));
    const denied = await scoped.callTool({ name: "git_push", arguments: { branch: "main", remote_branch: "main", expected_local_sha: "a".repeat(40), expected_remote_sha: null } });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("git.push");
    await scoped.close();
  });

  it("allows a scoped file write only when the authenticated workspace.write scope is present", async () => {
    const token = bridge.authStore.issueTokens({ clientId: "workspace-writer", scopes: ["workspace.read", "workspace.write"] });
    const scoped = new Client({ name: "workspace-writer", version: "1.0.0" });
    await scoped.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token.accessToken}` } },
    }));
    const result = await scoped.callTool({ name: "write_file", arguments: { path: "mcp-write.txt", content: "authorized\n" } });
    expect(result.isError ?? false).toBe(false);
    expect(fs.readFileSync(path.join(root, "mcp-write.txt"), "utf8")).toBe("authorized\n");
    await scoped.close();
  });

  it("requires the existing-file SHA precondition and leaves stale writes untouched", async () => {
    const token = bridge.authStore.issueTokens({ clientId: "workspace-writer-precondition", scopes: ["workspace.read", "workspace.write"] });
    const scoped = new Client({ name: "workspace-writer-precondition", version: "1.0.0" });
    await scoped.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token.accessToken}` } },
    }));
    const original = fs.readFileSync(path.join(root, "hello.txt"), "utf8");
    const missing = await scoped.callTool({ name: "write_file", arguments: { path: "hello.txt", content: "bad" } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("PRECONDITION_REQUIRED");
    const stale = await scoped.callTool({ name: "write_file", arguments: { path: "hello.txt", content: "bad", expected_sha256: "0".repeat(64) } });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toContain("STATE_MISMATCH");
    expect(fs.readFileSync(path.join(root, "hello.txt"), "utf8")).toBe(original);
    await scoped.close();
  });

  it("exposes live origin refs as read-only and does not fetch tracking refs", async () => {
    const bare = makeTmpDir("mcp-bare-origin");
    git(bare, "init", "--bare");
    git(root, "remote", "add", "origin", bare);
    const head = git(root, "rev-parse", "HEAD").trim();
    git(root, "push", "origin", "HEAD:refs/heads/main");
    const before = git(root, "for-each-ref", "--format=%(refname)", "refs/remotes/origin");
    const result = structuredJsonOf<{ remote: string; refs: { branch: string; ref: string; sha: string | null }[] }>(
      await client.callTool({ name: "git_remote_refs", arguments: { branches: ["main", "missing"] } })
    );
    const after = git(root, "for-each-ref", "--format=%(refname)", "refs/remotes/origin");
    expect(result.remote).toBe("origin");
    expect(result.refs).toEqual([
      { branch: "main", ref: "refs/heads/main", sha: head },
      { branch: "missing", ref: "refs/heads/missing", sha: null },
    ]);
    expect(after).toBe(before);
    git(root, "remote", "remove", "origin");
    cleanup(bare);
  });

  it("git_diff over MCP excludes sensitive files like .npmrc and service-account*.json", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=supersecret-npm-token\n");
    write(root, "service-account-test.json", '{"private_key": "supersecret-sa-key"}\n');
    write(root, "src/visible.ts", "export const visible = 'safe-change';\n");

    git(root, "add", "-f", ".npmrc", "service-account-test.json", "src/visible.ts");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await client.callTool({ name: "git_diff", arguments: { mode: "staged" } })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).toContain("safe-change");
    expect(result.diff).not.toContain("supersecret-npm-token");
    expect(result.diff).not.toContain("supersecret-sa-key");

    git(root, "rm", "-f", "--cached", ".npmrc", "service-account-test.json", "src/visible.ts");
  });

  it("git_diff over MCP blocks sensitive-to-safe renames from leaking original content", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=mcp-secret-token-123\n");
    git(root, "add", "-f", ".npmrc");
    git(root, "commit", "-m", "add secret to rename");

    git(root, "mv", ".npmrc", "public_harmless.txt");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await client.callTool({ name: "git_diff", arguments: { mode: "staged" } })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).not.toContain("mcp-secret-token-123");
    expect(result.diff).not.toContain("public_harmless.txt");

    git(root, "reset", "--hard", "HEAD");
  });

  it("git_diff over MCP with path='src' blocks cross-boundary rename leaks from root secrets", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=root-mcp-scoped-secret\n");
    git(root, "add", "-f", ".npmrc");
    git(root, "commit", "-m", "add root secret for scoped test");

    // Rename root .npmrc to src/public.txt
    git(root, "mv", ".npmrc", "src/public.txt");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await client.callTool({
        name: "git_diff",
        arguments: { mode: "staged", path: "src" },
      })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).not.toContain("root-mcp-scoped-secret");
    expect(result.diff).not.toContain("src/public.txt");

    git(root, "reset", "--hard", "HEAD");
  });
});
