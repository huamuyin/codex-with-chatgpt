import fs from "node:fs";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { Workspace, WorkspaceError } from "./manager.js";
import { gitDiff } from "./git.js";

const MAX_TEXT_BYTES = 1024 * 1024;

export interface FileMutationResult {
  path: string;
  root: string;
  action: "created" | "modified";
  byteCount: number;
  previous_sha256: string | null;
  sha256: string;
  diff: string | null;
}

function textBytes(text: string): Buffer {
  if (text.includes("\0")) throw new WorkspaceError("BINARY_FILE", "NUL characters are not allowed in text files.");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > MAX_TEXT_BYTES) throw new WorkspaceError("FILE_TOO_LARGE", `Text content exceeds ${MAX_TEXT_BYTES} bytes.`);
  return bytes;
}

function checkTarget(root: Workspace, rel: string, abs: string): { existed: boolean; original?: Buffer } {
  const parent = path.dirname(abs);
  let realParent: string;
  try {
    realParent = fs.realpathSync.native(parent);
  } catch {
    throw new WorkspaceError("FILE_NOT_FOUND", `Parent directory does not exist: ${path.dirname(rel) || "."}`);
  }
  if (!isContained(process.platform === "win32" ? root.root.toLowerCase() : root.root, process.platform === "win32" ? realParent.toLowerCase() : realParent)) {
    throw new WorkspaceError("PATH_OUTSIDE_WORKSPACE", "Parent directory resolves outside the authorized root.");
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(abs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { existed: false };
    throw error;
  }
  if (stat.isSymbolicLink()) throw new WorkspaceError("SYMLINK_NOT_ALLOWED", "Symlink and junction targets cannot be modified.");
  if (!stat.isFile()) throw new WorkspaceError("NOT_A_FILE", `Target is not a regular file: ${rel}`);
  if (stat.size > MAX_TEXT_BYTES) throw new WorkspaceError("FILE_TOO_LARGE", `Target exceeds ${MAX_TEXT_BYTES} bytes: ${rel}`);
  const original = fs.readFileSync(abs);
  if (original.includes(0)) throw new WorkspaceError("BINARY_FILE", `Binary file cannot be modified: ${rel}`);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(original);
  } catch {
    throw new WorkspaceError("BINARY_FILE", `Target is not valid UTF-8 text: ${rel}`);
  }
  return { existed: true, original };
}

function assertUnchangedSnapshot(
  expected: { existed: boolean; original?: Buffer },
  current: { existed: boolean; original?: Buffer },
  rel: string,
): void {
  if (expected.existed !== current.existed || (expected.existed && (!expected.original || !current.original || !expected.original.equals(current.original)))) {
    throw new WorkspaceError("CONCURRENT_MODIFICATION", `Target changed after validation: ${rel}`);
  }
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function atomicWrite(abs: string, bytes: Buffer): void {
  const parent = path.dirname(abs);
  const temp = path.join(parent, `.c2c-write-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, abs);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { /* no temporary file remains */ }
  }
}

function atomicCreate(abs: string, bytes: Buffer): void {
  const parent = path.dirname(abs);
  const temp = path.join(parent, `.c2c-create-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // A same-volume hard link is exclusive: it cannot replace a file created
    // after the absence check, unlike rename on platforms that replace targets.
    fs.linkSync(temp, abs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new WorkspaceError("STATE_MISMATCH", "Creation precondition failed because the target appeared during the write.");
    }
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { /* no temporary file remains */ }
  }
}

function gitEvidence(root: Workspace, rel: string): string | null {
  const result = gitDiff(root, { mode: "head", maxBytes: 64 * 1024 }, rel);
  return result.isRepo && result.diff ? result.diff : null;
}

export function writeWorkspaceFile(
  workspace: Workspace,
  input: { path: string; content: string; expected_sha256?: string; root?: string }
): FileMutationResult {
  const target = workspace.resolveMutationPath(input.path, input.root ?? "workspace");
  const checked = checkTarget(target.workspace, target.rel, target.abs);
  const previousSha256 = checked.original ? createHash("sha256").update(checked.original).digest("hex") : null;
  if (checked.existed && !input.expected_sha256) {
    throw new WorkspaceError("PRECONDITION_REQUIRED", "expected_sha256 is required when replacing an existing file.");
  }
  if (!checked.existed && input.expected_sha256 !== undefined) {
    throw new WorkspaceError("STATE_MISMATCH", "expected_sha256 must be omitted when creating a new file.");
  }
  if (input.expected_sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(input.expected_sha256)) {
    throw new WorkspaceError("INVALID_PATH", "expected_sha256 must be a 64-character SHA-256 hex digest.");
  }
  if (checked.existed && input.expected_sha256?.toLowerCase() !== previousSha256) {
    throw new WorkspaceError("STATE_MISMATCH", `File SHA-256 precondition failed for '${target.rel}'.`);
  }
  const bytes = textBytes(input.content);
  // Re-resolve immediately before replacement to detect a changed parent/link.
  const fresh = workspace.resolveMutationPath(input.path, input.root ?? "workspace");
  if (fresh.abs !== target.abs) throw new WorkspaceError("PATH_OUTSIDE_WORKSPACE", "Mutation target changed during validation.");
  const current = checkTarget(fresh.workspace, fresh.rel, fresh.abs);
  assertUnchangedSnapshot(checked, current, fresh.rel);
  if (!checked.existed && current.existed) {
    throw new WorkspaceError("STATE_MISMATCH", `Creation precondition failed because '${target.rel}' appeared during validation.`);
  }
  if (checked.existed) atomicWrite(target.abs, bytes);
  else atomicCreate(target.abs, bytes);
  return {
    path: target.rel,
    root: target.rootAlias,
    action: checked.existed ? "modified" : "created",
    byteCount: bytes.length,
    previous_sha256: previousSha256,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    diff: gitEvidence(target.workspace, target.rel),
  };
}

interface HunkLine { kind: "context" | "add" | "remove"; text: string }
interface PatchHunk { oldStart: number; lines: HunkLine[] }
interface PatchBlock { path: string; newFile: boolean; hunks: PatchHunk[] }

function stripHeaderPath(value: string, expectedPrefix: "a/" | "b/"): string | null {
  const raw = value.split("\t", 1)[0].trim();
  if (raw === "/dev/null") return null;
  if (!raw.startsWith(expectedPrefix)) throw new WorkspaceError("INVALID_PATH", "Patch paths must use standard a/ and b/ relative headers.");
  return raw.slice(2);
}

function parseUnifiedPatch(patch: string): PatchBlock[] {
  if (typeof patch !== "string" || Buffer.byteLength(patch, "utf8") > MAX_TEXT_BYTES || patch.includes("\0")) {
    throw new WorkspaceError("INVALID_PATH", "Patch must be UTF-8 text no larger than 1 MiB.");
  }
  if (/^(?:GIT binary patch|Binary files |new file mode |deleted file mode |rename from |rename to |copy from |copy to )/m.test(patch)) {
    throw new WorkspaceError("BINARY_FILE", "Binary, delete, rename, copy, and mode-change patches are not supported.");
  }
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const blocks: PatchBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith("--- ")) {
      if (lines[i] === "" || lines[i].startsWith("diff --git ") || lines[i].startsWith("index ")) { i++; continue; }
      throw new WorkspaceError("INVALID_PATH", `Unsupported patch header at line ${i + 1}.`);
    }
    const oldPath = stripHeaderPath(lines[i++].slice(4), "a/");
    if (i >= lines.length || !lines[i].startsWith("+++ ")) throw new WorkspaceError("INVALID_PATH", "Patch is missing its +++ header.");
    const newPath = stripHeaderPath(lines[i++].slice(4), "b/");
    if (newPath === null) throw new WorkspaceError("INVALID_PATH", "File deletion is not exposed by apply_patch.");
    if (oldPath !== null && oldPath !== newPath) throw new WorkspaceError("INVALID_PATH", "Renames are not supported; old and new paths must match.");
    const hunks: PatchHunk[] = [];
    while (i < lines.length && !/^--- (?:a\/|\/dev\/null)/.test(lines[i])) {
      const header = lines[i];
      if (header === "" && i === lines.length - 1) { i++; break; }
      if (!header.startsWith("@@ ")) {
        if (header.startsWith("diff --git ") || header.startsWith("index ")) { i++; continue; }
        throw new WorkspaceError("INVALID_PATH", `Unsupported patch content at line ${i + 1}.`);
      }
      const match = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/);
      if (!match) throw new WorkspaceError("INVALID_PATH", `Invalid unified hunk header at line ${i + 1}.`);
      const expectedOld = Number(match[2] ?? 1);
      const expectedNew = Number(match[4] ?? 1);
      i++;
      const hunk: HunkLine[] = [];
      let oldCount = 0;
      let newCount = 0;
      while (i < lines.length && !lines[i].startsWith("@@ ") && !/^--- (?:a\/|\/dev\/null)/.test(lines[i])) {
        const line = lines[i];
        if (line.startsWith("\\ No newline")) throw new WorkspaceError("INVALID_PATH", "No-newline patch markers are not supported.");
        const prefix = line[0];
        if (prefix === " ") { hunk.push({ kind: "context", text: line.slice(1) }); oldCount++; newCount++; }
        else if (prefix === "+") { hunk.push({ kind: "add", text: line.slice(1) }); newCount++; }
        else if (prefix === "-") { hunk.push({ kind: "remove", text: line.slice(1) }); oldCount++; }
        else if (line === "" && i === lines.length - 1) { i++; break; }
        else throw new WorkspaceError("INVALID_PATH", `Invalid unified patch line at ${i + 1}.`);
        i++;
      }
      if (oldCount !== expectedOld || newCount !== expectedNew) throw new WorkspaceError("INVALID_PATH", "Hunk line counts do not match the patch header.");
      hunks.push({ oldStart: Number(match[1]), lines: hunk });
    }
    if (hunks.length === 0) throw new WorkspaceError("INVALID_PATH", "Each patch file must contain at least one hunk.");
    blocks.push({ path: newPath, newFile: oldPath === null, hunks });
  }
  if (blocks.length === 0) throw new WorkspaceError("INVALID_PATH", "Patch contains no file changes.");
  const unique = new Set(blocks.map((block) => block.path.toLowerCase()));
  if (unique.size !== blocks.length) throw new WorkspaceError("INVALID_PATH", "Patch must not target the same path more than once.");
  return blocks;
}

function applyHunks(original: string[], hunks: PatchHunk[]): string[] {
  const output: string[] = [];
  let source = 0;
  for (let h = 0; h < hunks.length; h++) {
    const start = hunks[h].oldStart === 0 ? 0 : hunks[h].oldStart - 1;
    if (start < source || start > original.length) throw new WorkspaceError("INVALID_PATH", "Patch hunk position is outside the target file.");
    output.push(...original.slice(source, start));
    source = start;
    for (const line of hunks[h].lines) {
      if (line.kind === "add") { output.push(line.text); continue; }
      if (original[source] !== line.text) throw new WorkspaceError("INVALID_PATH", "Patch context does not match the target file; no changes were written.");
      if (line.kind === "context") output.push(line.text);
      source++;
    }
  }
  output.push(...original.slice(source));
  return output;
}

export interface ApplyPatchResult {
  root: string;
  changedFiles: { path: string; action: "created" | "modified"; byteCount: number; sha256: string }[];
  diff: string | null;
}

export interface ExpectedPatchFileIdentity { path: string; sha256: string | null }

export function applyWorkspacePatch(
  workspace: Workspace,
  input: { patch: string; expectedFiles: ExpectedPatchFileIdentity[]; root?: string }
): ApplyPatchResult {
  const blocks = parseUnifiedPatch(input.patch);
  if (!Array.isArray(input.expectedFiles) || input.expectedFiles.length !== blocks.length) {
    throw new WorkspaceError("INVALID_PATH", "expected_files must identify every and only patch target.");
  }
  const expectedByPath = new Map<string, string | null>();
  for (const expected of input.expectedFiles) {
    if (expected.sha256 !== null && !/^[a-f0-9]{64}$/i.test(expected.sha256)) {
      throw new WorkspaceError("INVALID_PATH", "Patch preimage identities require a SHA-256 digest or null for an absent file.");
    }
    const resolved = workspace.resolveMutationPath(expected.path, input.root ?? "workspace");
    if (expectedByPath.has(resolved.rel)) throw new WorkspaceError("INVALID_PATH", "expected_files paths must be unique.");
    expectedByPath.set(resolved.rel, expected.sha256?.toLowerCase() ?? null);
  }
  const targetPaths = blocks.map((block) => workspace.resolveMutationPath(block.path, input.root ?? "workspace").rel);
  if (new Set(targetPaths).size !== targetPaths.length || [...expectedByPath.keys()].sort().join("\0") !== [...targetPaths].sort().join("\0")) {
    throw new WorkspaceError("INVALID_PATH", "expected_files path set must exactly equal parsed patch targets.");
  }
  const prepared: { path: string; abs: string; original: Buffer | null; next: Buffer; action: "created" | "modified" }[] = [];
  for (const block of blocks) {
    const target = workspace.resolveMutationPath(block.path, input.root ?? "workspace");
    const checked = checkTarget(target.workspace, target.rel, target.abs);
    const expectedSha = expectedByPath.get(target.rel);
    if (block.newFile && checked.existed) throw new WorkspaceError("INVALID_PATH", `New-file patch target already exists: ${target.rel}`);
    if (!block.newFile && !checked.existed) throw new WorkspaceError("FILE_NOT_FOUND", `Patch target does not exist: ${target.rel}`);
    if (block.newFile !== (expectedSha === null)) throw new WorkspaceError("STATE_MISMATCH", `Patch preimage existence precondition failed for '${target.rel}'.`);
    const observedSha = checked.original ? createHash("sha256").update(checked.original).digest("hex") : null;
    if (observedSha !== expectedSha) throw new WorkspaceError("STATE_MISMATCH", `Patch preimage SHA-256 precondition failed for '${target.rel}'.`);
    const priorText = checked.original ? new TextDecoder("utf-8", { fatal: true }).decode(checked.original) : "";
    const crlf = priorText.includes("\r\n");
    const trailingNewline = block.newFile ? true : /(?:\r?\n)$/.test(priorText);
    const sourceLines = priorText.replace(/\r\n/g, "\n").split("\n");
    if (trailingNewline) sourceLines.pop();
    if (sourceLines.length === 1 && sourceLines[0] === "" && !priorText) sourceLines.length = 0;
    const outputLines = applyHunks(sourceLines, block.hunks);
    const nextText = outputLines.join(crlf ? "\r\n" : "\n") + (trailingNewline ? (crlf ? "\r\n" : "\n") : "");
    const next = textBytes(nextText);
    prepared.push({ path: target.rel, abs: target.abs, original: checked.original ?? null, next, action: checked.existed ? "modified" : "created" });
  }

  // Check the entire target set together immediately before the first write.
  // A stale file outside the edited hunks therefore cannot produce a partial write.
  for (const item of prepared) {
    const current = workspace.resolveMutationPath(item.path, input.root ?? "workspace");
    if (current.abs !== item.abs) throw new WorkspaceError("PATH_OUTSIDE_WORKSPACE", "Patch target changed during validation.");
    const latest = checkTarget(current.workspace, current.rel, current.abs);
    const expected = { existed: item.original !== null, original: item.original ?? undefined };
    assertUnchangedSnapshot(expected, latest, current.rel);
  }

  const written: typeof prepared = [];
  try {
    for (const item of prepared) {
      // Repeat the central path check immediately before each atomic replacement.
      const current = workspace.resolveMutationPath(item.path, input.root ?? "workspace");
      if (current.abs !== item.abs) throw new WorkspaceError("PATH_OUTSIDE_WORKSPACE", "Patch target changed during validation.");
      const latest = checkTarget(current.workspace, current.rel, current.abs);
      const expected = { existed: item.original !== null, original: item.original ?? undefined };
      assertUnchangedSnapshot(expected, latest, current.rel);
      if (item.original) atomicWrite(item.abs, item.next);
      else atomicCreate(item.abs, item.next);
      written.push(item);
    }
  } catch (error) {
    // Best-effort internal rollback only; no delete operation is exposed to MCP.
    for (const item of written.reverse()) {
      try {
        const current = fs.readFileSync(item.abs);
        if (!current.equals(item.next)) continue;
        if (item.original) atomicWrite(item.abs, item.original);
        else fs.unlinkSync(item.abs);
      } catch { /* surface the original failure; callers still receive an error */ }
    }
    throw error;
  }

  const changedFiles = prepared.map((item) => ({
    path: item.path,
    action: item.action,
    byteCount: item.next.length,
    sha256: createHash("sha256").update(item.next).digest("hex"),
  }));
  const root = input.root ?? "workspace";
  const diffs = changedFiles.map((item) => gitEvidence(workspace.rootFor(root), item.path)).filter(Boolean).join("\n");
  return { root, changedFiles, diff: diffs || null };
}
