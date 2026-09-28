import fs from "node:fs";
import path from "node:path";
import { listExecutionOutputs, readExecutionOutput, saveExecutionOutput } from "../../src/execution/output.js";

const [role, worker, countText] = process.argv.slice(2);
const workspace = "concurrency-test";
let stopped = false;
process.on("message", (message) => { if (message === "stop") stopped = true; });
if (role === "reader") {
  process.send?.({ kind: "ready" });
  let reads = 0;
  const failures: string[] = [];
  while (!stopped) {
    try {
      // Deliberately bypass the store mutex for one raw read: atomic publication
      // must keep even this observer from seeing truncated index JSON.
      const file = path.join(process.env.C2C_STATE_DIR!, "execution-outputs", workspace, "index.json");
      JSON.parse(fs.readFileSync(file, "utf8"));
      for (const item of listExecutionOutputs(workspace, 40)) {
        const result = readExecutionOutput(workspace, item.id);
        if (!result.ok || result.text !== item.command) failures.push("body/index mismatch");
      }
      reads++;
    } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  process.send?.({ kind: "result", reads, failures });
} else {
  const go = new Promise<void>((resolve) => process.once("message", () => resolve()));
  process.send?.({ kind: "ready" });
  await go;
  const items = [];
  for (let n = 0; n < Number(countText); n++) {
    const marker = `synthetic-${worker}-${n}`;
    items.push(saveExecutionOutput(workspace, { command: marker, raw: marker, exitCode: 0 }));
  }
  process.send?.({ kind: "result", items });
}
process.disconnect?.();
