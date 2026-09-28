import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()!); });

function runLauncher(builtVersion?: string) {
  const dir = makeTmpDir("launcher-build");
  dirs.push(dir);
  write(dir, "package.json", JSON.stringify({ type: "module", version: "0.2.0" }));
  write(dir, "bin/c2c.js", fs.readFileSync(fileURLToPath(new URL("../bin/c2c.js", import.meta.url)), "utf8"));
  write(dir, "dist/cli/index.js", "console.log('MATCHING_CLI_LOADED');\n");
  if (builtVersion) write(dir, "dist/version.js", `export const VERSION = ${JSON.stringify(builtVersion)};\n`);
  return spawnSync(process.execPath, [path.join(dir, "bin/c2c.js"), "--version"], { encoding: "utf8", timeout: 10_000 });
}

describe("CLI build identity guard", () => {
  it.each(["0.1.3", undefined])("rejects stale or incomplete dist %s before CLI executes", (builtVersion) => {
    const result = runLauncher(builtVersion);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("STALE_BUILD");
    expect(result.stdout).not.toContain("MATCHING_CLI_LOADED");
  });

  it("loads a matching version without installing or building anything", () => {
    const result = runLauncher("0.2.0");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("MATCHING_CLI_LOADED");
  });
});
