import { afterEach, describe, expect, it } from "vitest";
import { configureSharedRuntime } from "../src/config/shared-runtime.js";
import { getWorkspaceTransport, setWorkspaceTransport } from "../src/session/transport.js";
import { resolveConversation } from "../src/session/state.js";
import { cleanup, makeTmpDir } from "./helpers.js";

describe("per-workspace transport selection", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("defaults each workspace to legacy and opts workspaces in independently", () => {
    const dir = makeTmpDir("workspace-transport");
    dirs.push(dir);
    process.env.C2C_STATE_DIR = dir;

    expect(getWorkspaceTransport("project-a").mode).toBe("legacy");
    expect(getWorkspaceTransport("long-chat-b").mode).toBe("legacy");
    setWorkspaceTransport("project-a", "local-cdp");
    setWorkspaceTransport("legacy-c", "legacy");

    expect(getWorkspaceTransport("project-a").mode).toBe("local-cdp");
    expect(getWorkspaceTransport("long-chat-b").mode).toBe("legacy");
    expect(getWorkspaceTransport("legacy-c").mode).toBe("legacy");
    setWorkspaceTransport("project-a", "legacy");
    expect(getWorkspaceTransport("project-a").mode).toBe("legacy");
  });

  it("does not let machine config opt any workspace into local CDP", () => {
    const dir = makeTmpDir("workspace-transport-no-implicit-opt-in");
    dirs.push(dir);
    process.env.C2C_STATE_DIR = dir;
    configureSharedRuntime({
      transportMode: "local-cdp",
      cdpEndpoint: "http://127.0.0.1:9222",
      browser: "edge",
      profileIdentity: "shared-reviewer",
      lifecycleMode: "external",
    });

    expect(getWorkspaceTransport("family-fund").mode).toBe("legacy");
    expect(getWorkspaceTransport("zhengzhou").mode).toBe("legacy");
  });

  it("rejects malformed workspace identity and invalid transport modes", () => {
    expect(() => getWorkspaceTransport("../other-workspace")).toThrow();
    expect(() => setWorkspaceTransport("workspace-a", "global" as never)).toThrow();
  });

  it("keeps legacy, project and long-chat conversation resolution unchanged", () => {
    const dir = makeTmpDir("workspace-transport-session-compat");
    dirs.push(dir);
    process.env.C2C_STATE_DIR = dir;
    setWorkspaceTransport("legacy", "local-cdp");
    const legacy = resolveConversation({ url: "https://chatgpt.com/c/legacy", savedAt: "2026-01-01T00:00:00.000Z" });
    const project = resolveConversation({
      conversationMode: "project",
      projectUrl: "https://chatgpt.com/g/g-p-abc123/project",
      url: "https://chatgpt.com/c/project",
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    const longChat = resolveConversation({
      conversationMode: "long-chat",
      projectUrl: "https://chatgpt.com/g/g-p-abc123/project",
      url: "https://chatgpt.com/c/long",
      savedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(legacy.mode).toBe("long-chat");
    expect(project.mode).toBe("project");
    expect(longChat.mode).toBe("long-chat");
    expect(getWorkspaceTransport("legacy").mode).toBe("local-cdp");
  });
});
