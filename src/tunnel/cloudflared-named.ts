import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { Logger } from "../logger/index.js";
import { nullLogger } from "../logger/index.js";
import { findBinary } from "./detect.js";
import { tunnelProtocolArgs } from "./protocol.js";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "./provider.js";

const CONNECTED_RE = /registered tunnel connection/i;
const DISCONNECTED_RE = /unregistered tunnel connection|connection terminated|failed to (?:serve|accept).*connection|(?:serve tunnel|connection with edge).*error|retrying connection|lost connection/i;
const CONNECTION_INDEX_RE = /\bconnIndex=(\d+)\b/;
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export interface CloudflaredNamedTunnelOptions {
  tunnelName: string;
  hostname: string;
  logger?: Logger;
  binaryOverride?: string;
  startTimeoutMs?: number;
  spawnImpl?: (
    command: string,
    args: string[],
    options: { stdio: ["ignore", "pipe", "pipe"]; windowsHide: true }
  ) => ChildProcess;
}

export function normalizeNamedTunnelHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!HOSTNAME_RE.test(normalized)) {
    throw new Error(`Invalid named tunnel hostname: ${hostname}`);
  }
  return normalized;
}

/**
 * Locally-managed Cloudflare named tunnel.
 *
 * The tunnel object and its DNS route are provisioned once with cloudflared.
 * This provider only starts and monitors the connector process, so the public
 * URL remains stable across bridge restarts.
 */
export class CloudflaredNamedTunnel implements TunnelProvider {
  readonly name = "cloudflare-named";
  private readonly tunnelName: string;
  private readonly hostname: string;
  private readonly logger: Logger;
  private readonly binaryOverride?: string;
  private readonly startTimeoutMs: number;
  private readonly spawnImpl: NonNullable<CloudflaredNamedTunnelOptions["spawnImpl"]>;
  private child: ChildProcess | null = null;
  private readonly connections = new Set<string>();
  private lastError: string | null = null;
  private starting: Promise<string> | null = null;
  private pending: {
    child: ChildProcess;
    resolve: (url: string) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(opts: CloudflaredNamedTunnelOptions) {
    const tunnelName = opts.tunnelName.trim();
    if (!tunnelName || tunnelName.length > 128) {
      throw new Error("Named tunnel name must be between 1 and 128 characters");
    }
    this.tunnelName = tunnelName;
    this.hostname = normalizeNamedTunnelHostname(opts.hostname);
    this.logger = opts.logger ?? nullLogger;
    this.binaryOverride = opts.binaryOverride;
    this.startTimeoutMs = opts.startTimeoutMs ?? 45_000;
    this.spawnImpl = opts.spawnImpl ?? spawn;
  }

  private binary(): string | null {
    return this.binaryOverride ?? findBinary("cloudflared");
  }

  private publicUrl(): string {
    return `https://${this.hostname}`;
  }

  async start(localPort: number): Promise<string> {
    if (this.child && this.connections.size > 0) return this.publicUrl();
    if (this.starting) return this.starting;
    const starting = this.waitForConnection(localPort);
    this.starting = starting;
    try {
      return await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  private finishStart(child: ChildProcess, error?: Error): void {
    const pending = this.pending;
    if (!pending || pending.child !== child) return;
    this.pending = null;
    this.starting = null;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(this.publicUrl());
  }

  private waitForConnection(localPort: number): Promise<string> {
    // A disconnected cloudflared process reconnects itself. A concurrent start
    // waits for that same process instead of creating another connector.
    if (!this.child) this.spawnProcess(localPort);
    const child = this.child!;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.child !== child) return;
        this.lastError = "Named tunnel start timed out";
        this.finishStart(child, new Error(this.lastError));
        this.detachChild(child);
      }, this.startTimeoutMs);
      this.pending = { child, resolve, reject, timer };
    });
  }

  private detachChild(child: ChildProcess): void {
    if (this.child === child) {
      this.child = null;
      this.connections.clear();
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
    try {
      child.kill("SIGTERM");
    } catch {
      // The child may already have exited.
    }
  }

  private spawnProcess(localPort: number): void {
    const bin = this.binary();
    if (!bin) {
      throw new Error(
        "cloudflared is not installed. Install it (e.g. `brew install cloudflared`) and retry."
      );
    }

    const child = this.spawnImpl(
      bin,
      [
        "tunnel",
        "--no-autoupdate",
        "--url",
        `http://127.0.0.1:${localPort}`,
        ...tunnelProtocolArgs(),
        "run",
        this.tunnelName,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    this.child = child;
    this.connections.clear();
    this.lastError = null;

    const scan = (stream: NodeJS.ReadableStream): void => {
      const rl = readline.createInterface({ input: stream });
      rl.on("line", (line) => {
        if (this.child !== child) return;
        const index = CONNECTION_INDEX_RE.exec(line)?.[1];
        // Test disconnect first: "unregistered" also contains "registered".
        if (DISCONNECTED_RE.test(line)) {
          if (index) {
            this.connections.delete(index);
            this.connections.delete("unknown");
          } else {
            this.connections.clear();
          }
          this.lastError = line.slice(0, 400);
        } else if (CONNECTED_RE.test(line)) {
          this.connections.add(index ?? "unknown");
          this.lastError = null;
          const url = this.publicUrl();
          this.logger.info(`Named tunnel established: ${url}`);
          this.finishStart(child);
        }
        if (/\b(error|failed|fatal)\b/i.test(line)) {
          this.lastError = line.slice(0, 400);
          this.logger.debug(`cloudflared: ${line.slice(0, 400)}`);
        }
      });
    };
    if (child.stdout) scan(child.stdout);
    if (child.stderr) scan(child.stderr);

    child.on("error", (error) => {
      if (this.child !== child) return;
      this.lastError = error.message;
      this.finishStart(child, error);
      this.detachChild(child);
    });
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.logger.warn(`cloudflared named tunnel exited with code ${code}`);
      this.lastError = `cloudflared named tunnel exited (code ${code})`;
      this.finishStart(child, new Error(this.lastError));
      this.detachChild(child);
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (child) {
      this.finishStart(child, new Error("Named tunnel start stopped"));
      this.detachChild(child);
    }
    this.starting = null;
    this.lastError = null;
  }

  async restart(localPort: number): Promise<string> {
    await this.stop();
    return this.start(localPort);
  }

  status(): TunnelStatus {
    return {
      running: this.child !== null,
      url: this.connections.size > 0 ? this.publicUrl() : null,
      provider: this.name,
      detail: this.lastError ?? undefined,
    };
  }

  getPublicUrl(): string | null {
    return this.connections.size > 0 ? this.publicUrl() : null;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    const bin = this.binary();
    const problems: string[] = [];
    if (!bin) problems.push("cloudflared binary not found");
    if (bin && !this.child) problems.push("named tunnel process not running");
    if (this.child && this.connections.size === 0) problems.push("named tunnel process running without an active connection");
    return {
      provider: this.name,
      binaryFound: bin !== null,
      binaryPath: bin,
      running: this.child !== null,
      url: this.getPublicUrl(),
      problems,
    };
  }
}
