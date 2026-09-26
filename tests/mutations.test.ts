import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Workspace, WorkspaceError } from "../src/workspace/manager.js";
import { applyWorkspacePatch, writeWorkspaceFile } from "../src/workspace/mutations.js";
import { cleanup, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const roots: string[] = [];
const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");
function repo(): { root: string; workspace: Workspace } {
  const root = makeTmpDir("mutation-repo");
  roots.push(root);
  makeGitRepo(root);
  return { root, workspace: new Workspace(root) };
}
afterEach(() => { for (const root of roots.splice(0)) cleanup(root); });

describe("governed file mutations", () => {
  it("creates and atomically replaces regular UTF-8 files with content identity", () => {
    const { root, workspace } = repo();
    const created = writeWorkspaceFile(workspace, { path: "new-file.txt", content: "hello\n" });
    expect(created.action).toBe("created");
    expect(created.byteCount).toBe(6);
    expect(created.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(created.previous_sha256).toBeNull();
    expect(fs.readFileSync(path.join(root, "new-file.txt"), "utf8")).toBe("hello\n");
    const original = fs.readFileSync(path.join(root, "src/index.ts"));
    const originalSha = createHash("sha256").update(original).digest("hex");
    expect(() => writeWorkspaceFile(workspace, { path: "src/index.ts", content: "no precondition\n" })).toThrow(/expected_sha256/);
    expect(() => writeWorkspaceFile(workspace, { path: "src/index.ts", content: "stale\n", expected_sha256: "0".repeat(64) })).toThrow(/precondition/);
    expect(fs.readFileSync(path.join(root, "src/index.ts"))).toEqual(original);
    const modified = writeWorkspaceFile(workspace, { path: "src/index.ts", content: "export const answer = 43;\n", expected_sha256: originalSha });
    expect(modified.action).toBe("modified");
    expect(modified.previous_sha256).toBe(originalSha);
    expect(modified.diff).toContain("43");
    expect(() => writeWorkspaceFile(workspace, { path: "not-created.txt", content: "x", expected_sha256: "0".repeat(64) })).toThrow(/omit/);
  });

  it.each(["../outside.txt", path.resolve("outside.txt"), "Z:/outside.txt", ".git/config", ".env", "id_rsa"]) (
    "denies unsafe path %s", (target) => {
      const { workspace } = repo();
      expect(() => writeWorkspaceFile(workspace, { path: target, content: "x" })).toThrow(WorkspaceError);
    }
  );

  it("denies symlink escapes", () => {
    const { root, workspace } = repo();
    const outside = makeTmpDir("mutation-outside"); roots.push(outside);
    const link = path.join(root, "escape");
    try { fs.symlinkSync(outside, link, "junction"); }
    catch { return; }
    expect(() => writeWorkspaceFile(workspace, { path: "escape/pwned.txt", content: "x" })).toThrow(WorkspaceError);
    expect(fs.existsSync(path.join(outside, "pwned.txt"))).toBe(false);
  });

  it("does not overwrite a file created concurrently with an authorized new-file write", () => {
    const { root, workspace } = repo();
    const resolve = workspace.resolveMutationPath.bind(workspace);
    let calls = 0;
    vi.spyOn(workspace, "resolveMutationPath").mockImplementation((...args) => {
      const resolved = resolve(...args);
      calls++;
      if (calls === 2) fs.writeFileSync(resolved.abs, "concurrent\n", { flag: "wx" });
      return resolved;
    });
    expect(() => writeWorkspaceFile(workspace, { path: "raced.txt", content: "agent\n" })).toThrow();
    expect(fs.readFileSync(path.join(root, "raced.txt"), "utf8")).toBe("concurrent\n");
  });

  it("applies a normal patch and rejects a mixed safe/unsafe patch without partial writes", () => {
    const { root, workspace } = repo();
    const good = "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-export const answer = 42;\n+export const answer = 43;\n";
    const result = applyWorkspacePatch(workspace, { patch: good, expectedFiles: [{ path: "src/index.ts", sha256: sha256("export const answer = 42;\n") }] });
    expect(result.changedFiles.map((f) => f.path)).toEqual(["src/index.ts"]);
    expect(fs.readFileSync(path.join(root, "src/index.ts"), "utf8")).toContain("43");

    const before = fs.readFileSync(path.join(root, "src/index.ts"), "utf8");
    const mixed = `${good}--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-SECRET\n+OTHER\n`;
    expect(() => applyWorkspacePatch(workspace, { patch: mixed, expectedFiles: [
      { path: "src/index.ts", sha256: sha256(before) }, { path: ".env", sha256: null },
    ] })).toThrow(WorkspaceError);
    expect(fs.readFileSync(path.join(root, "src/index.ts"), "utf8")).toBe(before);
  });

  it("rejects a stale full-file preimage even when the changed tail is outside the patch hunk", () => {
    const { root, workspace } = repo();
    const stale = "export const answer = 42;\n// concurrently changed tail\n";
    write(root, "src/index.ts", stale);
    const patch = "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-export const answer = 42;\n+export const answer = 43;\n";
    expect(() => applyWorkspacePatch(workspace, { patch, expectedFiles: [{ path: "src/index.ts", sha256: sha256("export const answer = 42;\n") }] })).toThrow(/preimage SHA-256/);
    expect(fs.readFileSync(path.join(root, "src/index.ts"), "utf8")).toBe(stale);
  });

  it("creates a new patch target only with an expected-absent identity", () => {
    const { root, workspace } = repo();
    const patch = "--- /dev/null\n+++ b/new-patch.txt\n@@ -0,0 +1 @@\n+fresh\n";
    const result = applyWorkspacePatch(workspace, { patch, expectedFiles: [{ path: "new-patch.txt", sha256: null }] });
    expect(result.changedFiles).toMatchObject([{ path: "new-patch.txt", action: "created" }]);
    expect(fs.readFileSync(path.join(root, "new-patch.txt"), "utf8")).toBe("fresh\n");
  });

  it("rejects an expected-absent patch target that appeared before the call", () => {
    const { root, workspace } = repo();
    write(root, "appeared.txt", "other\n");
    const patch = "--- /dev/null\n+++ b/appeared.txt\n@@ -0,0 +1 @@\n+fresh\n";
    expect(() => applyWorkspacePatch(workspace, { patch, expectedFiles: [{ path: "appeared.txt", sha256: null }] })).toThrow();
    expect(fs.readFileSync(path.join(root, "appeared.txt"), "utf8")).toBe("other\n");
  });

  it("checks every multi-file preimage before any write", () => {
    const { root, workspace } = repo();
    const first = "first\n";
    const second = "second changed\n";
    write(root, "one.txt", first);
    write(root, "two.txt", second);
    const patch = [
      "--- a/one.txt", "+++ b/one.txt", "@@ -1 +1 @@", "-first", "+FIRST",
      "--- a/two.txt", "+++ b/two.txt", "@@ -1 +1 @@", "-second", "+SECOND", "",
    ].join("\n");
    expect(() => applyWorkspacePatch(workspace, { patch, expectedFiles: [
      { path: "one.txt", sha256: sha256(first) }, { path: "two.txt", sha256: sha256("second\n") },
    ] })).toThrow(/preimage SHA-256/);
    expect(fs.readFileSync(path.join(root, "one.txt"), "utf8")).toBe(first);
    expect(fs.readFileSync(path.join(root, "two.txt"), "utf8")).toBe(second);
  });

  it("rejects absolute/out-of-scope patch targets and deletes", () => {
    const { workspace } = repo();
    expect(() => applyWorkspacePatch(workspace, { patch: "--- a/../escape\n+++ b/../escape\n@@ -1 +1 @@\n-a\n+b\n", expectedFiles: [{ path: "../escape", sha256: "0".repeat(64) }] })).toThrow();
    expect(() => applyWorkspacePatch(workspace, { patch: "--- a/src/index.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-export const answer = 42;\n", expectedFiles: [{ path: "src/index.ts", sha256: sha256("export const answer = 42;\n") }] })).toThrow();
  });
});
