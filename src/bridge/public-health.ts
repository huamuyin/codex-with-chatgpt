import { SERVICE_NAME } from "../version.js";

export interface PublicHealthResult {
  ready: boolean;
  detail: string;
}

export interface PublicHealthOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** A process or a cached URL is not proof that this workspace is reachable. */
export async function probePublicBridge(
  publicUrl: string,
  workspaceId: string,
  options: PublicHealthOptions = {}
): Promise<PublicHealthResult> {
  try {
    const url = new URL(publicUrl);
    if (url.protocol !== "https:" || url.username || url.password) {
      return { ready: false, detail: "Public health URL must use HTTPS without credentials" };
    }
    const response = await (options.fetchImpl ?? fetch)(new URL("/health", url), {
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return { ready: false, detail: `Public health returned HTTP ${response.status}` };
    }
    const body: unknown = await response.json();
    if (!body || typeof body !== "object") {
      return { ready: false, detail: "Public health response is not an identity object" };
    }
    const health = body as Record<string, unknown>;
    if (health.service !== SERVICE_NAME || health.status !== "ok" || health.workspaceId !== workspaceId) {
      return { ready: false, detail: "Public health service/status/workspace identity mismatch" };
    }
    return { ready: true, detail: "Public health identity verified" };
  } catch {
    return { ready: false, detail: "Public health request failed, timed out, redirected, or returned invalid JSON" };
  }
}

/** Always probe the returned address after a repair, even if it is unchanged. */
export async function checkPublicBridgeWithRepair(
  publicUrl: string | null,
  workspaceId: string,
  start?: () => Promise<string | null>,
  options: PublicHealthOptions = {}
): Promise<PublicHealthResult & { url: string | null; started: boolean }> {
  const before = publicUrl
    ? await probePublicBridge(publicUrl, workspaceId, options)
    : { ready: false, detail: "No public health URL" };
  if (before.ready || !start) return { ...before, url: publicUrl, started: false };
  const url = await start();
  const after = url
    ? await probePublicBridge(url, workspaceId, options)
    : { ready: false, detail: "Tunnel start did not return a public URL" };
  return { ...after, url, started: true };
}
