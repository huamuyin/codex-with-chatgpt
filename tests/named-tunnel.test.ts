import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { CloudflaredNamedTunnel } from "../src/tunnel/cloudflared-named.js";

const URL = "https://synthetic.example.com";
class FakeProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
}

function setup() {
  const children: FakeProcess[] = [];
  const spawnImpl = vi.fn(() => {
    const child = new FakeProcess();
    children.push(child);
    return child as unknown as ChildProcess;
  });
  const tunnel = new CloudflaredNamedTunnel({
    tunnelName: "existing-named-id",
    hostname: "synthetic.example.com",
    binaryOverride: "cloudflared",
    startTimeoutMs: 100,
    spawnImpl,
  });
  return { children, spawnImpl, tunnel };
}

function line(child: FakeProcess, text: string) {
  child.stderr.write(`${text}\n`);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("named tunnel process and connection lifecycle", () => {
  it("tracks individual disconnects, loses URL on last loss and waits on the same reconnecting process", async () => {
    const { children, tunnel, spawnImpl } = setup();
    const start = tunnel.start(3333);
    const child = children[0];
    line(child, "INF Registered tunnel connection connIndex=0");
    await expect(start).resolves.toBe(URL);
    line(child, "INF Registered tunnel connection connIndex=1");
    line(child, "INF Unregistered tunnel connection connIndex=0");
    expect(tunnel.status()).toMatchObject({ running: true, url: URL });
    line(child, "ERR Connection terminated connIndex=1");
    expect(tunnel.status()).toMatchObject({ running: true, url: null });
    expect((await tunnel.doctor()).problems).toContain("named tunnel process running without an active connection");
    const reconnect = tunnel.start(3333);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    line(child, "INF Registered tunnel connection connIndex=1");
    await expect(reconnect).resolves.toBe(URL);
    expect(tunnel.status().detail).toBeUndefined();
    await tunnel.stop();
  });

  it("serializes starts and rejects all pending waiters on stop", async () => {
    const { children, tunnel, spawnImpl } = setup();
    const first = tunnel.start(3333);
    const second = tunnel.start(3333);
    const rejected = Promise.all([expect(first).rejects.toThrow(/stopped/), expect(second).rejects.toThrow(/stopped/)]);
    await tunnel.stop();
    await rejected;
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(children[0].kill).toHaveBeenCalledWith("SIGTERM");
    expect(tunnel.status()).toMatchObject({ running: false, url: null });
  });

  it("does not reuse a settled start if the connection is lost before its finally callback", async () => {
    const { children, tunnel, spawnImpl } = setup();
    const original = tunnel.start(3333);
    line(children[0], "INF Registered tunnel connection connIndex=0");
    line(children[0], "ERR Connection terminated connIndex=0");
    const reconnect = tunnel.start(3333);
    const rejected = expect(reconnect).rejects.toThrow(/stopped/);
    await tunnel.stop();
    await expect(original).resolves.toBe(URL);
    await rejected;
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it("ignores late error/exit/log callbacks from a stopped child after restart", async () => {
    const { children, tunnel } = setup();
    const original = tunnel.start(3333);
    const rejected = expect(original).rejects.toThrow(/stopped/);
    const stopping = tunnel.stop();
    // Start immediately, before the old start's finally callback gets another turn.
    const replacement = tunnel.start(3333);
    await stopping;
    await rejected;
    line(children[1], "INF Registered tunnel connection connIndex=0");
    await expect(replacement).resolves.toBe(URL);
    children[0].emit("error", new Error("late old error"));
    children[0].emit("exit", 1);
    children[0].stderr.emit("data", "ERR Connection terminated connIndex=0\n");
    expect(tunnel.status()).toMatchObject({ running: true, url: URL });
    expect(tunnel.status().detail).toBeUndefined();
    await tunnel.stop();
  });

  it("times out without a dangling process or unresolved start", async () => {
    vi.useFakeTimers();
    const { children, tunnel } = setup();
    const rejected = expect(tunnel.start(3333)).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(children[0].kill).toHaveBeenCalledOnce();
    expect(tunnel.status()).toMatchObject({ running: false, url: null });
  });

  it("rejects an asynchronous process error and a pre-registration exit", async () => {
    const { children, tunnel } = setup();
    const first = expect(tunnel.start(3333)).rejects.toThrow("ENOENT");
    children[0].emit("error", new Error("ENOENT"));
    await first;
    const second = expect(tunnel.start(3333)).rejects.toThrow(/exited/);
    children[1].emit("exit", 9);
    await second;
    expect(tunnel.status()).toMatchObject({ running: false, url: null });
  });

  it("does not mistake unregistration for registration or retain unindexed stale connections", async () => {
    const { children, tunnel } = setup();
    const start = tunnel.start(3333);
    line(children[0], "INF Unregistered tunnel connection connIndex=0");
    expect(tunnel.getPublicUrl()).toBeNull();
    line(children[0], "INF Registered tunnel connection");
    await start;
    line(children[0], "ERR Retrying connection in up to 1s connIndex=0");
    expect(tunnel.getPublicUrl()).toBeNull();
    await tunnel.stop();
  });

  it("uses only the same named tunnel and honors an explicit process protocol", async () => {
    vi.stubEnv("C2C_TUNNEL_PROTOCOL", "http2");
    const { children, spawnImpl, tunnel } = setup();
    const start = tunnel.start(3333);
    line(children[0], "INF Registered tunnel connection connIndex=0");
    await start;
    expect(spawnImpl).toHaveBeenCalledWith("cloudflared", [
      "tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:3333", "--protocol", "http2", "run", "existing-named-id",
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    await tunnel.stop();
  });
});
