import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configureSharedRuntime,
  readSharedRuntimeConfig,
  markSharedRuntimeVerified,
  sharedRuntimeConfigFile,
} from "../src/config/shared-runtime.js";
import { cleanup, makeTmpDir } from "./helpers.js";

describe("shared Reviewer runtime config", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("is unconfigured by default and persists non-secret metadata machine-wide", () => {
    const dir = makeTmpDir("shared-runtime");
    dirs.push(dir);
    process.env.C2C_STATE_DIR = dir;

    expect(readSharedRuntimeConfig()).toBeNull();
    const configured = configureSharedRuntime({
      transportMode: "local-cdp",
      cdpEndpoint: "http://127.0.0.1:9222",
      browser: "edge",
      profileIdentity: "C2C Reviewer",
      lifecycleMode: "external",
    });

    expect(configured.configuredAt).toBeTruthy();
    expect(configured.lastVerifiedAt).toBeUndefined();
    expect(readSharedRuntimeConfig()).toEqual(configured);
    const stored = fs.readFileSync(sharedRuntimeConfigFile(), "utf8");
    expect(stored).not.toMatch(/cookie|token|localStorage|sessionStorage|authorization/i);
    expect(JSON.parse(stored)).not.toHaveProperty("credentials");

    const verified = markSharedRuntimeVerified("2026-09-30T00:00:00.000Z");
    expect(verified.configuredAt).toBe(configured.configuredAt);
    expect(verified.lastVerifiedAt).toBe("2026-09-30T00:00:00.000Z");
  });

  it.each([
    "https://127.0.0.1:9222",
    "http://192.168.1.5:9222",
    "http://example.com:9222",
    "http://localhost:0",
    "http://localhost:65536",
    "http://localhost:abc",
  ])("rejects unsafe or malformed CDP endpoint %s", (cdpEndpoint) => {
    expect(() =>
      configureSharedRuntime({
        transportMode: "local-cdp",
        cdpEndpoint,
        browser: "edge",
        profileIdentity: "reviewer",
        lifecycleMode: "external",
      })
    ).toThrow();
  });

  it.each(["http://localhost:9222", "http://[::1]:9222"])("accepts loopback endpoint %s", (cdpEndpoint) => {
    const dir = makeTmpDir("shared-runtime-loopback");
    dirs.push(dir);
    process.env.C2C_STATE_DIR = dir;
    expect(
      configureSharedRuntime({
        transportMode: "local-cdp",
        cdpEndpoint,
        browser: "chrome",
        profileIdentity: "reviewer",
        lifecycleMode: "resident",
      }).cdpEndpoint
    ).toBe(cdpEndpoint);
  });

  it("fails closed on malformed persisted configuration", () => {
    const dir = makeTmpDir("shared-runtime-corrupt");
    dirs.push(dir);
    process.env.C2C_STATE_DIR = dir;
    const file = sharedRuntimeConfigFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not-json");
    expect(() => readSharedRuntimeConfig()).toThrow();
  });
});
