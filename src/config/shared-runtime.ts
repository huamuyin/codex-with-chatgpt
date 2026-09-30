import fs from "node:fs";
import path from "node:path";
import { getStateDir, writeSecureJson } from "./paths.js";

export type ReviewerBrowser = "chrome" | "edge";
export type BrowserLifecycleMode = "external" | "resident";

export interface SharedRuntimeConfig {
  schemaVersion: 1;
  transportMode: "local-cdp";
  cdpEndpoint: string;
  browser: ReviewerBrowser;
  profileIdentity: string;
  lifecycleMode: BrowserLifecycleMode;
  configuredAt: string;
  lastVerifiedAt?: string;
}

export type SharedRuntimeConfigInput = Omit<
  SharedRuntimeConfig,
  "schemaVersion" | "configuredAt" | "lastVerifiedAt"
>;

export function sharedRuntimeConfigFile(): string {
  return path.join(getStateDir(), "shared-runtime.json");
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function normalizeEndpoint(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("CDP endpoint must be an absolute loopback HTTP URL with an explicit port");
  }
  const host = parsed.hostname.toLowerCase();
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  const port = Number(parsed.port);
  if (
    parsed.protocol !== "http:" ||
    !loopback ||
    !parsed.port ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new Error("CDP endpoint must use HTTP on loopback with a valid explicit port and no credentials or path");
  }
  return `http://${host === "[::1]" ? "[::1]" : host}:${port}`;
}

export function validateSharedRuntimeConfig(value: unknown): SharedRuntimeConfig {
  if (!value || typeof value !== "object") throw new Error("SHARED_RUNTIME_CONFIG_INVALID");
  const config = value as Record<string, unknown>;
  if (
    config.schemaVersion !== 1 ||
    config.transportMode !== "local-cdp" ||
    (config.browser !== "chrome" && config.browser !== "edge") ||
    (config.lifecycleMode !== "external" && config.lifecycleMode !== "resident") ||
    typeof config.profileIdentity !== "string" ||
    config.profileIdentity.trim().length < 1 ||
    config.profileIdentity.length > 120 ||
    !isTimestamp(config.configuredAt) ||
    (config.lastVerifiedAt !== undefined && !isTimestamp(config.lastVerifiedAt))
  ) {
    throw new Error("SHARED_RUNTIME_CONFIG_INVALID");
  }
  const cdpEndpoint = normalizeEndpoint(String(config.cdpEndpoint ?? ""));
  return {
    schemaVersion: 1,
    transportMode: "local-cdp",
    cdpEndpoint,
    browser: config.browser,
    profileIdentity: config.profileIdentity.trim(),
    lifecycleMode: config.lifecycleMode,
    configuredAt: config.configuredAt,
    ...(config.lastVerifiedAt ? { lastVerifiedAt: config.lastVerifiedAt } : {}),
  };
}

export function readSharedRuntimeConfig(): SharedRuntimeConfig | null {
  const file = sharedRuntimeConfigFile();
  if (!fs.existsSync(file)) return null;
  try {
    return validateSharedRuntimeConfig(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof Error && error.message === "SHARED_RUNTIME_CONFIG_INVALID") throw error;
    throw new Error("SHARED_RUNTIME_CONFIG_INVALID");
  }
}

export function configureSharedRuntime(input: SharedRuntimeConfigInput): SharedRuntimeConfig {
  const config = validateSharedRuntimeConfig({
    ...input,
    schemaVersion: 1,
    configuredAt: new Date().toISOString(),
  });
  writeSecureJson(sharedRuntimeConfigFile(), config);
  return config;
}

export function markSharedRuntimeVerified(at = new Date().toISOString()): SharedRuntimeConfig {
  const current = readSharedRuntimeConfig();
  if (!current) throw new Error("SHARED_RUNTIME_NOT_CONFIGURED");
  if (!isTimestamp(at)) throw new Error("verification timestamp is invalid");
  const next = validateSharedRuntimeConfig({ ...current, lastVerifiedAt: at });
  writeSecureJson(sharedRuntimeConfigFile(), next);
  return next;
}
