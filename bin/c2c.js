#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist", "cli", "index.js");

if (existsSync(dist)) {
  const expected = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8")).version;
  let builtVersion;
  try {
    ({ VERSION: builtVersion } = await import(pathToFileURL(path.join(here, "..", "dist", "version.js")).href));
  } catch {
    // An incomplete/old build must not silently launch an unknown CLI.
  }
  if (typeof expected !== "string" || builtVersion !== expected) {
    console.error(`STALE_BUILD: package version ${expected} does not match built version ${builtVersion ?? "missing"}. Rebuild this installation before using c2c.`);
    process.exit(1);
  }
  await import(pathToFileURL(dist).href);
} else {
  // dev fallback: run TypeScript sources through the tsx ESM loader
  const entry = path.join(here, "..", "src", "cli", "index.ts");
  const result = spawnSync(process.execPath, ["--import", "tsx/esm", entry, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}
