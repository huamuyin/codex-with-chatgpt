import fs from "node:fs";
import path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionOutputStoreError, listExecutionOutputs, MAX_OUTPUT_RECORDS, readExecutionOutput, saveExecutionOutput } from "../src/execution/output.js";
import { cleanup, isolateStateDir } from "./helpers.js";

let state: string;
const priorState = process.env.C2C_STATE_DIR;
beforeEach(() => { state = isolateStateDir(); });
afterEach(() => {
  vi.restoreAllMocks();
  cleanup(state);
  if (priorState === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = priorState;
});
const dir = (workspace = "ws1") => path.join(state, "execution-outputs", workspace);
const save = (raw = "safe") => saveExecutionOutput("ws1", { command: raw, raw, exitCode: 0 });
function code(action: () => unknown): string {
  try { action(); return "NO_ERROR"; }
  catch (error) { expect(error).toBeInstanceOf(ExecutionOutputStoreError); return (error as ExecutionOutputStoreError).code; }
}
function image(): { artifactRoot: string; file: string } {
  const file = path.join(state, "synthetic.png");
  fs.writeFileSync(file, PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 255) }));
  return { artifactRoot: state, file };
}

describe("execution output transaction and integrity", () => {
  it.each(["{", "null", '{"nextId":1,"items":{}}', '{"nextId":1,"items":[{"id":1}]}'])("preserves invalid index and rejects read/write: %s", (raw) => {
    save();
    const file = path.join(dir(), "index.json");
    fs.writeFileSync(file, raw);
    expect(code(() => listExecutionOutputs("ws1"))).toBe("OUTPUT_STORE_CORRUPT");
    expect(code(() => readExecutionOutput("ws1", 1))).toBe("OUTPUT_STORE_CORRUPT");
    expect(code(() => save("next"))).toBe("OUTPUT_STORE_CORRUPT");
    expect(fs.readFileSync(file, "utf8")).toBe(raw);
    expect(fs.readdirSync(path.join(dir(), "bodies"))).toEqual(["1.txt"]);
  });

  it("rejects duplicate/non-monotonic IDs and never reuses them", () => {
    save();
    const file = path.join(dir(), "index.json");
    const index = JSON.parse(fs.readFileSync(file, "utf8"));
    index.items.push(index.items[0]);
    fs.writeFileSync(file, JSON.stringify(index));
    expect(code(() => save())).toBe("OUTPUT_STORE_CORRUPT");
  });

  it("detects missing and same-length modified bodies", () => {
    const first = save("aaaa");
    const file = path.join(dir(), "bodies", `${first.id}.txt`);
    fs.writeFileSync(file, "bbbb");
    expect(code(() => readExecutionOutput("ws1", first.id))).toBe("OUTPUT_BODY_CORRUPT");
    fs.unlinkSync(file);
    expect(code(() => readExecutionOutput("ws1", first.id))).toBe("OUTPUT_BODY_MISSING");
  });

  it("supports legacy valid records and legacy empty bodies without hiding a new missing empty body", () => {
    const first = save("legacy");
    const second = save("");
    const file = path.join(dir(), "index.json");
    const index = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const item of index.items) delete item.bodySha256;
    fs.writeFileSync(file, JSON.stringify(index));
    fs.unlinkSync(path.join(dir(), "bodies", `${second.id}.txt`));
    expect(readExecutionOutput("ws1", first.id)).toMatchObject({ ok: true, text: "legacy" });
    expect(readExecutionOutput("ws1", second.id)).toMatchObject({ ok: true, text: "" });
    const current = save("");
    fs.unlinkSync(path.join(dir(), "bodies", `${current.id}.txt`));
    expect(code(() => readExecutionOutput("ws1", current.id))).toBe("OUTPUT_BODY_MISSING");
  });

  it("publishes image bytes with path-free metadata and detects missing/corrupt images", () => {
    const meta = saveExecutionOutput("ws1", { command: "synthetic image", raw: "safe", image: image() });
    expect(JSON.stringify(meta)).not.toContain(state);
    const result = readExecutionOutput("ws1", meta.id);
    expect(result.ok && result.image?.mimeType).toBe("image/png");
    expect(result.ok && result.image?.bytes.length).toBe(meta.image?.sizeBytes);
    const file = path.join(dir(), "images", `${meta.id}.png`);
    const bytes = fs.readFileSync(file); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(file, bytes);
    expect(code(() => readExecutionOutput("ws1", meta.id))).toBe("OUTPUT_IMAGE_CORRUPT");
    fs.unlinkSync(file);
    expect(code(() => readExecutionOutput("ws1", meta.id))).toBe("OUTPUT_IMAGE_MISSING");
  });

  it("does not publish an image when text is restricted", () => {
    const meta = saveExecutionOutput("ws1", { command: "restricted", raw: "-----BEGIN PRIVATE KEY-----", image: { artifactRoot: state, file: "does-not-exist.png" } });
    expect(meta.allowed).toBe(false);
    expect(meta.image).toBeUndefined();
    expect(readExecutionOutput("ws1", meta.id)).toEqual({ ok: false, error: "OUTPUT_RESTRICTED" });
    expect(fs.existsSync(path.join(dir(), "images"))).toBe(false);
  });

  it("atomically replaces the complete index after bodies are ready", () => {
    save("first");
    const original = fs.renameSync.bind(fs);
    let observed = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === path.join(dir(), "index.json")) {
        expect(JSON.parse(fs.readFileSync(to, "utf8")).items).toHaveLength(1);
        const next = JSON.parse(fs.readFileSync(from, "utf8"));
        expect(next.items).toHaveLength(2);
        expect(fs.readFileSync(path.join(dir(), "bodies", "2.txt"), "utf8")).toBe("second");
        observed = true;
      }
      return original(from, to);
    });
    save("second");
    expect(observed).toBe(true);
  });

  it("preserves the old index and removes this attempt's completed blobs if index publication fails", () => {
    save("first");
    const file = path.join(dir(), "index.json"), before = fs.readFileSync(file);
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("simulated publication failure"); });
    expect(code(() => save("second"))).toBe("OUTPUT_STORE_CORRUPT");
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readdirSync(path.join(dir(), "bodies"))).toEqual(["1.txt"]);
  });

  it("retains the latest 40 records with monotonic IDs and removes retired images", () => {
    const first = saveExecutionOutput("ws1", { command: "image", raw: "safe", image: image() });
    for (let i = 0; i < MAX_OUTPUT_RECORDS; i++) save(`output-${i}`);
    const items = listExecutionOutputs("ws1", 50);
    expect(items).toHaveLength(MAX_OUTPUT_RECORDS);
    expect(items.map((m) => m.id)).toEqual(Array.from({ length: 40 }, (_, i) => i + 2));
    expect(fs.existsSync(path.join(dir(), "images", `${first.id}.png`))).toBe(false);
    expect(readExecutionOutput("ws1", first.id)).toEqual({ ok: false, error: "NOT_FOUND" });
  });

  it("times out on an existing lock without deleting it or changing evidence", () => {
    save();
    const lock = path.join(dir(), ".transaction-lock");
    fs.mkdirSync(lock);
    const before = fs.readFileSync(path.join(dir(), "index.json"));
    expect(code(() => save("blocked"))).toBe("OUTPUT_STORE_BUSY");
    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.readFileSync(path.join(dir(), "index.json"))).toEqual(before);
  });
});

function worker(role: string, id: string, count: number) {
  const child = fork(fileURLToPath(new URL("./fixtures/output-store-worker.ts", import.meta.url)), [role, id, String(count)], {
    execArgv: ["--import", pathToFileURL(fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url))).href],
    env: { ...process.env, C2C_STATE_DIR: state }, stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true,
  });
  let stderr = ""; child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  const messages: any[] = [];
  child.on("message", (m: any) => { messages.push(m); if (m.kind === "ready") resolveReady(); });
  const done = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("synthetic worker timed out")); }, 20_000);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", (code) => { clearTimeout(timer); if (code !== 0) reject(new Error(stderr || `worker exit ${code}`)); else resolve(messages.find((m) => m.kind === "result")); });
  });
  return { child, ready, done };
}

describe("execution output cross-process regression", () => {
  it("preserves every concurrent successful save and consistent reader bodies below retention cap", async () => {
    saveExecutionOutput("concurrency-test", { command: "seed", raw: "seed" });
    const reader = worker("reader", "r", 0);
    const writers = Array.from({ length: 6 }, (_, i) => worker("writer", String(i), 5));
    try {
      await Promise.all([reader.ready, ...writers.map((w) => w.ready)]);
      writers.forEach((w) => w.child.send("go"));
      const results = await Promise.all(writers.map((w) => w.done));
      reader.child.send("stop");
      const read = await reader.done;
      expect(read.reads).toBeGreaterThan(0);
      expect(read.failures).toEqual([]);
      const saved = results.flatMap((r) => r.items);
      expect(saved).toHaveLength(30);
      expect(new Set(saved.map((m) => m.id)).size).toBe(30);
      const items = listExecutionOutputs("concurrency-test", 40);
      expect(items).toHaveLength(31);
      for (const item of items) expect(readExecutionOutput("concurrency-test", item.id)).toMatchObject({ ok: true, text: item.command });
      expect(new Set(items.map((m) => m.command))).toEqual(new Set(["seed", ...saved.map((m) => m.command)]));
    } finally { for (const w of [reader, ...writers]) if (w.child.exitCode === null) w.child.kill(); }
  });
});
