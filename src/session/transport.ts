import fs from "node:fs";
import path from "node:path";
import { getStateDir, writeSecureJson } from "../config/paths.js";

export type WorkspaceTransportMode = "legacy" | "local-cdp";

export interface WorkspaceTransportPreference {
  schemaVersion: 1;
  workspaceId: string;
  mode: WorkspaceTransportMode;
  configuredAt: string;
}

function validateWorkspaceId(workspaceId: string): void {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(workspaceId)) throw new Error("WORKSPACE_ID_INVALID");
}

function transportFile(workspaceId: string): string {
  validateWorkspaceId(workspaceId);
  return path.join(getStateDir(), "transports", `${workspaceId}.json`);
}

export function getWorkspaceTransport(workspaceId: string): WorkspaceTransportPreference {
  const file = transportFile(workspaceId);
  if (!fs.existsSync(file)) {
    return { schemaVersion: 1, workspaceId, mode: "legacy", configuredAt: "" };
  }
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (
      value.schemaVersion !== 1 ||
      value.workspaceId !== workspaceId ||
      (value.mode !== "legacy" && value.mode !== "local-cdp") ||
      typeof value.configuredAt !== "string" ||
      !Number.isFinite(Date.parse(value.configuredAt))
    ) {
      throw new Error("WORKSPACE_TRANSPORT_INVALID");
    }
    return value as unknown as WorkspaceTransportPreference;
  } catch (error) {
    if (error instanceof Error && error.message === "WORKSPACE_TRANSPORT_INVALID") throw error;
    throw new Error("WORKSPACE_TRANSPORT_INVALID");
  }
}

export function setWorkspaceTransport(
  workspaceId: string,
  mode: WorkspaceTransportMode
): WorkspaceTransportPreference {
  const file = transportFile(workspaceId);
  if (mode !== "legacy" && mode !== "local-cdp") throw new Error("WORKSPACE_TRANSPORT_MODE_INVALID");
  const preference: WorkspaceTransportPreference = {
    schemaVersion: 1,
    workspaceId,
    mode,
    configuredAt: new Date().toISOString(),
  };
  writeSecureJson(file, preference);
  return preference;
}
