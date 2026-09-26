import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import {
  createBranch, createWorktree, gitAncestry, gitCommit, gitLog, gitMergeBase,
  exactLeasedFastForwardPushArgs, gitMergeFfOnly, gitPush, gitRemoteRefs, gitShow,
} from "../src/workspace/git-operations.js";
import { cleanup, git, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const roots: string[] = [];
function repo(): { root: string; workspace: Workspace } {
  const root = makeTmpDir("structured-git"); roots.push(root); makeGitRepo(root);
  return { root, workspace: new Workspace(root, { allowedWorktreeRoot: path.join(path.dirname(root), `${path.basename(root)}-worktrees`) }) };
}
afterEach(() => { for (const root of roots.splice(0)) cleanup(root); });

describe("structured Git operations", () => {
  it("bounds show/log and computes ancestry/merge-base", () => {
    const { root, workspace } = repo();
    const head = git(root, "rev-parse", "HEAD").trim();
    expect(gitShow(workspace, { ref: "HEAD" }).commit).toBe(head);
    expect(gitLog(workspace, { limit: 1000 }).length).toBeLessThanOrEqual(50);
    expect(gitAncestry(workspace, { ancestor: head, descendant: "HEAD" }).isAncestor).toBe(true);
    expect(gitMergeBase(workspace, { left: head, right: "HEAD" }).mergeBase).toBe(head);
  });

  it("creates a new worktree branch directly from the exact source SHA", () => {
    const { root, workspace } = repo();
    const head = git(root, "rev-parse", "HEAD").trim();
    const branch = createBranch(workspace, { branch: "codex/safe-candidate", base: "HEAD" });
    expect(branch.commit).toBe(branch.base);
    expect(() => createBranch(workspace, { branch: "bad name", base: "HEAD" })).toThrow();
    expect(() => createWorktree(workspace, { name: "stale-wt", branch: "codex/stale-wt", expectedSourceSha: "0".repeat(40) })).toThrow();
    expect(fs.existsSync(path.join(workspace.allowedWorktreeRoot!, "stale-wt"))).toBe(false);
    expect(() => createWorktree(workspace, { name: "candidate-wt", branch: branch.branch, expectedSourceSha: head })).toThrow(/already exists/);
    expect(git(root, "rev-parse", `refs/heads/${branch.branch}`).trim()).toBe(head);
    fs.mkdirSync(path.join(workspace.allowedWorktreeRoot!, "occupied-destination"), { recursive: true });
    expect(() => createWorktree(workspace, { name: "occupied-destination", branch: "codex/not-created", expectedSourceSha: head })).toThrow(/destination already exists/);
    const wt = createWorktree(workspace, { name: "candidate-wt", branch: "codex/exact-source", expectedSourceSha: head });
    roots.push(workspace.allowedWorktreeRoot!);
    expect(wt.clean).toBe(true);
    expect(wt.branch).toBe("codex/exact-source");
    expect(git(wt.path, "rev-parse", "HEAD").trim()).toBe(head);
    expect(git(root, "rev-parse", "refs/heads/codex/exact-source").trim()).toBe(head);
    expect(path.relative(workspace.allowedWorktreeRoot!, wt.path).startsWith("..")).toBe(false);
    expect(workspace.rootFor(wt.rootAlias).root).toBe(fs.realpathSync(wt.path));
    expect(root).toBe(workspace.root);
  });

  it("checks branch and HEAD before staging, then commits only explicit paths", () => {
    const { root, workspace } = repo();
    const head = git(root, "rev-parse", "HEAD").trim();
    write(root, "src/index.ts", "export const answer = 43;\n");
    write(root, "unrelated.txt", "keep dirty\n");
    const fileSha = (content: string) => createHash("sha256").update(content).digest("hex");
    const input = { message: "update one file", paths: ["src/index.ts"], expectedFiles: [{ path: "src/index.ts", sha256: fileSha("export const answer = 43;\n") }], expectedBranch: "main", expectedHead: head };
    expect(() => gitCommit(workspace, { ...input, expectedBranch: "other" })).toThrow(/branch precondition/);
    expect(git(root, "diff", "--cached", "--name-only").trim()).toBe("");
    expect(() => gitCommit(workspace, { ...input, expectedHead: "0".repeat(40) })).toThrow(/HEAD precondition/);
    expect(git(root, "diff", "--cached", "--name-only").trim()).toBe("");
    expect(() => gitCommit(workspace, { ...input, expectedFiles: [{ path: "src/index.ts", sha256: "0".repeat(64) }] })).toThrow(/SHA-256 precondition/);
    expect(git(root, "diff", "--cached", "--name-only").trim()).toBe("");
    expect(() => gitCommit(workspace, { ...input, expectedFiles: [{ path: "hello.txt", sha256: fileSha("Hello from Codex with ChatGPT!\n") }] })).toThrow(/path set/);
    expect(git(root, "diff", "--cached", "--name-only").trim()).toBe("");
    const prior = {
      name: process.env.GIT_AUTHOR_NAME,
      email: process.env.GIT_AUTHOR_EMAIL,
      committer: process.env.GIT_COMMITTER_NAME,
      committerEmail: process.env.GIT_COMMITTER_EMAIL,
    };
    process.env.GIT_AUTHOR_NAME = "test-c2c";
    process.env.GIT_AUTHOR_EMAIL = "test@c2c.local";
    process.env.GIT_COMMITTER_NAME = "test-c2c";
    process.env.GIT_COMMITTER_EMAIL = "test@c2c.local";
    let commit: ReturnType<typeof gitCommit>;
    try { commit = gitCommit(workspace, input); }
    finally {
      if (prior.name === undefined) delete process.env.GIT_AUTHOR_NAME; else process.env.GIT_AUTHOR_NAME = prior.name;
      if (prior.email === undefined) delete process.env.GIT_AUTHOR_EMAIL; else process.env.GIT_AUTHOR_EMAIL = prior.email;
      if (prior.committer === undefined) delete process.env.GIT_COMMITTER_NAME; else process.env.GIT_COMMITTER_NAME = prior.committer;
      if (prior.committerEmail === undefined) delete process.env.GIT_COMMITTER_EMAIL; else process.env.GIT_COMMITTER_EMAIL = prior.committerEmail;
    }
    expect(commit.committedPaths).toEqual(["src/index.ts"]);
    expect(commit.expectedHead).toBe(head);
    expect(commit.observedHead).toBe(head);
    expect(commit.expectedFiles).toEqual([{ path: "src/index.ts", expectedSha256: fileSha("export const answer = 43;\n"), observedSha256: fileSha("export const answer = 43;\n") }]);
    expect(commit.status.untracked).toContain("unrelated.txt");
    expect(git(root, "show", "--pretty=", "--name-only", "HEAD")).toContain("src/index.ts");
    expect(git(root, "show", "--pretty=", "--name-only", "HEAD")).not.toContain("unrelated.txt");
  });

  it("rejects an unauthorized pre-existing staged path without changing the index", () => {
    const { root, workspace } = repo();
    const head = git(root, "rev-parse", "HEAD").trim();
    write(root, "src/index.ts", "export const answer = 43;\n");
    write(root, "unrelated.txt", "staged elsewhere\n");
    git(root, "add", "--", "unrelated.txt");
    const fileSha = (content: string) => createHash("sha256").update(content).digest("hex");
    expect(() => gitCommit(workspace, {
      message: "must not include unrelated staged content",
      paths: ["src/index.ts"],
      expectedFiles: [{ path: "src/index.ts", sha256: fileSha("export const answer = 43;\n") }],
      expectedBranch: "main",
      expectedHead: head,
    })).toThrow(/clean index/);
    expect(git(root, "rev-parse", "HEAD").trim()).toBe(head);
    expect(git(root, "diff", "--cached", "--name-only").trim()).toBe("unrelated.txt");
  });

  it("commits the verified staged snapshot even when the worktree changes after staging", async () => {
    const { root, workspace } = repo();
    const head = git(root, "rev-parse", "HEAD").trim();
    const reviewed = "export const answer = 43;\n";
    const laterWorktree = "export const answer = 99;\n";
    write(root, "src/index.ts", reviewed);
    const fileSha = (content: string) => createHash("sha256").update(content).digest("hex");
    let stagedThenChanged = false;
    vi.resetModules();
    vi.doMock("../src/workspace/git.js", async () => {
      const actual = await vi.importActual<typeof import("../src/workspace/git.js")>("../src/workspace/git.js");
      return {
        ...actual,
        runGit: (cwd: string, args: string[]) => {
          const result = actual.runGit(cwd, args);
          if (result.ok && !stagedThenChanged && args[0] === "add") {
            stagedThenChanged = true;
            write(root, "src/index.ts", laterWorktree);
          }
          return result;
        },
      };
    });
    const priorIdentity = {
      author: process.env.GIT_AUTHOR_NAME,
      authorEmail: process.env.GIT_AUTHOR_EMAIL,
      committer: process.env.GIT_COMMITTER_NAME,
      committerEmail: process.env.GIT_COMMITTER_EMAIL,
    };
    process.env.GIT_AUTHOR_NAME = "test-c2c";
    process.env.GIT_AUTHOR_EMAIL = "test@c2c.local";
    process.env.GIT_COMMITTER_NAME = "test-c2c";
    process.env.GIT_COMMITTER_EMAIL = "test@c2c.local";
    try {
      const isolatedModule = await import("../src/workspace/git-operations.js");
      const commit = isolatedModule.gitCommit(workspace, {
        message: "commit the reviewed index snapshot",
        paths: ["src/index.ts"],
        expectedFiles: [{ path: "src/index.ts", sha256: fileSha(reviewed) }],
        expectedBranch: "main",
        expectedHead: head,
      });
      expect(stagedThenChanged).toBe(true);
      expect(git(root, "show", `${commit.commit}:src/index.ts`)).toBe(reviewed);
      expect(fs.readFileSync(path.join(root, "src/index.ts"), "utf8")).toBe(laterWorktree);
      expect(commit.status.unstaged.map((entry) => entry.path)).toContain("src/index.ts");
      expect(commit.expectedFiles).toEqual([{ path: "src/index.ts", expectedSha256: fileSha(reviewed), observedSha256: fileSha(reviewed) }]);
    } finally {
      if (priorIdentity.author === undefined) delete process.env.GIT_AUTHOR_NAME; else process.env.GIT_AUTHOR_NAME = priorIdentity.author;
      if (priorIdentity.authorEmail === undefined) delete process.env.GIT_AUTHOR_EMAIL; else process.env.GIT_AUTHOR_EMAIL = priorIdentity.authorEmail;
      if (priorIdentity.committer === undefined) delete process.env.GIT_COMMITTER_NAME; else process.env.GIT_COMMITTER_NAME = priorIdentity.committer;
      if (priorIdentity.committerEmail === undefined) delete process.env.GIT_COMMITTER_EMAIL; else process.env.GIT_COMMITTER_EMAIL = priorIdentity.committerEmail;
      vi.doUnmock("../src/workspace/git.js");
      vi.resetModules();
    }
  });

  it("rejects an index blob changed after staging and creates no commit", async () => {
    const { root, workspace } = repo();
    const head = git(root, "rev-parse", "HEAD").trim();
    const reviewed = "export const answer = 43;\n";
    const changedIndex = "export const answer = 99;\n";
    write(root, "src/index.ts", reviewed);
    const fileSha = (content: string) => createHash("sha256").update(content).digest("hex");
    let restagedChangedIndex = false;
    vi.resetModules();
    vi.doMock("../src/workspace/git.js", async () => {
      const actual = await vi.importActual<typeof import("../src/workspace/git.js")>("../src/workspace/git.js");
      return {
        ...actual,
        runGit: (cwd: string, args: string[]) => {
          const result = actual.runGit(cwd, args);
          if (result.ok && !restagedChangedIndex && args[0] === "add") {
            restagedChangedIndex = true;
            write(root, "src/index.ts", changedIndex);
            const restage = actual.runGit(root, ["add", "--", ":(literal)src/index.ts"]);
            if (!restage.ok) throw new Error("test setup could not replace the staged blob");
          }
          return result;
        },
      };
    });
    try {
      const isolatedModule = await import("../src/workspace/git-operations.js");
      expect(() => isolatedModule.gitCommit(workspace, {
        message: "reject stale index blob",
        paths: ["src/index.ts"],
        expectedFiles: [{ path: "src/index.ts", sha256: fileSha(reviewed) }],
        expectedBranch: "main",
        expectedHead: head,
      })).toThrow(/Staged index SHA-256/);
      expect(restagedChangedIndex).toBe(true);
      expect(git(root, "rev-parse", "HEAD").trim()).toBe(head);
      expect(git(root, "show", ":src/index.ts")).toBe(changedIndex);
      expect(git(root, "diff", "--cached", "--name-only").trim()).toBe("src/index.ts");
    } finally {
      vi.doUnmock("../src/workspace/git.js");
      vi.resetModules();
    }
  });

  it("reads only requested live origin refs without updating tracking refs", () => {
    const { root, workspace } = repo();
    const bare = makeTmpDir("bare-remote"); roots.push(bare); git(bare, "init", "--bare");
    git(root, "remote", "add", "origin", bare);
    const head = git(root, "rev-parse", "HEAD").trim();
    git(root, "push", "origin", "HEAD:refs/heads/existing");
    const before = git(root, "for-each-ref", "--format=%(refname)=%(objectname)", "refs/remotes/origin");
    const refs = gitRemoteRefs(workspace, { branches: ["existing", "missing"] });
    const after = git(root, "for-each-ref", "--format=%(refname)=%(objectname)", "refs/remotes/origin");
    expect(refs).toEqual({ remote: "origin", refs: [
      { branch: "existing", ref: "refs/heads/existing", sha: head },
      { branch: "missing", ref: "refs/heads/missing", sha: null },
    ] });
    expect(after).toBe(before);
    expect(() => gitRemoteRefs(workspace, { branches: ["main"], remote: "upstream" })).toThrow();
    expect(() => gitRemoteRefs(workspace, { branches: ["--upload-pack=evil"] })).toThrow();
    expect(() => gitRemoteRefs(workspace, { branches: Array.from({ length: 51 }, (_, i) => `b${i}`) })).toThrow();
  });

  it("requires exact local and live remote SHAs and generates a ref-specific exact lease", () => {
    const { root, workspace } = repo();
    const bare = makeTmpDir("bare-remote"); roots.push(bare); git(bare, "init", "--bare");
    git(root, "remote", "add", "origin", bare);
    const initial = git(root, "rev-parse", "HEAD").trim();
    expect(() => gitPush(workspace, { branch: "main", remoteBranch: "candidate", expectedLocalSha: "0".repeat(40), expectedRemoteSha: null })).toThrow(/local SHA precondition/);
    git(root, "push", "origin", "HEAD:refs/heads/candidate");
    expect(() => gitPush(workspace, { branch: "main", remoteBranch: "candidate", expectedLocalSha: initial, expectedRemoteSha: null })).toThrow(/remote SHA precondition/);

    write(root, "next.txt", "next\n"); git(root, "add", "next.txt"); git(root, "commit", "-m", "next");
    const next = git(root, "rev-parse", "HEAD").trim();
    expect(() => gitPush(workspace, { branch: "main", remoteBranch: "candidate", expectedLocalSha: initial, expectedRemoteSha: initial })).toThrow(/local SHA precondition/);
    expect(() => gitPush(workspace, { branch: "main", remoteBranch: "candidate", expectedLocalSha: next, expectedRemoteSha: "f".repeat(40) })).toThrow(/remote SHA precondition/);
    const fastForward = gitPush(workspace, { branch: "main", remoteBranch: "candidate", expectedLocalSha: next, expectedRemoteSha: initial });
    expect(fastForward.remoteReadbackSha).toBe(next);
    expect(exactLeasedFastForwardPushArgs("main", "candidate", initial)).toEqual([
      "push", "--porcelain", `--force-with-lease=refs/heads/candidate:${initial}`, "--", "origin", "refs/heads/main:refs/heads/candidate",
    ]);

    const created = gitPush(workspace, { branch: "main", remoteBranch: "new-branch", expectedLocalSha: next, expectedRemoteSha: null });
    expect(created.remoteReadbackSha).toBe(next);
    expect(exactLeasedFastForwardPushArgs("main", "new-branch", null)).toEqual([
      "push", "--porcelain", "--force-with-lease=refs/heads/new-branch:", "--", "origin", "refs/heads/main:refs/heads/new-branch",
    ]);
    expect(() => gitPush(workspace, { branch: "main", remoteBranch: "candidate", expectedLocalSha: next, expectedRemoteSha: next, remote: "--force" })).toThrow();
    expect(git(bare, "rev-parse", "refs/heads/candidate").trim()).toBe(next);
  });

  it("rejects a non-descendant expected remote commit before pushing", () => {
    const { root, workspace } = repo();
    const bare = makeTmpDir("bare-divergent-remote"); roots.push(bare); git(bare, "init", "--bare");
    git(root, "remote", "add", "origin", bare);
    const initial = git(root, "rev-parse", "HEAD").trim();
    git(root, "switch", "-c", "remote-side", initial);
    write(root, "remote-only.txt", "remote\n"); git(root, "add", "remote-only.txt"); git(root, "commit", "-m", "remote side");
    const remoteSha = git(root, "rev-parse", "HEAD").trim();
    git(root, "push", "origin", "HEAD:refs/heads/candidate");
    git(root, "switch", "-c", "local-side", initial);
    write(root, "local-only.txt", "local\n"); git(root, "add", "local-only.txt"); git(root, "commit", "-m", "local side");
    const localSha = git(root, "rev-parse", "HEAD").trim();
    expect(() => gitPush(workspace, { branch: "local-side", remoteBranch: "candidate", expectedLocalSha: localSha, expectedRemoteSha: remoteSha })).toThrow(/fast-forward/);
    expect(git(bare, "rev-parse", "refs/heads/candidate").trim()).toBe(remoteSha);
  });

  it("requires exact branch/HEAD for fast-forward merge and rejects divergence", () => {
    const { root, workspace } = repo();
    const before = git(root, "rev-parse", "HEAD").trim();
    git(root, "switch", "-c", "side");
    write(root, "side.txt", "side\n"); git(root, "add", "side.txt"); git(root, "commit", "-m", "side");
    git(root, "switch", "main");
    expect(() => gitMergeFfOnly(workspace, { source: "side", expectedBranch: "other", expectedHead: before })).toThrow(/branch precondition/);
    expect(() => gitMergeFfOnly(workspace, { source: "side", expectedBranch: "main", expectedHead: "0".repeat(40) })).toThrow(/HEAD precondition/);
    expect(git(root, "rev-parse", "HEAD").trim()).toBe(before);
    const ff = gitMergeFfOnly(workspace, { source: "side", expectedBranch: "main", expectedHead: before });
    expect(ff.after).not.toBe(ff.before);
    expect(ff.changedPaths).toContain("side.txt");

    git(root, "switch", "-c", "diverged");
    write(root, "diverged.txt", "diverged\n"); git(root, "add", "diverged.txt"); git(root, "commit", "-m", "diverged");
    git(root, "switch", "main");
    write(root, "main-only.txt", "main\n"); git(root, "add", "main-only.txt"); git(root, "commit", "-m", "main only");
    const current = git(root, "rev-parse", "HEAD").trim();
    expect(() => gitMergeFfOnly(workspace, { source: "diverged", expectedBranch: "main", expectedHead: current })).toThrow();
  });
});
