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

test("first message from a blank new Chat page makes one send eligible", () => {
  assert.equal(Contract.decideSend({
    userTurnFound: false,
    nonceObserved: false,
    maySend: true,
    composerText: "",
    staleDraftProven: false,
  }), "send-once");
});

test("root-to-conversation URL transition keeps the same tab and refreshes binding", () => {
  const root = Contract.bindChatTab(null, { id: 7, url: "https://chatgpt.com/" });
  const conversation = Contract.bindChatTab(root, { id: 7, url: "https://chatgpt.com/c/poc-123" });
  assert.equal(conversation.tab_id, 7);
  assert.equal(conversation.tab_url, "https://chatgpt.com/c/poc-123");
  assert.equal(conversation.same_tab, true);
  assert.equal(conversation.url_changed, true);
});

test("a stale pre-navigation binding is replaced with the live conversation URL", () => {
  const stale = Contract.bindChatTab(null, { id: 19, url: "https://chatgpt.com/" });
  const rebound = Contract.bindChatTab(stale, { id: 19, url: "https://chatgpt.com/c/live" });
  assert.notEqual(rebound.tab_url, stale.tab_url);
  assert.equal(rebound.tab_id, stale.tab_id);
  assert.equal(rebound.generation, stale.generation + 1);
});

test("original recovery rejects navigation and only accepts its existing exact tab", () => {
  const conversationUrl = "https://chatgpt.com/c/6abcb6a6-a1b8-83e8-bc72-f85af94bb2f0";
  assert.equal(Contract.isConversationUrl(conversationUrl), true);
  assert.equal(Contract.decideRecoveryTarget({
    targetTabId: 1653112936,
    originalTabId: 1653112936,
    targetUrl: "https://chatgpt.com/",
    conversationUrl,
  }), "binding-mismatch");
  assert.equal(Contract.decideRecoveryTarget({
    targetTabId: 1653112936,
    originalTabId: 1653112936,
    targetUrl: conversationUrl,
    conversationUrl,
  }), "reuse-same-tab");
  assert.equal(Contract.isConversationUrl("https://example.com/c/not-a-chat"), false);
  assert.equal(Contract.isConversationUrl("https://chatgpt.com/"), false);
  assert.equal(Contract.isConversationUrl("https://chatgpt.com/c/not-a-chat?query=1"), false);
});

test("line-wrapped control fields normalize and remain discoverable", () => {
  const wrapped = `[C2C_V2]\nTASK_ID:\n${TASK_ID}\nNONCE:\n${NONCE}\nCOMMIT:\n${COMMIT}`;
  assert.deepEqual({ ...Locator.extractMarkers(wrapped) }, { task_id: TASK_ID, nonce: NONCE, commit: COMMIT, iteration: null, request_id: "" });
});

test("nested spans and markdown text keep identity markers in one message node", () => {
  const user = userMessage({ nested: true });
  const found = Locator.findUserTurn(semanticDocument([user]), { task_id: TASK_ID, nonce: NONCE, commit: COMMIT });
  assert.equal(found?.node, user);
  assert.equal(found?.role, "user");
});

test("semantic article containers are used when author-role attributes are unavailable", () => {
  const user = new FixtureNode("article", { "aria-label": "You said" }, userMessage().innerText);
  const assistant = new FixtureNode("article", { "aria-label": "ChatGPT said" }, SMOKE_REPLY);
  const result = Locator.recoverOriginal(tierDocument({ articles: [user, assistant] }), {
    request_id: "4754374f-14dd-4004-bf87-3b87972e17fa",
    task_id: TASK_ID,
    expected_commit: COMMIT,
    expected_reply: SMOKE_REPLY,
    nonce: NONCE, iteration: 3, original_message: userMessage().innerText, attempt: 1,
  });
  assert.equal(result.original_user_turn_found, true);
  assert.equal(result.assistant_reply_exact, true);
  assert.equal(result.selector_strategy, "semantic-article;semantic-article");
});

test("mixed semantic tiers are merged in document order when only one turn has author-role data", () => {
  const user = userMessage();
  const assistant = new FixtureNode("article", { "aria-label": "ChatGPT said" }, SMOKE_REPLY);
  const document = semanticDocument([user, assistant]);
  const foundUser = Locator.findUserTurn(document, { task_id: TASK_ID, nonce: NONCE, commit: COMMIT }, SMOKE_REPLY);
  const foundAssistant = Locator.findAssistantAfter(document, foundUser, SMOKE_REPLY);
  assert.equal(foundUser?.node, user);
  assert.equal(foundAssistant?.node, assistant);
});

test("accessible role and stable test ID tiers classify messages without dynamic classes", () => {
  const accessibleUser = new FixtureNode("div", { role: "group", "aria-label": "You said" }, `TASK_ID: ${TASK_ID} NONCE: ${NONCE} COMMIT: ${COMMIT}`);
  const accessibleAssistant = new FixtureNode("div", { role: "group", "aria-label": "ChatGPT said" }, SMOKE_REPLY);
  assert.equal(Locator.collectMessages(tierDocument({ accessible: [accessibleUser, accessibleAssistant] }), SMOKE_REPLY)[0].strategy, "accessible-role-name");

  const testIdUser = new FixtureNode("div", { "data-testid": "conversation-turn-user" }, `TASK_ID: ${TASK_ID} NONCE: ${NONCE} COMMIT: ${COMMIT}`);
  const testIdAssistant = new FixtureNode("div", { "data-testid": "conversation-turn-assistant" }, SMOKE_REPLY);
  assert.equal(Locator.collectMessages(tierDocument({ stableIds: [testIdUser, testIdAssistant] }), SMOKE_REPLY)[0].strategy, "stable-testid");
});

test("bounded structural fallback remains capped and can recover the marked turns", () => {
  const user = new FixtureNode("section", {}, userMessage().innerText);
  const assistant = new FixtureNode("section", {}, SMOKE_REPLY);
  const result = Locator.recoverOriginal(tierDocument({ structural: [user, assistant] }), {
    request_id: "4754374f-14dd-4004-bf87-3b87972e17fa",
    task_id: TASK_ID,
    expected_commit: COMMIT,
    expected_reply: SMOKE_REPLY,
    nonce: NONCE, iteration: 3, original_message: userMessage().innerText, attempt: 1,
  });
  assert.equal(result.original_user_turn_found, true);
  assert.equal(result.subsequent_assistant_turn_found, true);
  assert.equal(result.assistant_reply_exact, true);
  assert.equal(result.selector_strategy, "bounded-structural-fallback;bounded-structural-fallback");
});

test("normalization collapses whitespace and canonical Unicode", () => {
  assert.equal(Locator.normalizeText("  Cafe\u0301\n\t prompt  "), "Café prompt");
});

test("TASK_ID, NONCE, and COMMIT must occur on the same user message", () => {
  const partialA = new FixtureNode("div", { "data-message-author-role": "user" }, `TASK_ID: ${TASK_ID} NONCE: ${NONCE}`);
  const partialB = new FixtureNode("div", { "data-message-author-role": "user" }, `COMMIT: ${COMMIT}`);
  assert.equal(Locator.findUserTurn(semanticDocument([partialA, partialB]), { task_id: TASK_ID, nonce: NONCE, commit: COMMIT }), null);
});

test("assistant reply binds to the first assistant after the matching user turn", () => {
  const earlierUser = userMessage({ nonce: OTHER_NONCE });
  const earlierAssistant = assistantMessage("Older response");
  const targetUser = userMessage();
  const targetAssistant = assistantMessage(SMOKE_REPLY);
  const foundUser = Locator.findUserTurn(semanticDocument([earlierUser, earlierAssistant, targetUser, targetAssistant]), {
    task_id: TASK_ID,
    nonce: NONCE,
    commit: COMMIT,
  }, SMOKE_REPLY);
  const foundAssistant = Locator.findAssistantAfter(semanticDocument([earlierUser, earlierAssistant, targetUser, targetAssistant]), foundUser, SMOKE_REPLY);
  assert.equal(foundAssistant?.node, targetAssistant);
});

test("a prior nonce cannot satisfy a newer request", () => {
  const prior = userMessage({ nonce: OTHER_NONCE });
  assert.equal(Locator.findUserTurn(semanticDocument([prior]), { task_id: TASK_ID, nonce: NONCE, commit: COMMIT }), null);
  assert.equal(Contract.decideSend({ userTurnFound: false, nonceObserved: false, maySend: false, composerText: "", staleDraftProven: false }), "uncertain-no-send");
});

test("a timeout after the real send remains resume-only and cannot send again", () => {
  const afterSend = Contract.decideSend({ userTurnFound: false, nonceObserved: false, maySend: false, composerText: "", staleDraftProven: false });
  assert.equal(afterSend, "uncertain-no-send");
  assert.notEqual(afterSend, "send-once");
});

test("original smoke recovery proves nonce, commit, following turn, and exact reply without sending", () => {
  const user = userMessage({ nested: true });
  const assistant = assistantMessage(SMOKE_REPLY);
  const proof = Locator.recoverOriginal(semanticDocument([user, assistant]), {
    request_id: "4754374f-14dd-4004-bf87-3b87972e17fa",
    task_id: TASK_ID,
    expected_commit: COMMIT,
    expected_reply: SMOKE_REPLY,
    nonce: NONCE, iteration: 3, original_message: userMessage().innerText, attempt: 1,
  });
  assert.equal(proof.request_id, "4754374f-14dd-4004-bf87-3b87972e17fa");
  assert.equal(proof.nonce, NONCE);
  assert.equal(proof.original_user_turn_found, true);
  assert.equal(proof.original_nonce_found, true);
  assert.equal(proof.original_commit_found, true);
  assert.equal(proof.subsequent_assistant_turn_found, true);
  assert.equal(proof.assistant_reply_exact, true);
  assert.equal(proof.raw_reply, SMOKE_REPLY);
});

test("Chrome unpacked package contains no Python source or bytecode runtime files", () => {
  const forbidden = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__pycache__") forbidden.push(fullPath);
        else walk(fullPath);
      } else if (/\.py(?:c|o)?$/iu.test(entry.name)) {
        forbidden.push(fullPath);
      }
    }
  };
  walk(extensionRoot);
  assert.deepEqual(forbidden, []);
});

function recoveryRequest(overrides = {}) {
  return { request_id: REQUEST_ID, task_id: TASK_ID, iteration: 3, nonce: NONCE,
    expected_commit: COMMIT, expected_reply: SMOKE_REPLY, original_message: userMessage().innerText,
    conversation_url: "https://chatgpt.com/c/offline-fixture", target_tab_id: 7, attempt: 1, ...overrides };
}

test("recovery rejects wrong nonce iteration commit request ID and task", () => {
  for (const overrides of [
    { nonce: OTHER_NONCE }, { iteration: 2 }, { expected_commit: "f".repeat(40) },
    { request_id: "11111111-1111-1111-1111-111111111111" }, { task_id: "other" },
    { original_message: userMessage().innerText + " extra" },
  ]) {
    const proof = Locator.recoverOriginal(semanticDocument([userMessage(), assistantMessage(SMOKE_REPLY)]), recoveryRequest(overrides));
    assert.equal(proof.original_user_turn_found, false);
  }
});
test("duplicate identity candidates fail closed", () => {
  const proof = Locator.recoverOriginal(semanticDocument([userMessage(), userMessage(), assistantMessage(SMOKE_REPLY)]), recoveryRequest());
  assert.equal(proof.original_user_turn_found, false);
});
test("recovery refuses missing trusted original markers", () => {
  for (const key of ["nonce", "iteration", "request_id", "original_message"]) {
    const r = recoveryRequest(); delete r[key];
    assert.equal(Locator.recoverOriginal(semanticDocument([userMessage(), assistantMessage(SMOKE_REPLY)]), r).original_user_turn_found, false);
  }
});
test("assistant cannot be borrowed across another user turn", () => {
  const proof = Locator.recoverOriginal(semanticDocument([userMessage(), userMessage({ nonce: OTHER_NONCE }), assistantMessage(SMOKE_REPLY)]), recoveryRequest());
  assert.equal(proof.subsequent_assistant_turn_found, false);
});
test("incomplete response has no completion proof even if text matches", () => {
  const assistant = assistantMessage(SMOKE_REPLY);
  delete assistant.attributes["data-message-status"];
  const proof = Locator.recoverOriginal(semanticDocument([userMessage(), assistant]), recoveryRequest());
  assert.equal(proof.assistant_reply_exact, true);
  assert.equal(proof.assistant_generation_complete, false);
  assistant.attributes["data-message-status"] = "streaming";
  assert.equal(Locator.recoverOriginal(semanticDocument([userMessage(), assistant]), recoveryRequest()).assistant_generation_complete, false);
});
test("visible generation evidence overrides a completion marker", () => {
  const doc = semanticDocument([userMessage(), assistantMessage(SMOKE_REPLY)]);
  const query = doc.querySelectorAll;
  doc.querySelectorAll = (s) => s === '[data-testid="stop-button"]' ? [new FixtureNode("button")] : query(s);
  assert.equal(Locator.recoverOriginal(doc, recoveryRequest()).assistant_generation_complete, false);
});
test("raw exact reply rule rejects whitespace and Unicode substitutions", () => {
  assert.equal(Contract.replyMatches(SMOKE_REPLY, SMOKE_REPLY), true);
  for (const actual of [" " + SMOKE_REPLY, SMOKE_REPLY + "\n", SMOKE_REPLY + "\r"]) {
    assert.equal(Contract.replyMatches(actual, SMOKE_REPLY), false);
  }
  assert.equal(Contract.replyMatches("Cafe\u0301", "Café"), false);
});
test("duplicate field values in one user node are not trusted", () => {
  const user = userMessage();
  user.ownText += "\nNONCE: " + OTHER_NONCE;
  assert.equal(Locator.recoverOriginal(semanticDocument([user, assistantMessage(SMOKE_REPLY)]), recoveryRequest()).original_user_turn_found, false);
});
test("precise URL validation rejects credentials ports query and fragment", () => {
  for (const url of ["https://user@chatgpt.com/c/x", "https://chatgpt.com:8443/c/x",
    "https://chatgpt.com/c/x?query=1", "https://chatgpt.com/c/x#x"]) assert.equal(Contract.isConversationUrl(url), false);
});

test("unknown intervening semantic turn prevents borrowing a later assistant", () => {
  const user = userMessage();
  const unknown = new FixtureNode("article", {}, "An unclassified intervening turn");
  const assistant = assistantMessage(SMOKE_REPLY);
  const proof = Locator.recoverOriginal(semanticDocument([user, unknown, assistant]), recoveryRequest());
  assert.equal(proof.subsequent_assistant_turn_found, false);
});
