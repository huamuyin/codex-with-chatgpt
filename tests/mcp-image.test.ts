import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PNG } from "pngjs";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { saveExecutionOutput } from "../src/execution/output.js";
import { executionImageMetadata, sanitizeExecutionImage } from "../src/execution/image.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

let root: string;
let otherRoot: string;
let artifacts: string;
let stateDir: string;
let bridge: Bridge;
let otherBridge: Bridge;
let client: Client;
const clients: Client[] = [];

async function connect(target: Bridge, scopes: string[]): Promise<Client> {
  const tokens = target.authStore.issueTokens({ clientId: "image-test", scopes });
  const result = new Client({ name: "image-test", version: "1.0.0" });
  await result.connect(new StreamableHTTPClientTransport(new URL(`${target.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${tokens.accessToken}` } },
  }));
  clients.push(result);
  return result;
}

beforeAll(async () => {
  stateDir = isolateStateDir();
  root = makeTmpDir("mcp-image-workspace");
  otherRoot = makeTmpDir("mcp-image-other-workspace");
  artifacts = makeTmpDir("mcp-image-artifacts");
  bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false, authStoreFile: path.join(stateDir, "image-auth.json") });
  otherBridge = await startBridge({ workspaceRoot: otherRoot, port: 0, persistRuntime: false, authStoreFile: path.join(stateDir, "other-image-auth.json") });
  client = await connect(bridge, ["execution.read"]);
});

afterAll(async () => {
  for (const item of clients) await item.close();
  await bridge.close();
  await otherBridge.close();
  cleanup(root);
  cleanup(otherRoot);
  cleanup(artifacts);
  cleanup(stateDir);
});

function publish(name: string) {
  const file = path.join(artifacts, name);
  fs.writeFileSync(file, PNG.sync.write({ width: 2, height: 2, data: Buffer.from([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
  ]) }));
  const image = sanitizeExecutionImage({ artifactRoot: artifacts, file });
  const meta = saveExecutionOutput(bridge.workspace.id, {
    command: "synthetic image observation",
    raw: "Synthetic local image approved for visual inspection.",
    image: { artifactRoot: artifacts, file },
  });
  return { file, image, meta };
}

describe("execution_output MCP image attachments", () => {
  it("returns genuine image content with exact sanitized bytes and path-free metadata", async () => {
    const published = publish("observation.png");
    const result = await client.callTool({ name: "execution_output", arguments: { action: "read", id: published.meta.id } });
    expect(result.isError ?? false).toBe(false);
    const content = result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    expect(content.map((item) => item.type)).toEqual(["text", "image"]);
    const image = content[1];
    expect(image.mimeType).toBe("image/png");
    expect(Buffer.from(image.data!, "base64")).toEqual(published.image.bytes);
    const body = JSON.parse(content[0].text!);
    expect(body.image).toEqual(executionImageMetadata(published.image));
    expect(result.structuredContent).toEqual(body);
    for (const localPath of [root, artifacts, published.file, stateDir]) expect(JSON.stringify(result)).not.toContain(localPath);
    expect(body).not.toHaveProperty("artifactRoot");
    expect(body.image).not.toHaveProperty("path");
    expect(body.image).not.toHaveProperty("file");
  });

  it("lists metadata only and advertises no public file/root/URL input", async () => {
    const published = publish("listed.png");
    const result = await client.callTool({ name: "execution_output", arguments: { action: "list" } });
    expect(result.isError ?? false).toBe(false);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content.map((item) => item.type)).toEqual(["text"]);
    const body = JSON.parse(content[0].text!);
    expect(body.items.find((item: { id: number }) => item.id === published.meta.id).image).toEqual(executionImageMetadata(published.image));
    expect(JSON.stringify(body)).not.toContain(artifacts);
    const { tools } = await client.listTools();
    const properties = Object.keys(tools.find((item) => item.name === "execution_output")!.inputSchema.properties ?? {});
    expect(properties.sort()).toEqual(["action", "id", "limit"]);
  });

  it("requires execution.read for image reads as well as output listing", async () => {
    const published = publish("scoped.png");
    const limited = await connect(bridge, ["workspace.read"]);
    for (const args of [{ action: "read", id: published.meta.id }, { action: "list" }]) {
      const result = await limited.callTool({ name: "execution_output", arguments: args });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("INSUFFICIENT_SCOPE");
      expect((result.content as Array<{ type: string }>).some((item) => item.type === "image")).toBe(false);
    }
  });

  it("serves the immutable sanitized snapshot after source bytes change", async () => {
    const published = publish("immutable.png");
    fs.writeFileSync(published.file, "replacement content is never sent");
    const result = await client.callTool({ name: "execution_output", arguments: { action: "read", id: published.meta.id } });
    expect(result.isError ?? false).toBe(false);
    const image = (result.content as Array<{ type: string; data?: string }>).find((item) => item.type === "image")!;
    expect(Buffer.from(image.data!, "base64")).toEqual(published.image.bytes);
  });

  it("does not expose another workspace's image or accept an arbitrary image path", async () => {
    const published = publish("isolated.png");
    const other = await connect(otherBridge, ["execution.read"]);
    const result = await other.callTool({ name: "execution_output", arguments: { action: "read", id: published.meta.id } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("NOT_FOUND");
    expect((result.content as Array<{ type: string }>).some((item) => item.type === "image")).toBe(false);
    const pathOnly = await client.callTool({ name: "execution_output", arguments: { action: "read", file: published.file, artifactRoot: artifacts } });
    expect(pathOnly.isError).toBe(true);
    expect((pathOnly.content as Array<{ type: string }>).some((item) => item.type === "image")).toBe(false);
  });

  it("returns the same attachment bytes through two independent fresh sessions", async () => {
    const published = publish("fresh-sessions.png");
    const first = await connect(bridge, ["execution.read"]);
    const second = await connect(bridge, ["execution.read"]);
    for (const fresh of [first, second]) {
      const result = await fresh.callTool({ name: "execution_output", arguments: { action: "read", id: published.meta.id } });
      expect(result.isError ?? false).toBe(false);
      const image = (result.content as Array<{ type: string; data?: string }>).find((item) => item.type === "image")!;
      expect(Buffer.from(image.data!, "base64")).toEqual(published.image.bytes);
    }
  });
});
