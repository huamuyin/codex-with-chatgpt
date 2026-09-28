import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { ensureDir, getStateDir } from "../config/paths.js";
import { redact } from "../logger/index.js";
import { sanitizeExecutionOutput, MAX_OUTPUT_BYTES } from "./sanitize.js";
import { sanitizeExecutionImage, executionImageMetadata, MAX_EXECUTION_IMAGE_BYTES, MAX_EXECUTION_IMAGE_DIMENSION, type ExecutionImageMetadata } from "./image.js";

export const MAX_OUTPUT_RECORDS = 40;
export const OUTPUT_STORE_LOCK_TIMEOUT_MS = 3_000;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const lockWait = new Int32Array(new SharedArrayBuffer(4));

export type ExecutionOutputStoreErrorCode = "OUTPUT_STORE_BUSY" | "OUTPUT_STORE_CORRUPT" | "OUTPUT_BODY_MISSING" | "OUTPUT_BODY_CORRUPT" | "OUTPUT_IMAGE_MISSING" | "OUTPUT_IMAGE_CORRUPT";
export class ExecutionOutputStoreError extends Error {
  constructor(public readonly code: ExecutionOutputStoreErrorCode, message: string) {
    super(message);
    this.name = "ExecutionOutputStoreError";
  }
}

export interface ExecutionOutputMeta {
  id: number;
  command: string;
  exitCode: number | null;
  timestamp: string;
  taskId?: string;
  iteration?: number;
  allowed: boolean;
  restrictedReason?: string;
  truncated: boolean;
  sizeBytes: number;
  /** Optional only for backwards compatibility with pre-integrity records. */
  bodySha256?: string;
  image?: ExecutionImageMetadata;
}

interface OutputIndex { nextId: number; items: ExecutionOutputMeta[] }
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const imageSchema = z.object({
  mimeType: z.enum(["image/png", "image/jpeg"]),
  width: z.number().int().min(1).max(MAX_EXECUTION_IMAGE_DIMENSION),
  height: z.number().int().min(1).max(MAX_EXECUTION_IMAGE_DIMENSION),
  sha256: sha256Schema,
  sizeBytes: z.number().int().min(1).max(MAX_EXECUTION_IMAGE_BYTES),
}).strict();
const metaSchema = z.object({
  id: z.number().int().positive().safe(), command: z.string(), exitCode: z.number().int().nullable(),
  timestamp: z.string(), taskId: z.string().optional(), iteration: z.number().int().nonnegative().optional(),
  allowed: z.boolean(), restrictedReason: z.string().optional(), truncated: z.boolean(),
  // The sanitizer appends a short truncation marker after applying its byte cap.
  sizeBytes: z.number().int().min(0).max(MAX_OUTPUT_BYTES + 64),
  bodySha256: sha256Schema.optional(), image: imageSchema.optional(),
}).strict();
const indexSchema = z.object({ nextId: z.number().int().positive().safe(), items: z.array(metaSchema).max(MAX_OUTPUT_RECORDS) }).strict();

function corruptIndex(): never {
  throw new ExecutionOutputStoreError("OUTPUT_STORE_CORRUPT", "Execution output index is invalid; existing evidence was preserved.");
}
function outputDir(workspaceId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(workspaceId)) corruptIndex();
  return ensureDir(path.join(getStateDir(), "execution-outputs", workspaceId));
}
function bodyFile(dir: string, id: number): string { return path.join(dir, "bodies", String(id) + ".txt"); }
function imageFile(dir: string, meta: ExecutionOutputMeta): string {
  return path.join(dir, "images", String(meta.id) + (meta.image?.mimeType === "image/jpeg" ? ".jpg" : ".png"));
}

/** Serialize writers AND readers, including pruning, across separate CLI/bridge processes. */
function transaction<T>(workspaceId: string, action: (dir: string) => T): T {
  const dir = outputDir(workspaceId);
  const lock = path.join(dir, ".transaction-lock");
  const deadline = performance.now() + OUTPUT_STORE_LOCK_TIMEOUT_MS;
  for (;;) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new ExecutionOutputStoreError("OUTPUT_STORE_BUSY", "Execution output store lock could not be acquired.");
      }
      if (performance.now() >= deadline) {
        // Never break another process's lock based on age/PID guesses. A crashed
        // publisher fails closed until an operator confirms lock recovery is safe.
        throw new ExecutionOutputStoreError("OUTPUT_STORE_BUSY", "Execution output store is locked; no evidence was changed.");
      }
      Atomics.wait(lockWait, 0, 0, 10);
    }
  }
  try { return action(dir); }
  finally { fs.rmdirSync(lock); }
}

function validateIndex(value: unknown): OutputIndex {
  const result = indexSchema.safeParse(value);
  if (!result.success) corruptIndex();
  const index = result.data;
  let previous = 0;
  for (const item of index.items) {
    if (item.id <= previous || item.id >= index.nextId || (!item.allowed && (item.sizeBytes !== 0 || item.image !== undefined))) corruptIndex();
    previous = item.id;
  }
  return index;
}

/** Read a bounded regular file without following links or exposing filesystem errors. */
function readBytes(file: string, maxBytes: number): Buffer {
  let fd: number | undefined;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw new Error("invalid file");
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size || !opened.isFile()) throw new Error("changed file");
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    for (;;) {
      const read = fs.readSync(fd, bytes, count, bytes.length - count, null);
      count += read;
      if (read === 0 || count === bytes.length) break;
    }
    const after = fs.fstatSync(fd);
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("changed file");
    return bytes.subarray(0, count);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function readIndex(dir: string): OutputIndex {
  try { return validateIndex(JSON.parse(readBytes(path.join(dir, "index.json"), MAX_INDEX_BYTES).toString("utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { nextId: 1, items: [] };
    return corruptIndex();
  }
}

function writeNewFile(file: string, bytes: string | Buffer): void {
  ensureDir(path.dirname(file));
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function publishIndex(dir: string, index: OutputIndex): void {
  const bytes = JSON.stringify(validateIndex(index), null, 2);
  if (Buffer.byteLength(bytes, "utf8") > MAX_INDEX_BYTES) corruptIndex();
  const temp = path.join(dir, ".index-" + randomUUID() + ".tmp");
  try {
    writeNewFile(temp, bytes);
    // Same-directory rename publishes a complete old/new index, never truncated JSON.
    fs.renameSync(temp, path.join(dir, "index.json"));
  } finally { fs.rmSync(temp, { force: true }); }
}

export interface SaveOutputInput {
  command: string;
  raw: string;
  exitCode?: number | null;
  taskId?: string;
  iteration?: number;
  /** Local publisher authorization only; never exposed as an MCP path parameter. */
  image?: { artifactRoot: string; file: string };
}

export function saveExecutionOutput(workspaceId: string, input: SaveOutputInput): ExecutionOutputMeta {
  const sanitized = sanitizeExecutionOutput(input.raw);
  const image = input.image && sanitized.allowed ? sanitizeExecutionImage(input.image) : undefined;
  return transaction(workspaceId, (dir) => {
    const index = readIndex(dir);
    const id = index.nextId;
    if (id >= Number.MAX_SAFE_INTEGER) corruptIndex();
    const text = sanitized.allowed ? sanitized.text : "";
    const meta: ExecutionOutputMeta = {
      id, command: redact(input.command).slice(0, 200), exitCode: input.exitCode ?? null,
      timestamp: new Date().toISOString(), taskId: input.taskId, iteration: input.iteration,
      allowed: sanitized.allowed, restrictedReason: sanitized.allowed ? undefined : sanitized.reason,
      truncated: sanitized.allowed ? sanitized.truncated : false, sizeBytes: Buffer.byteLength(text, "utf8"),
      bodySha256: sanitized.allowed ? createHash("sha256").update(text, "utf8").digest("hex") : undefined,
      image: image ? executionImageMetadata(image) : undefined,
    };
    const dropped = index.items.length === MAX_OUTPUT_RECORDS ? index.items.slice(0, 1) : [];
    const next = validateIndex({ nextId: id + 1, items: [...index.items.slice(dropped.length), meta] });
    const created: string[] = [];
    let published = false;
    try {
      if (meta.allowed) {
        const file = bodyFile(dir, id);
        writeNewFile(file, text);
        created.push(file);
      }
      if (image) {
        const file = imageFile(dir, meta);
        writeNewFile(file, image.bytes);
        created.push(file);
      }
      publishIndex(dir, next);
      published = true;
    } catch {
      throw new ExecutionOutputStoreError("OUTPUT_STORE_CORRUPT", "Execution output publication failed; no partial record was published.");
    } finally {
      if (!published) for (const file of created) fs.rmSync(file, { force: true });
    }
    // Readers hold the same lock, so they cannot observe an indexed body being
    // pruned. Prune only after publishing the new index. A cleanup failure may
    // retain an unreachable blob but cannot undo a successful publication.
    for (const old of dropped) {
      for (const file of [bodyFile(dir, old.id), ...(old.image ? [imageFile(dir, old)] : [])]) {
        try { fs.rmSync(file, { force: true }); } catch { /* preserve unreachable blob */ }
      }
    }
    return meta;
  });
}

export function listExecutionOutputs(workspaceId: string, limit = 20): ExecutionOutputMeta[] {
  return transaction(workspaceId, (dir) => readIndex(dir).items.slice(-Math.max(1, Math.min(50, limit))));
}

function verifiedBody(file: string, sizeBytes: number, sha256: string | undefined, image = false): Buffer {
  const kind = image ? "IMAGE" : "BODY";
  let bytes: Buffer;
  try { bytes = readBytes(file, image ? MAX_EXECUTION_IMAGE_BYTES : MAX_OUTPUT_BYTES + 64); }
  catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    const code = ("OUTPUT_" + kind + (missing ? "_MISSING" : "_CORRUPT")) as ExecutionOutputStoreErrorCode;
    throw new ExecutionOutputStoreError(code, "Recorded output " + (image ? "image" : "body") + (missing ? " is missing." : " is unreadable or invalid."));
  }
  if (bytes.length !== sizeBytes || sha256 !== undefined && createHash("sha256").update(bytes).digest("hex") !== sha256) {
    throw new ExecutionOutputStoreError(image ? "OUTPUT_IMAGE_CORRUPT" : "OUTPUT_BODY_CORRUPT", "Recorded output content failed its identity check.");
  }
  return bytes;
}

export function readExecutionOutput(workspaceId: string, id: number):
  | { ok: true; meta: ExecutionOutputMeta; text: string; image?: { bytes: Buffer; mimeType: "image/png" | "image/jpeg" } }
  | { ok: false; error: "NOT_FOUND" | "OUTPUT_RESTRICTED" } {
  return transaction(workspaceId, (dir) => {
    const meta = readIndex(dir).items.find((item) => item.id === id);
    if (!meta) return { ok: false, error: "NOT_FOUND" };
    if (!meta.allowed) return { ok: false, error: "OUTPUT_RESTRICTED" };
    // Legacy empty outputs had no body file. New outputs always store a digest
    // and a body, including an empty one, so disappearance remains detectable.
    const text = meta.sizeBytes === 0 && meta.bodySha256 === undefined ? "" : verifiedBody(bodyFile(dir, id), meta.sizeBytes, meta.bodySha256).toString("utf8");
    const image = meta.image ? { bytes: verifiedBody(imageFile(dir, meta), meta.image.sizeBytes, meta.image.sha256, true), mimeType: meta.image.mimeType } : undefined;
    return { ok: true, meta, text, ...(image ? { image } : {}) };
  });
}
