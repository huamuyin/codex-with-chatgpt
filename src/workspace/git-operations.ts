import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { Workspace, WorkspaceError } from "./manager.js";
import { gitInfo, gitStatus, runGit } from "./git.js";

function safeName(value: string, label: string, max = 100): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\0\r\n]/.test(value)) {
    throw new WorkspaceError("INVALID_PATH", `${label} is invalid.`);
  }
  return value;
}

function isSafeRef(value: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) return false;
  if (value.includes("..") || value.includes("//") || value.includes("@{") || value.endsWith(".") || value.endsWith("/")) return false;
  return !value.split("/").some((part) => part === "" || part.startsWith(".") || part.endsWith(".lock"));
}

function checkedGit(root: string, args: string[], error: string): string {
  const result = runGit(root, args);
  if (!result.ok) throw new WorkspaceError("INVALID_PATH", error);
  return result.stdout.trim();
}

function resolveCommit(root: string, ref: string): string {
  safeName(ref, "Git ref", 256);
  if (!isSafeRef(ref)) throw new WorkspaceError("INVALID_PATH", "Git ref is not a supported branch, tag, or object name.");
  return checkedGit(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], "Git ref did not resolve to a commit.");
}

function validateBranch(root: string, branch: string): string {
  safeName(branch, "Branch name", 200);
  if (!isSafeRef(branch) || branch.startsWith("refs/")) throw new WorkspaceError("INVALID_PATH", "Branch name is invalid.");
  return checkedGit(root, ["check-ref-format", "--branch", branch], "Branch name is invalid.");
}

function safePath(workspace: Workspace, value: string, rootAlias: string): { workspace: Workspace; abs: string; rel: string } {
  const target = workspace.resolveMutationPath(value, rootAlias);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(target.abs); }
  catch { throw new WorkspaceError("FILE_NOT_FOUND", `Path does not exist: ${target.rel}`); }
  if (stat.isSymbolicLink()) throw new WorkspaceError("SYMLINK_NOT_ALLOWED", "Git operations cannot traverse symlink or junction targets.");
  if (!stat.isFile()) throw new WorkspaceError("NOT_A_FILE", `Git path must be a regular file: ${target.rel}`);
  return { workspace: target.workspace, abs: target.abs, rel: target.rel };
}

function disabledHooks<T>(callback: (env: NodeJS.ProcessEnv, configArgs: string[]) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-empty-hooks-"));
  try {
    return callback(process.env, ["-c", `core.hooksPath=${dir}`]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export interface GitShowResult {
  commit: string;
  parents: string[];
  author: string;
  authorDate: string;
  subject: string;
  changedPaths: string[];
  diff: string | null;
}

export function gitShow(workspace: Workspace, input: { ref: string; path?: string; root?: string; maxBytes?: number }): GitShowResult {
  const target = workspace.rootFor(input.root ?? "workspace");
  const sha = resolveCommit(target.root, input.ref);
  const metadata = checkedGit(target.root, ["show", "-s", "--format=%H%x00%P%x00%an%x00%aI%x00%s", sha], "Unable to read commit metadata.").split("\0");
  const rawPaths = runGit(target.root, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", sha]);
  if (!rawPaths.ok) throw new WorkspaceError("INVALID_PATH", "Unable to read commit paths.");
  let changedPaths = rawPaths.stdout.split("\0").filter(Boolean).filter((p) => !target.ignoreRules.isSensitive(p) && !p.split("/").some((part) => part.toLowerCase() === ".git"));
  let pathRel: string | undefined;
  if (input.path) {
    pathRel = target.resolve(input.path).rel;
    changedPaths = changedPaths.filter((p) => p === pathRel || p.startsWith(`${pathRel}/`));
  }
  let diff: string | null = null;
  if (input.path && changedPaths.length > 0) {
    const maxBytes = Math.min(128 * 1024, Math.max(1024, Math.floor(input.maxBytes ?? 32 * 1024)));
    const result = runGit(target.root, ["show", "--no-ext-diff", "--no-renames", "--format=", sha, "--", `:(literal)${pathRel}`]);
    if (!result.ok) throw new WorkspaceError("INVALID_PATH", "Unable to read commit path diff.");
    diff = Buffer.from(result.stdout, "utf8").subarray(0, maxBytes).toString("utf8");
  }
  return {
    commit: metadata[0] ?? sha,
    parents: (metadata[1] ?? "").split(" ").filter(Boolean),
    author: metadata[2] ?? "",
    authorDate: metadata[3] ?? "",
    subject: metadata[4] ?? "",
    changedPaths,
    diff,
  };
}

export interface GitLogEntry { commit: string; parents: string[]; author: string; date: string; subject: string }

export function gitLog(workspace: Workspace, input: { ref?: string; path?: string; root?: string; limit?: number }): GitLogEntry[] {
  const target = workspace.rootFor(input.root ?? "workspace");
  const ref = input.ref ? resolveCommit(target.root, input.ref) : "HEAD";
  const limit = Math.min(50, Math.max(1, Math.floor(input.limit ?? 10)));
  const args = ["log", `-${limit}`, "--format=%H%x00%P%x00%an%x00%aI%x00%s", ref];
  if (input.path) args.push("--", `:(literal)${target.resolve(input.path).rel}`);
  const result = runGit(target.root, args);
  if (!result.ok) throw new WorkspaceError("INVALID_PATH", "Unable to read Git history.");
  return result.stdout.split("\n").filter(Boolean).map((line) => {
    const [commit = "", parents = "", author = "", date = "", subject = ""] = line.split("\0");
    return { commit, parents: parents.split(" ").filter(Boolean), author, date, subject };
  });
}

export function gitAncestry(workspace: Workspace, input: { ancestor: string; descendant: string; root?: string }): { ancestor: string; descendant: string; isAncestor: boolean; mergeBase: string | null } {
  const target = workspace.rootFor(input.root ?? "workspace");
  const ancestor = resolveCommit(target.root, input.ancestor);
  const descendant = resolveCommit(target.root, input.descendant);
  const check = runGit(target.root, ["merge-base", "--is-ancestor", ancestor, descendant]);
  if (!check.ok && check.code !== 1) throw new WorkspaceError("INVALID_PATH", "Unable to evaluate Git ancestry.");
  const base = runGit(target.root, ["merge-base", ancestor, descendant]);
  if (!base.ok) throw new WorkspaceError("INVALID_PATH", "No merge-base is available for the requested commits.");
  return { ancestor, descendant, isAncestor: check.ok, mergeBase: base.stdout.trim() };
}

export function createBranch(workspace: Workspace, input: { branch: string; base: string; root?: string }): { branch: string; base: string; commit: string } {
  const target = workspace.rootFor(input.root ?? "workspace");
  const branch = validateBranch(target.root, input.branch);
  if (runGit(target.root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok) {
    throw new WorkspaceError("INVALID_PATH", "Branch already exists.");
  }
  const base = resolveCommit(target.root, input.base);
  checkedGit(target.root, ["branch", "--no-track", branch, base], "Unable to create branch.");
  const commit = resolveCommit(target.root, `refs/heads/${branch}`);
  return { branch, base, commit };
}

function ensureWorktreeRoot(workspace: Workspace): string {
  const configured = workspace.allowedWorktreeRoot;
  if (!configured) throw new WorkspaceError("WORKTREE_ROOT_NOT_CONFIGURED", "No allowed worktree root is configured or derivable.");
  const parsed = path.parse(configured);
  const relative = path.relative(parsed.root, configured).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of relative) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new WorkspaceError("SYMLINK_NOT_ALLOWED", "Allowed worktree root may not contain symlinks or junctions.");
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      break;
    }
  }
  fs.mkdirSync(configured, { recursive: true });
  const real = fs.realpathSync.native(configured);
  if (path.resolve(real) !== path.resolve(configured)) throw new WorkspaceError("PATH_OUTSIDE_WORKSPACE", "Allowed worktree root resolved through a link.");
  return real;
}

export function createWorktree(workspace: Workspace, input: { name: string; branch: string; expectedSourceSha: string; root?: string }): { name: string; rootAlias: string; path: string; branch: string; head: string; clean: boolean; expectedSourceSha: string } {
  const target = workspace.rootFor(input.root ?? "workspace");
  safeName(input.name, "Worktree name", 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.name) || input.name.includes("..")) {
    throw new WorkspaceError("INVALID_WORKTREE_NAME", "Worktree name must be 1-64 safe letters, digits, dot, underscore or hyphen.");
  }
  const branch = validateBranch(target.root, input.branch);
  if (/^[a-f0-9]{40,64}$/i.test(branch)) throw new WorkspaceError("INVALID_PATH", "A new worktree branch name is required.");
  const existingBranch = runGit(target.root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (existingBranch.ok) throw new WorkspaceError("STATE_MISMATCH", "Requested worktree branch already exists.");
  if (existingBranch.code !== 1) throw new WorkspaceError("INVALID_PATH", "Unable to verify that the requested branch is absent.");
  const root = ensureWorktreeRoot(workspace);
  const destination = path.join(root, input.name);
  try {
    fs.lstatSync(destination);
    throw new WorkspaceError("STATE_MISMATCH", "Worktree destination already exists.");
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!/^[a-f0-9]{40,64}$/i.test(input.expectedSourceSha)) throw new WorkspaceError("INVALID_PATH", "expected_source_sha must be a full commit SHA.");
  const sha = resolveCommit(target.root, input.expectedSourceSha);
  if (sha !== input.expectedSourceSha.toLowerCase()) throw new WorkspaceError("STATE_MISMATCH", `Worktree source precondition failed: expected exact commit ${input.expectedSourceSha}, observed ${sha}.`);
  const clean = runGit(target.root, ["status", "--porcelain=v2", "--untracked-files=all"]);
  if (!clean.ok || clean.stdout.trim()) throw new WorkspaceError("INVALID_PATH", "Worktree creation requires a clean source worktree.");
  disabledHooks((_env, hookConfig) => {
    const result = runGit(target.root, [...hookConfig, "worktree", "add", "-b", branch, "--", destination, sha]);
    if (!result.ok) throw new WorkspaceError("INVALID_PATH", "Git could not create the requested worktree.");
  });
  const branchResult = runGit(destination, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const info = gitInfo(destination);
  const status = runGit(destination, ["status", "--porcelain=v2", "--untracked-files=all"]);
  const observedBranch = branchResult.ok ? branchResult.stdout.trim() : null;
  const observedHead = runGit(destination, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!info.isRepo || !status.ok || !observedHead.ok || observedHead.stdout.trim() !== sha || observedBranch !== branch) {
    throw new WorkspaceError("STATE_MISMATCH", "Created worktree did not match the exact expected source commit and new branch.");
  }
  const rootAlias = workspace.registerWorktree(input.name, destination);
  return { name: input.name, rootAlias, path: destination, branch, head: sha, clean: status.stdout.trim() === "", expectedSourceSha: sha };
}

function ensureIndexClean(root: string): void {
  const result = runGit(root, ["diff", "--cached", "--name-only", "-z"]);
  if (!result.ok) throw new WorkspaceError("INVALID_PATH", "Unable to inspect Git index.");
  if (result.stdout.length > 0) throw new WorkspaceError("INVALID_PATH", "Git commit requires an initially clean index to avoid including unrelated staged changes.");
  const unmerged = runGit(root, ["diff", "--name-only", "--diff-filter=U"]);
  if (!unmerged.ok || unmerged.stdout.trim()) throw new WorkspaceError("INVALID_PATH", "Git conflicts must be resolved before committing.");
}

export interface ExpectedFileIdentity { path: string; sha256: string }

function fileSha256(abs: string): string {
  return createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
}

interface IndexEntry { mode: string; object: string; stage: number; path: string }

function readIndexEntries(root: string, paths: string[]): IndexEntry[] {
  const pathspecs = paths.map((filePath) => `:(literal)${filePath}`);
  const result = runGit(root, ["ls-files", "--stage", "-z", "--", ...pathspecs]);
  if (!result.ok) throw new WorkspaceError("INVALID_PATH", "Unable to inspect staged commit content.");
  return result.stdout.split("\0").filter(Boolean).map((record) => {
    const tab = record.indexOf("\t");
    if (tab < 0) throw new WorkspaceError("INVALID_PATH", "Git returned a malformed index entry.");
    const [mode = "", object = "", stageText = ""] = record.slice(0, tab).split(" ");
    const stage = Number(stageText);
    if (!/^[a-f0-9]{40,64}$/i.test(object) || !Number.isInteger(stage)) {
      throw new WorkspaceError("INVALID_PATH", "Git returned an invalid index identity.");
    }
    return { mode, object, stage, path: record.slice(tab + 1) };
  });
}

function indexBlobSha256(root: string, object: string): string {
  try {
    const blob = execFileSync("git", ["cat-file", "blob", object], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
    });
    return createHash("sha256").update(blob).digest("hex");
  } catch {
    throw new WorkspaceError("INVALID_PATH", "Unable to read staged commit content.");
  }
}

function validateStagedFileIdentities(root: string, paths: string[], expectedFiles: ExpectedFileIdentity[]): { path: string; expectedSha256: string; observedSha256: string }[] {
  const expectedByPath = new Map(expectedFiles.map((file) => [file.path, file.sha256.toLowerCase()]));
  const entries = readIndexEntries(root, paths);
  const entryPaths = entries.map((entry) => entry.path);
  if (entries.length !== paths.length || new Set(entryPaths).size !== paths.length ||
      [...entryPaths].sort().join("\0") !== [...paths].sort().join("\0") ||
      entries.some((entry) => entry.stage !== 0 || !["100644", "100755"].includes(entry.mode))) {
    throw new WorkspaceError("STATE_MISMATCH", "Staged index paths or file modes do not match the authorized regular files.");
  }
  const shaByPath = new Map(entries.map((entry) => [entry.path, indexBlobSha256(root, entry.object)]));
  return paths.map((filePath) => {
    const expectedSha256 = expectedByPath.get(filePath);
    const observedSha256 = shaByPath.get(filePath);
    if (!expectedSha256 || !observedSha256 || observedSha256 !== expectedSha256) {
      throw new WorkspaceError("STATE_MISMATCH", `Staged index SHA-256 precondition failed for '${filePath}'.`);
    }
    return { path: filePath, expectedSha256, observedSha256 };
  });
}

function stagedChangedPaths(root: string): string[] {
  const result = runGit(root, ["diff", "--cached", "--name-only", "-z"]);
  if (!result.ok) throw new WorkspaceError("INVALID_PATH", "Unable to inspect staged commit paths.");
  return result.stdout.split("\0").filter(Boolean).sort();
}

function unstageOwnedExpectedFiles(root: string, expectedFiles: ExpectedFileIdentity[]): void {
  for (const file of expectedFiles) {
    try {
      const entries = readIndexEntries(root, [file.path]);
      if (entries.length !== 1 || entries[0]?.stage !== 0 || !["100644", "100755"].includes(entries[0]?.mode ?? "")) continue;
      if (indexBlobSha256(root, entries[0].object) !== file.sha256.toLowerCase()) continue;
      runGit(root, ["restore", "--staged", "--", `:(literal)${file.path}`]);
    } catch {
      // Leave an index entry alone when ownership or its current identity is uncertain.
    }
  }
}

function assertStagedPathSet(root: string, paths: string[]): void {
  const stagedPaths = stagedChangedPaths(root);
  if (stagedPaths.length !== paths.length || stagedPaths.join("\0") !== [...paths].sort().join("\0")) {
    throw new WorkspaceError("STATE_MISMATCH", "Staged path set does not exactly match the explicitly authorized commit paths.");
  }
}

function validateExpectedFileIdentities(workspace: Workspace, paths: string[], expectedFiles: ExpectedFileIdentity[], rootAlias: string): { path: string; expectedSha256: string; observedSha256: string }[] {
  if (!Array.isArray(expectedFiles) || expectedFiles.length !== paths.length) throw new WorkspaceError("INVALID_PATH", "expected_files must identify every and only committed path.");
  const identities = expectedFiles.map((item) => {
    if (!/^[a-f0-9]{64}$/i.test(item.sha256)) throw new WorkspaceError("INVALID_PATH", "Each expected file identity requires a SHA-256 digest.");
    const file = safePath(workspace, item.path, rootAlias);
    return { path: file.rel, abs: file.abs, expectedSha256: item.sha256.toLowerCase(), observedSha256: fileSha256(file.abs) };
  });
  if (new Set(identities.map((item) => item.path)).size !== identities.length) throw new WorkspaceError("INVALID_PATH", "expected_files paths must be unique.");
  if (identities.map((item) => item.path).sort().join("\0") !== [...paths].sort().join("\0")) throw new WorkspaceError("INVALID_PATH", "expected_files path set must exactly equal paths.");
  for (const item of identities) {
    if (item.expectedSha256 !== item.observedSha256) throw new WorkspaceError("STATE_MISMATCH", `Commit file SHA-256 precondition failed for '${item.path}'.`);
  }
  return identities.map(({ path: filePath, expectedSha256, observedSha256 }) => ({ path: filePath, expectedSha256, observedSha256 }));
}

export function gitCommit(workspace: Workspace, input: { message: string; paths: string[]; expectedFiles: ExpectedFileIdentity[]; expectedBranch: string; expectedHead: string; root?: string }): { parent: string; commit: string; branch: string; committedPaths: string[]; expectedFiles: { path: string; expectedSha256: string; observedSha256: string }[]; expectedBranch: string; observedBranch: string; expectedHead: string; observedHead: string; status: ReturnType<typeof gitStatus> } {
  const target = workspace.rootFor(input.root ?? "workspace");
  const message = safeName(input.message, "Commit message", 500);
  if (!input.paths.length || input.paths.length > 100) throw new WorkspaceError("INVALID_PATH", "Commit requires 1-100 explicit paths.");
  const files = input.paths.map((p) => safePath(workspace, p, input.root ?? "workspace"));
  const paths = [...new Set(files.map((p) => p.rel))];
  if (paths.length !== files.length) throw new WorkspaceError("INVALID_PATH", "Commit paths must be unique.");
  const statusBefore = gitStatus(target);
  if (!statusBefore.isRepo || !statusBefore.branch || statusBefore.branch === "(detached)") throw new WorkspaceError("INVALID_PATH", "Commit requires a checked-out branch.");
  const observedBranch = statusBefore.branch;
  const observedHead = checkedGit(target.root, ["rev-parse", "--verify", "HEAD^{commit}"], "Current HEAD is not a commit.");
  if (observedBranch !== input.expectedBranch) {
    throw new WorkspaceError("STATE_MISMATCH", `Commit branch precondition failed: expected '${input.expectedBranch}', observed '${observedBranch}'.`);
  }
  if (observedHead !== input.expectedHead) {
    throw new WorkspaceError("STATE_MISMATCH", `Commit HEAD precondition failed: expected ${input.expectedHead}, observed ${observedHead}.`);
  }
  const expectedFiles = validateExpectedFileIdentities(workspace, paths, input.expectedFiles, input.root ?? "workspace");
  ensureIndexClean(target.root);
  const parent = observedHead;
  const pathspecs = paths.map((p) => `:(literal)${p}`);
  // Re-resolve and hash all authorized regular files immediately before staging.
  const currentFiles = validateExpectedFileIdentities(workspace, paths, input.expectedFiles, input.root ?? "workspace");
  if (currentFiles.some((item, index) => item.observedSha256 !== expectedFiles[index]?.observedSha256)) {
    throw new WorkspaceError("STATE_MISMATCH", "Commit file content changed immediately before staging.");
  }
  const add = runGit(target.root, ["add", "--", ...pathspecs]);
  if (!add.ok) {
    unstageOwnedExpectedFiles(target.root, input.expectedFiles);
    throw new WorkspaceError("INVALID_PATH", "Unable to stage only the requested commit paths.");
  }
  let stagedFiles: ReturnType<typeof validateStagedFileIdentities>;
  try {
    assertStagedPathSet(target.root, paths);
    stagedFiles = validateStagedFileIdentities(target.root, paths, input.expectedFiles);

    const beforeCommit = gitStatus(target);
    const branchBeforeCommit = beforeCommit.branch;
    const headBeforeCommit = checkedGit(target.root, ["rev-parse", "--verify", "HEAD^{commit}"], "Current HEAD is not a commit.");
    if (branchBeforeCommit !== input.expectedBranch) {
      throw new WorkspaceError("STATE_MISMATCH", `Commit branch precondition failed immediately before commit: expected '${input.expectedBranch}', observed '${branchBeforeCommit}'.`);
    }
    if (headBeforeCommit !== input.expectedHead) {
      throw new WorkspaceError("STATE_MISMATCH", `Commit HEAD precondition failed immediately before commit: expected ${input.expectedHead}, observed ${headBeforeCommit}.`);
    }
    assertStagedPathSet(target.root, paths);
    stagedFiles = validateStagedFileIdentities(target.root, paths, input.expectedFiles);
    const conflicts = runGit(target.root, ["diff", "--name-only", "--diff-filter=U"]);
    if (!conflicts.ok || conflicts.stdout.trim()) throw new WorkspaceError("STATE_MISMATCH", "Git conflicts must be resolved before committing.");
  } catch (error) {
    unstageOwnedExpectedFiles(target.root, input.expectedFiles);
    throw error;
  }
  const result = disabledHooks((_env, hookConfig) => runGit(target.root, [
    ...hookConfig, "-c", "commit.gpgsign=false", "commit", "--no-gpg-sign", "-m", message,
  ]));
  if (!result.ok) {
    unstageOwnedExpectedFiles(target.root, input.expectedFiles);
    throw new WorkspaceError("INVALID_PATH", `Git commit failed; requested paths were unstaged and no commit was reported. ${result.stderr.trim().slice(0, 300)}`);
  }
  const commit = checkedGit(target.root, ["rev-parse", "--verify", "HEAD^{commit}"], "Unable to read the new commit.");
  const committedRaw = runGit(target.root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", commit]);
  if (!committedRaw.ok) throw new WorkspaceError("INVALID_PATH", "Unable to read the committed path set.");
  const committedPaths = committedRaw.stdout.split("\0").filter(Boolean).sort();
  if (committedPaths.length !== paths.length || committedPaths.join("\0") !== [...paths].sort().join("\0")) {
    throw new WorkspaceError("STATE_MISMATCH", "Committed path set does not match the explicitly authorized commit paths.");
  }
  return { parent, commit, branch: gitInfo(target.root).branch ?? "", committedPaths, expectedFiles: stagedFiles, expectedBranch: input.expectedBranch, observedBranch, expectedHead: input.expectedHead, observedHead, status: gitStatus(target) };
}

function readRemoteBranch(root: string, branch: string): { ok: boolean; sha: string | null } {
  const result = runGit(root, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
  if (!result.ok) return { ok: false, sha: null };
  const line = result.stdout.trim();
  if (!line) return { ok: true, sha: null };
  const match = line.match(/^([a-f0-9]{40,64})\s+refs\/heads\/([^\r\n]+)$/i);
  if (!match || match[2] !== branch) return { ok: false, sha: null };
  return { ok: true, sha: match[1].toLowerCase() };
}

/** Build the fixed push argument vector. Only validated server values reach this helper. */
export function exactLeasedFastForwardPushArgs(branch: string, remoteBranch: string, expectedRemoteSha: string | null): string[] {
  const expectation = expectedRemoteSha ?? ""; // Git defines an empty lease expectation as requiring an absent ref.
  return [
    "push",
    "--porcelain",
    `--force-with-lease=refs/heads/${remoteBranch}:${expectation}`,
    "--",
    "origin",
    `refs/heads/${branch}:refs/heads/${remoteBranch}`,
  ];
}

export function gitPush(workspace: Workspace, input: { branch: string; remoteBranch: string; expectedLocalSha: string; expectedRemoteSha: string | null; remote?: string; root?: string }): { remote: string; branch: string; remoteBranch: string; expectedLocalSha: string; expectedRemoteSha: string | null; pushedSha: string; remoteReadbackSha: string } {
  const target = workspace.rootFor(input.root ?? "workspace");
  if (input.remote !== undefined && input.remote !== "origin") throw new WorkspaceError("INVALID_PATH", "Push is restricted to the configured origin remote.");
  checkedGit(target.root, ["remote", "get-url", "origin"], "Configured origin remote is unavailable.");
  const branch = validateBranch(target.root, input.branch);
  const remoteBranch = validateBranch(target.root, input.remoteBranch);
  const pushedSha = resolveCommit(target.root, `refs/heads/${branch}`);
  if (!/^[a-f0-9]{40,64}$/i.test(input.expectedLocalSha) || pushedSha !== input.expectedLocalSha.toLowerCase()) {
    throw new WorkspaceError("STATE_MISMATCH", `Push local SHA precondition failed: expected ${input.expectedLocalSha}, observed ${pushedSha}.`);
  }
  if (input.expectedRemoteSha !== null && !/^[a-f0-9]{40,64}$/i.test(input.expectedRemoteSha)) {
    throw new WorkspaceError("INVALID_PATH", "expected_remote_sha must be a SHA-1/SHA-256 commit id or null.");
  }
  const expectedRemoteSha = input.expectedRemoteSha?.toLowerCase() ?? null;
  const observedRemote = readRemoteBranch(target.root, remoteBranch);
  if (!observedRemote.ok) throw new WorkspaceError("INVALID_PATH", "Unable to verify the live remote branch before push.");
  if (observedRemote.sha !== expectedRemoteSha) {
    throw new WorkspaceError("STATE_MISMATCH", `Push remote SHA precondition failed: expected ${expectedRemoteSha ?? "absent"}, observed ${observedRemote.sha ?? "absent"}.`);
  }
  if (expectedRemoteSha) {
    if (!runGit(target.root, ["cat-file", "-e", `${expectedRemoteSha}^{commit}`]).ok) throw new WorkspaceError("INVALID_PATH", "Expected remote head is not available locally for fast-forward verification.");
    const ancestry = runGit(target.root, ["merge-base", "--is-ancestor", expectedRemoteSha, pushedSha]);
    if (!ancestry.ok) throw new WorkspaceError("INVALID_PATH", "Push would not be a verified fast-forward.");
  }
  // This live compare-and-swap precondition is deliberately the last read before push.
  const liveRemote = readRemoteBranch(target.root, remoteBranch);
  if (!liveRemote.ok) throw new WorkspaceError("INVALID_PATH", "Unable to verify the live remote branch before push.");
  if (liveRemote.sha !== expectedRemoteSha) {
    throw new WorkspaceError("STATE_MISMATCH", `Push remote SHA precondition failed: expected ${expectedRemoteSha ?? "absent"}, observed ${liveRemote.sha ?? "absent"}.`);
  }
  // Git enforces this exact compare-and-swap lease at receive/update time.
  // The ancestry check above remains mandatory, so this is only an atomic
  // expected-ref guard for a fast-forward push, never history-rewrite authority.
  const pushResult = disabledHooks((_env, hookConfig) => runGit(target.root, [
    ...hookConfig, ...exactLeasedFastForwardPushArgs(branch, remoteBranch, expectedRemoteSha),
  ]));
  if (!pushResult.ok) throw new WorkspaceError("STATE_MISMATCH", "Exact leased fast-forward push failed; the remote ref may have changed or the update was rejected.");
  const readback = runGit(target.root, ["ls-remote", "--heads", "origin", `refs/heads/${remoteBranch}`]);
  if (!readback.ok) throw new WorkspaceError("INVALID_PATH", "Push completed but remote readback failed.");
  const remoteReadbackSha = readback.stdout.trim().split(/\s+/)[0] ?? "";
  if (remoteReadbackSha !== pushedSha) throw new WorkspaceError("INVALID_PATH", "Remote readback does not match the pushed commit.");
  return { remote: "origin", branch, remoteBranch, expectedLocalSha: input.expectedLocalSha.toLowerCase(), expectedRemoteSha, pushedSha, remoteReadbackSha };
}

export function gitMergeFfOnly(workspace: Workspace, input: { source: string; expectedBranch: string; expectedHead: string; root?: string }): { before: string; after: string; branch: string; changedPaths: string[]; expectedBranch: string; observedBranch: string; expectedHead: string; observedHead: string; status: ReturnType<typeof gitStatus> } {
  const target = workspace.rootFor(input.root ?? "workspace");
  const branch = gitInfo(target.root).branch ?? "";
  const before = checkedGit(target.root, ["rev-parse", "--verify", "HEAD^{commit}"], "Current HEAD is not a commit.");
  if (branch !== input.expectedBranch) throw new WorkspaceError("STATE_MISMATCH", `Merge branch precondition failed: expected '${input.expectedBranch}', observed '${branch}'.`);
  if (before !== input.expectedHead) throw new WorkspaceError("STATE_MISMATCH", `Merge HEAD precondition failed: expected ${input.expectedHead}, observed ${before}.`);
  const status = runGit(target.root, ["status", "--porcelain=v2", "--untracked-files=all"]);
  if (!status.ok || status.stdout.trim()) throw new WorkspaceError("INVALID_PATH", "Fast-forward merge requires a completely clean target worktree.");
  validateBranch(target.root, branch);
  const source = resolveCommit(target.root, input.source);
  const ancestor = runGit(target.root, ["merge-base", "--is-ancestor", before, source]);
  if (!ancestor.ok) throw new WorkspaceError("INVALID_PATH", "Source is not a fast-forward of the target branch.");
  disabledHooks((_env, hookConfig) => {
    const result = runGit(target.root, [...hookConfig, "merge", "--ff-only", "--no-edit", source]);
    if (!result.ok) throw new WorkspaceError("INVALID_PATH", "Fast-forward merge failed without conflict resolution.");
  });
  const after = checkedGit(target.root, ["rev-parse", "--verify", "HEAD^{commit}"], "Unable to read merged HEAD.");
  const changed = runGit(target.root, ["diff", "--name-only", "-z", before, after]);
  if (!changed.ok) throw new WorkspaceError("INVALID_PATH", "Unable to read merged path list.");
  return { before, after, branch, changedPaths: changed.stdout.split("\0").filter(Boolean), expectedBranch: input.expectedBranch, observedBranch: branch, expectedHead: input.expectedHead, observedHead: before, status: gitStatus(target) };
}

export interface GitRemoteRef { branch: string; ref: string; sha: string | null }

export function gitRemoteRefs(workspace: Workspace, input: { branches: string[]; remote?: string; root?: string }): { remote: "origin"; refs: GitRemoteRef[] } {
  const target = workspace.rootFor(input.root ?? "workspace");
  if (input.remote !== undefined && input.remote !== "origin") throw new WorkspaceError("INVALID_PATH", "Live remote reads are restricted to origin.");
  checkedGit(target.root, ["remote", "get-url", "origin"], "Configured origin remote is unavailable.");
  if (!Array.isArray(input.branches) || input.branches.length < 1 || input.branches.length > 50) throw new WorkspaceError("INVALID_PATH", "branches must contain 1-50 branch names.");
  const branches = input.branches.map((branch) => validateBranch(target.root, branch));
  if (new Set(branches).size !== branches.length) throw new WorkspaceError("INVALID_PATH", "branches must be unique.");
  const refs = branches.map((branch) => ({ branch, ref: `refs/heads/${branch}` }));
  const result = runGit(target.root, ["ls-remote", "--heads", "origin", ...refs.map((item) => item.ref)]);
  if (!result.ok) throw new WorkspaceError("INVALID_PATH", "Unable to read live origin branch refs.");
  const live = new Map<string, string>();
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^([a-f0-9]{40,64})\s+refs\/heads\/([^\r\n]+)$/i);
    if (!match || !branches.includes(match[2])) throw new WorkspaceError("INVALID_PATH", "Remote returned an unexpected branch ref.");
    live.set(match[2], match[1].toLowerCase());
  }
  return { remote: "origin", refs: refs.map((item) => ({ ...item, sha: live.get(item.branch) ?? null })) };
}

export function gitMergeBase(workspace: Workspace, input: { left: string; right: string; root?: string }): { left: string; right: string; mergeBase: string | null; leftIsAncestor: boolean; rightIsAncestor: boolean } {
  const target = workspace.rootFor(input.root ?? "workspace");
  const left = resolveCommit(target.root, input.left);
  const right = resolveCommit(target.root, input.right);
  const result = runGit(target.root, ["merge-base", left, right]);
  const leftAnc = runGit(target.root, ["merge-base", "--is-ancestor", left, right]);
  const rightAnc = runGit(target.root, ["merge-base", "--is-ancestor", right, left]);
  if ((!result.ok && result.code !== 1) || (!leftAnc.ok && leftAnc.code !== 1) || (!rightAnc.ok && rightAnc.code !== 1)) {
    throw new WorkspaceError("INVALID_PATH", "Unable to compute merge-base/ancestry.");
  }
  return { left, right, mergeBase: result.ok ? result.stdout.trim() : null, leftIsAncestor: leftAnc.ok, rightIsAncestor: rightAnc.ok };
}

export function gitTreePaths(workspace: Workspace, ref: string, rootAlias = "workspace"): string[] {
  const target = workspace.rootFor(rootAlias);
  const commit = resolveCommit(target.root, ref);
  const result = runGit(target.root, ["ls-tree", "-r", "--name-only", "-z", commit]);
  if (!result.ok) throw new WorkspaceError("INVALID_PATH", "Unable to read commit tree.");
  return result.stdout.split("\0").filter(Boolean).filter((p) => !target.ignoreRules.isSensitive(p));
}
