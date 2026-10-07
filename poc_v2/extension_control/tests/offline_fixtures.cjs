const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const extensionRoot = path.join(__dirname, "..", "chrome_extension");
function loadGlobal(fileName, globalName) {
  const sandbox = { URL, console };
  sandbox.globalThis = sandbox;
  for (const dependency of ["component_identity.js", "adapter_contract.js"]) {
    vm.runInNewContext(fs.readFileSync(path.join(extensionRoot, dependency), "utf8"), sandbox, { filename: dependency });
  }
  vm.runInNewContext(fs.readFileSync(path.join(extensionRoot, fileName), "utf8"), sandbox, { filename: fileName });
  return sandbox[globalName];
}

const Locator = loadGlobal("transcript_locator.js", "C2CV2TranscriptLocator");
const Contract = loadGlobal("adapter_contract.js", "C2CV2AdapterContract");

class FixtureNode {
  constructor(tagName, attributes = {}, text = "", children = []) {
    this.tagName = tagName.toUpperCase();
    this.attributes = attributes;
    this.ownText = text;
    this.children = children;
    this.visible = true;
    this.isConnected = true;
    this.parentElement = null;
    for (const child of children) child.parentElement = this;
  }

  get innerText() {
    return [this.ownText, ...this.children.map((child) => child.innerText)].filter(Boolean).join(" ");
  }

  get textContent() {
    return this.innerText;
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  contains(other) {
    let parent = other?.parentElement;
    while (parent) {
      if (parent === this) return true;
      parent = parent.parentElement;
    }
    return false;
  }
}

function semanticDocument(nodes) {
  const main = new FixtureNode("main", {}, "", nodes);
  return {
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="user"], [data-message-author-role="assistant"]') return nodes;
      if (selector === "main article, article, [role=\"article\"]") return nodes.filter((node) => node.tagName === "ARTICLE");
      if (selector === '[role="listitem"][aria-label], [role="group"][aria-label], [role="region"][aria-label]') return [];
      if (selector === '[data-testid^="conversation-turn"], [data-testid*="message"]') return [];
      return [];
    },
    querySelector(selector) {
      return selector === "main" ? main : null;
    },
  };
}

function tierDocument({ semantic = [], articles = [], accessible = [], stableIds = [], structural = [] }) {
  const all = [...semantic, ...articles, ...accessible, ...stableIds, ...structural];
  const main = new FixtureNode("main", {}, "", structural.length ? structural : all);
  return {
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="user"], [data-message-author-role="assistant"]') return semantic;
      if (selector === "main article, article, [role=\"article\"]") return articles;
      if (selector === '[role="listitem"][aria-label], [role="group"][aria-label], [role="region"][aria-label]') return accessible;
      if (selector === '[data-testid^="conversation-turn"], [data-testid*="message"]') return stableIds;
      return [];
    },
    querySelector(selector) {
      return selector === "main" ? main : null;
    },
  };
}

const TASK_ID = "C2C_V2_CHROME_EXTENSION_CONTROL_PLANE_POC_R1";
const NONCE = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
const OTHER_NONCE = "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4";
const COMMIT = "4229d59da343b0acb60cdc32e954346650f91e1d";
const SMOKE_REPLY = "[C2C_V2_EXTENSION_SMOKE_OK]";

const REQUEST_ID = "4754374f-14dd-4004-bf87-3b87972e17fa";
function userMessage({ nonce = NONCE, commit = COMMIT, taskId = TASK_ID, iteration = 3, requestId = REQUEST_ID, nested = false } = {}) {
  const lines = ["[C2C_V2]", "STATE: REVIEW_REQUEST", `TASK_ID: ${taskId}`, "ITERATION: " + iteration, "REQUEST_ID: " + requestId, `NONCE: ${nonce}`, `COMMIT: ${commit}`];
  if (!nested) return new FixtureNode("div", { "data-message-author-role": "user" }, lines.join("\n"));
  const spans = lines.map((line, index) => new FixtureNode("span", {}, index === 2 ? `TASK_ID: ${taskId}` : line));
  return new FixtureNode("div", { "data-message-author-role": "user" }, "", spans);
}

function assistantMessage(text) {
  return new FixtureNode("div", { "data-message-author-role": "assistant", "data-message-status": "complete" }, text);
}


module.exports = { FixtureNode, semanticDocument, tierDocument, userMessage, assistantMessage,
  TASK_ID, NONCE, OTHER_NONCE, COMMIT, SMOKE_REPLY, REQUEST_ID, extensionRoot };
