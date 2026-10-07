const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const F = require("./offline_fixtures.cjs");
const ROOT = F.extensionRoot;
const URL_VALUE = "https://chatgpt.com/c/offline-fixture";
const component = { protocol_version: 2, version: "0.8.1", build_id: "c2c-v2-binding-diagnostic-1" };
const bridgeIdentity = { protocol_version: 2, bridge_version: "0.8.1", build_id: component.build_id,
  bridge_session_id: "offline-session", startup_source_sha256: "a".repeat(64), pid: 123,
  host: "127.0.0.1", port: 18796, extension_id: "offline-extension", mode: "normal" };
const clone = (v) => JSON.parse(JSON.stringify(v));
function request(overrides = {}) {
  return { request_id: F.REQUEST_ID, task_id: F.TASK_ID, iteration: 3, nonce: F.NONCE,
    expected_commit: F.COMMIT, target_tab_id: 7, conversation_url: URL_VALUE,
    original_message: F.userMessage().innerText, expected_reply: F.SMOKE_REPLY, attempt: 1, ...overrides };
}
function original(r = request()) {
  return { schema: 2, request_id: r.request_id, task_id: r.task_id, iteration: r.iteration, nonce: r.nonce,
    expected_commit: r.expected_commit, target_tab_id: r.target_tab_id, conversation_url: r.conversation_url,
    message: r.original_message };
}
function worker(options = {}) {
  let clock = 0;
  const wire = [], contentCalls = [], forbidden = [];
  const listeners = {};
  const data = { "c2c.targetTabId": 7, "c2c.targetConversationUrl.v2": URL_VALUE,
    "c2c.originalRequests.v2": { [F.REQUEST_ID]: original() },
    "c2c.seenNonces": [F.NONCE], ...clone(options.storage || {}) };
  const tabs = options.tabs || [{ id: 7, url: URL_VALUE, status: "complete" }];
  let gets = 0;
  const getTab = async (id) => {
    if (options.getTab) return options.getTab(id, gets++);
    const tab = tabs.find((t) => t.id === id); if (!tab) throw Error("missing"); return clone(tab);
  };
  const forbid = (op) => async () => { forbidden.push(op); throw Error("forbidden " + op); };
  const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  const sandbox = { URL, console, JSON, Map, Promise,
    Date: { now: () => clock },
    setTimeout(fn, ms) { clock += ms; queueMicrotask(fn); return 1; },
    clearTimeout() {}, setInterval() { return 1; }, clearInterval() {},
    fetch: forbid("fetch"),
    WebSocket: class { static OPEN = 1; static CONNECTING = 0; constructor() { throw Error("no real WS"); } },
    chrome: {
      runtime: { id: "offline-extension", getManifest: () => ({ version: options.manifestVersion || "0.8.1" }),
        onMessage: event("message"), onStartup: event("startup"), onInstalled: event("installed") },
      alarms: { create() {}, onAlarm: event("alarm") },
      tabs: { query: async () => clone(tabs), get: getTab, update: forbid("navigate"),
        reload: forbid("reload"), create: forbid("create"), onUpdated: event("updated"), onRemoved: event("removed"),
        async sendMessage(id, m) {
          contentCalls.push(clone({ id, ...m }));
          if (m.type === "C2C_PING") return options.ping === undefined
            ? { type: "C2C_V2_CONTENT_READY", ...component, url: tabs.find((t) => t.id === id)?.url || URL_VALUE }
            : options.ping;
          return { accepted: true };
        } },
      storage: { session: {
        async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((k) => [k, data[k] === undefined ? undefined : clone(data[k])])); },
        async set(values) { Object.assign(data, clone(values)); },
        async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k]; },
      } },
      scripting: { executeScript: forbid("inject") },
    },
  };
  const context = vm.createContext(sandbox);
  sandbox.importScripts = (...files) => {
    for (const file of files) vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), context, { filename: file });
  };
  sandbox.captureWire = (raw) => wire.push(JSON.parse(raw));
  let backgroundSource = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
  if (options.backgroundVersion) backgroundSource = backgroundSource.replace(
    'const ADAPTER_VERSION = "0.8.1";', 'const ADAPTER_VERSION = "' + options.backgroundVersion + '";');
  vm.runInContext(backgroundSource, context, { filename: "background.js" });
  sandbox.fixtureBridge = clone(bridgeIdentity);
  sandbox.fixtureContent = { type: "C2C_V2_CONTENT_READY", ...component, url: URL_VALUE };
  vm.runInContext('bridgeIdentity = fixtureBridge; contentIdentity = fixtureContent; targetTabId = 7; targetTabUrl = "' + URL_VALUE
    + '"; pinnedConversationUrl = targetTabUrl; tabReady = true; socket = { readyState: 1, send: captureWire };', context);
  return { context, data, wire, contentCalls, forbidden, listeners,
    run: (expression) => vm.runInContext(expression, context),
    call(name, ...args) { sandbox.args = args; return vm.runInContext(name + "(...args)", context); },
    clock: () => clock };
}
function content(nodes, options = {}) {
  let clock = 0;
  const sent = [], forbidden = [];
  let listener;
  class FakeTextArea {
    constructor() { this._value = ""; this.isConnected = true; this.disabled = false; }
    get value() { return this._value; }
    set value(value) { this._value = value; }
    focus() {}
    dispatchEvent() {}
    getBoundingClientRect() { return { width: 100, height: 30 }; }
    getAttribute() { return null; }
  }
  class FakeInput extends FakeTextArea {}
  const composer = new FakeTextArea();
  let clicks = 0;
  const document = F.semanticDocument(nodes);
  const sendButton = { isConnected: true, disabled: false, getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 30, height: 30 }),
    click() {
      clicks += 1;
      const user = new F.FixtureNode("div", { "data-message-author-role": "user" }, composer.value);
      const assistant = F.assistantMessage(options.replyText || F.SMOKE_REPLY);
      user.parentElement = assistant.parentElement = document.querySelector("main");
      nodes.push(user, assistant);
      composer.value = "";
      if (options.afterSend) options.afterSend(sandbox);
    } };
  const originalQuery = document.querySelectorAll;
  document.querySelectorAll = (selector) => {
    if (options.allowComposer && selector === '[data-testid="prompt-textarea"]') return [composer];
    if (options.allowComposer && selector === 'button[data-testid="send-button"]') return [sendButton];
    if (/prompt-textarea|textbox|textarea|Send/u.test(selector)) { forbidden.push(selector); throw Error("composer or send inspected"); }
    return originalQuery(selector);
  };
  document.execCommand = () => { forbidden.push("execCommand"); throw Error("DOM write"); };
  const sandbox = {
    URL, console, Map, Promise, document, location: { href: options.url || URL_VALUE },
    HTMLTextAreaElement: FakeTextArea, HTMLInputElement: FakeInput,
    InputEvent: class {}, Event: class {},
    Date: { now: () => clock },
    setTimeout(fn, ms) { clock += ms; if (options.onSleep) options.onSleep(sandbox, clock); queueMicrotask(fn); },
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    chrome: { runtime: {
      onMessage: { addListener(fn) { listener = fn; }, removeListener() {} },
      async sendMessage(m) { sent.push(clone(m)); },
    } },
  };
  const context = vm.createContext(sandbox);
  for (const file of ["component_identity.js", "adapter_contract.js", "transcript_locator.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), context);
  }
  if (options.oldLocator) sandbox.C2CV2TranscriptLocator.version = "0.4.0";
  vm.runInContext(fs.readFileSync(path.join(ROOT, "content.js"), "utf8"), context, { filename: "content.js" });
  listener({ type: "C2C_PING", target_tab_id: 7 }, {}, () => {});
  return {
    sent, forbidden, clock: () => clock, clicks: () => clicks, sandbox,
    message(m) { let response; listener(m, {}, (r) => { response = r; }); return response; },
    async settle(count = 700) { for (let i = 0; i < count; i++) await Promise.resolve(); },
  };
}
test("worker recovery uses only DOM recovery and preserves original identity registry", async () => {
  const w = worker();
  const before = clone(w.data);
  w.run('dispatchRequest = () => { throw Error("normal send path invoked"); };');
  await w.call("dispatchOriginalRecovery", request());
  assert.deepEqual(w.contentCalls.map((c) => c.type), ["C2C_PING", "C2C_RECOVER_ORIGINAL"]);
  assert.deepEqual(w.data, before);
  assert.deepEqual(w.forbidden, []);
  assert.equal(w.wire.some((m) => m.type === "review"), false);
  await w.call("dispatchOriginalRecovery", request());
  assert.equal(w.contentCalls.filter((c) => c.type === "C2C_RECOVER_ORIGINAL").length, 1);
});
for (const [label, change] of Object.entries({
  nonce: { nonce: F.OTHER_NONCE }, iteration: { iteration: 2 }, commit: { expected_commit: "f".repeat(40) },
  url: { conversation_url: URL_VALUE + "other" }, tab: { target_tab_id: 8 },
  id: { request_id: "11111111-1111-1111-1111-111111111111" }, message: { original_message: "changed" },
})) {
  test("worker rejects wrong recovery " + label, async () => {
    const w = worker(); await w.call("dispatchOriginalRecovery", request(change));
    assert.equal(w.wire.at(-1).type, "recovery_error");
    assert.equal(w.contentCalls.length, 0);
    assert.deepEqual(w.forbidden, []);
  });
}
test("worker rejects unknown ID and missing evidence without adopting request metadata", async () => {
  for (const key of ["nonce", "iteration", "expected_commit", "conversation_url", "target_tab_id", "message"]) {
    const o = original(); delete o[key];
    const w = worker({ storage: { "c2c.originalRequests.v2": { [F.REQUEST_ID]: o } } });
    await w.call("dispatchOriginalRecovery", request());
    assert.equal(w.contentCalls.length, 0);
    assert.equal(w.wire.at(-1).error_code, "original_identity_mismatch");
  }
});
test("worker rejects duplicate URL candidates", async () => {
  const w = worker({ tabs: [{ id: 7, url: URL_VALUE }, { id: 8, url: URL_VALUE }] });
  await w.call("dispatchOriginalRecovery", request());
  assert.equal(w.wire.at(-1).error_code, "conversation_binding_mismatch");
  assert.equal(w.contentCalls.length, 0);
});
test("active page cannot replace pinned target and removed target stays pinned", async () => {
  const w = worker({ tabs: [{ id: 8, url: "https://chatgpt.com/c/active", active: true }] });
  assert.equal(await w.call("findOrCreateTarget"), null);
  w.listeners.removed(7); await Promise.resolve();
  assert.equal(w.data["c2c.targetTabId"], 7);
  assert.equal(w.run("targetTabId"), 7);
  assert.deepEqual(w.forbidden, []);
});
test("content ready with missing tab does not dereference null or change binding", async () => {
  const w = worker({ tabs: [] });
  await w.call("handleContentMessage", { type: "C2C_CONTENT_READY", ...component, url: URL_VALUE },
    { id: "offline-extension", tab: { id: 7 }, url: URL_VALUE });
  assert.equal(w.run("tabReady"), false);
  assert.equal(w.run("targetTabId"), 7);
});
test("wait tolerates previous URL while loading but never navigates", async () => {
  const w = worker({ getTab: (id, index) => ({ id, url: index === 0 ? "https://chatgpt.com/" : URL_VALUE,
    status: index === 0 ? "loading" : "complete" }) });
  const result = await w.call("waitForConversationTabReady", 7, URL_VALUE, 1000);
  assert.equal(result.id, 7);
  assert.ok(w.clock() >= 250);
  assert.deepEqual(w.forbidden, []);
});
test("wait rejects complete wrong URL and expires on a perpetually loading tab", async () => {
  const wrong = worker({ getTab: (id) => ({ id, url: URL_VALUE + "other", status: "complete" }) });
  assert.equal(await wrong.call("waitForConversationTabReady", 7, URL_VALUE, 1000), null);
  const loading = worker({ getTab: (id) => ({ id, url: "https://chatgpt.com/", status: "loading" }) });
  assert.equal(await loading.call("waitForConversationTabReady", 7, URL_VALUE, 1000), null);
  assert.equal(loading.clock(), 1000);
});
for (const [label, option] of Object.entries({
  oldStringContent: { ping: "C2C_V2_CONTENT_READY" },
  oldContent: { ping: { type: "C2C_V2_CONTENT_READY", ...component, version: "0.4.0", url: URL_VALUE } },
  wrongBuild: { ping: { type: "C2C_V2_CONTENT_READY", ...component, build_id: "old", url: URL_VALUE } },
  oldManifest: { manifestVersion: "0.1.1" },
})) {
  test("mixed components are never ready: " + label, async () => {
    const w = worker(option);
    assert.equal(await w.call("ensureContentScript", { id: 7, url: URL_VALUE }), false);
    assert.equal(w.run("tabReady"), false);
    assert.equal(w.wire.at(-1).connected, false);
  });
}
test("old bridge and old background declarations cannot report readiness", async () => {
  const w = worker();
  w.run('bridgeIdentity.bridge_version = "0.4.0";');
  assert.equal(await w.call("ensureContentScript", { id: 7, url: URL_VALUE }), false);
  const b = worker(); b.run('bridgeIdentity.build_id = "old";');
  assert.equal(await b.call("ensureContentScript", { id: 7, url: URL_VALUE }), false);
});
test("worker verifies extraction URL sender URL current URL and native tab ID", async () => {
  for (const change of [
    { conversation_url: URL_VALUE + "other" }, { nonce: F.OTHER_NONCE }, { iteration: 2 },
    { expected_commit: "f".repeat(40) }, { content_identity: { ...component, version: "0.4.0" } },
  ]) {
    const w = worker(); await w.call("dispatchOriginalRecovery", request());
    await w.call("handleContentMessage", { type: "C2C_RECOVERY_RESULT", ...request(),
      content_identity: component, ...change }, { id: "offline-extension", tab: { id: 7 }, url: URL_VALUE });
    assert.equal(w.wire.at(-1).type, "recovery_error");
  }
  const w = worker(); await w.call("dispatchOriginalRecovery", request());
  await w.call("handleContentMessage", { type: "C2C_RECOVERY_RESULT", ...request(), content_identity: component },
    { id: "offline-extension", tab: { id: 8 }, url: URL_VALUE });
  assert.equal(w.wire.some((m) => m.type === "recovery_result"), false);
});
test("worker forwards original extraction URL without replacing it by another current URL", async () => {
  const w = worker(); await w.call("dispatchOriginalRecovery", request());
  const m = { type: "C2C_RECOVERY_RESULT", ...request(), content_identity: component, raw_reply: F.SMOKE_REPLY };
  await w.call("handleContentMessage", m, { id: "offline-extension", tab: { id: 7 }, url: URL_VALUE });
  assert.equal(w.wire.at(-1).conversation_url, URL_VALUE);
  assert.equal(w.wire.at(-1).tab_id, 7);
});
test("content recovery confirms positive completion plus four stable samples without composer access", async () => {
  const c = content([F.userMessage(), F.assistantMessage(F.SMOKE_REPLY)]);
  c.message({ type: "C2C_RECOVER_ORIGINAL", request: request() });
  await c.settle();
  const result = c.sent.find((m) => m.type === "C2C_RECOVERY_RESULT");
  assert.equal(result.assistant_generation_complete, true);
  assert.equal(result.assistant_reply_exact, true);
  assert.equal(result.raw_reply, F.SMOKE_REPLY);
  assert.ok(c.clock() >= 1500);
  assert.deepEqual(c.forbidden, []);
});
test("content refuses incomplete reply even with matching text", async () => {
  const assistant = F.assistantMessage(F.SMOKE_REPLY);
  delete assistant.attributes["data-message-status"];
  const c = content([F.userMessage(), assistant]);
  c.message({ type: "C2C_RECOVER_ORIGINAL", request: request() });
  await c.settle();
  assert.equal(c.sent.at(-1).error_code, "assistant_completion_unconfirmed");
  assert.deepEqual(c.forbidden, []);
});
test("content refuses navigation during completion sampling", async () => {
  const c = content([F.userMessage(), F.assistantMessage(F.SMOKE_REPLY)],
    { onSleep(s) { s.location.href = URL_VALUE + "other"; } });
  c.message({ type: "C2C_RECOVER_ORIGINAL", request: request() });
  await c.settle();
  assert.equal(c.sent.at(-1).error_code, "conversation_binding_mismatch");
});
test("new content with old locator cannot claim ready", () => {
  const c = content([], { oldLocator: true });
  const pong = c.message({ type: "C2C_PING", target_tab_id: 7 });
  assert.equal(pong.version, "");
  assert.equal(pong.build_id, "");
});
test("content recovery rejects wrong URL and tab ID before inspecting transcript", async () => {
  for (const change of [{ target_tab_id: 8 }, { conversation_url: URL_VALUE + "other" }]) {
    const c = content([F.userMessage(), F.assistantMessage(F.SMOKE_REPLY)]);
    c.message({ type: "C2C_RECOVER_ORIGINAL", request: request(change) });
    await c.settle();
    assert.equal(c.sent.at(-1).error_code, "recovery_request_invalid");
    assert.deepEqual(c.forbidden, []);
  }
});
test("manifest source ordering versions permissions and build identities are consistent", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, component.version);
  assert.deepEqual(manifest.content_scripts[0].js,
    ["component_identity.js", "adapter_contract.js", "transcript_locator.js", "content.js"]);
  for (const file of manifest.content_scripts[0].js) assert.equal(fs.existsSync(path.join(ROOT, file)), true);
  const bridge = fs.readFileSync(path.join(ROOT, "..", "bridge", "bridge_server.py"), "utf8");
  assert.ok(bridge.includes('COMPONENT_VERSION = "' + component.version + '"'));
  assert.ok(bridge.includes('BUILD_ID = "' + component.build_id + '"'));
});

test("an old background mixed with new helpers content manifest and bridge is not ready", async () => {
  const w = worker({ backgroundVersion: "0.4.0" });
  assert.equal(await w.call("ensureContentScript", { id: 7, url: URL_VALUE }), false);
  assert.equal(w.run("tabReady"), false);
  assert.equal(w.wire.at(-1).connected, false);
});
test("bridge session identity and startup hash are mandatory for readiness", async () => {
  for (const expression of ['bridgeIdentity.startup_source_sha256 = "";', 'bridgeIdentity.bridge_session_id = "";']) {
    const w = worker(); w.run(expression);
    assert.equal(await w.call("ensureContentScript", { id: 7, url: URL_VALUE }), false);
  }
});
test("content returns negative proof for duplicate matching users without sending", async () => {
  const c = content([F.userMessage(), F.userMessage(), F.assistantMessage(F.SMOKE_REPLY)]);
  c.message({ type: "C2C_RECOVER_ORIGINAL", request: request() }); await c.settle();
  assert.equal(c.sent.at(-1).original_user_turn_found, false);
  assert.deepEqual(c.forbidden, []);
});
test("content preserves exact raw mismatch instead of trimming it into success", async () => {
  const c = content([F.userMessage(), F.assistantMessage(" " + F.SMOKE_REPLY)]);
  c.message({ type: "C2C_RECOVER_ORIGINAL", request: request() }); await c.settle();
  assert.equal(c.sent.at(-1).assistant_reply_exact, false);
  assert.equal(c.sent.at(-1).raw_reply, " " + F.SMOKE_REPLY);
});

test("JS reply matcher passes the same vectors as Python", () => {
  const w = worker();
  for (const v of JSON.parse(fs.readFileSync(path.join(__dirname, "reply_match_vectors.json"), "utf8"))) {
    assert.equal(w.call("Contract.replyMatches", v.actual, v.expected), v.matches);
  }
});
test("normal dispatch retains its original registry after acknowledgement", async () => {
  const w = worker();
  await w.call("handleWireMessage", JSON.stringify({ type: "result_ack", request_id: F.REQUEST_ID }));
  assert.equal(w.data["c2c.originalRequests.v2"][F.REQUEST_ID].nonce, F.NONCE);
});
test("copy-action completion is positive evidence and active busy status still rejects it", () => {
  const assistant = F.assistantMessage(F.SMOKE_REPLY);
  delete assistant.attributes["data-message-status"];
  const copy = new F.FixtureNode("button");
  assistant.querySelectorAll = () => [copy];
  const c = content([F.userMessage(), assistant]);
  const locator = c.sandbox.C2CV2TranscriptLocator;
  assert.equal(locator.isAssistantComplete(F.semanticDocument([assistant]), { node: assistant }), true);
  assistant.attributes["aria-busy"] = "true";
  assert.equal(locator.isAssistantComplete(F.semanticDocument([assistant]), { node: assistant }), false);
});

test("new normal root-to-conversation binding verifies content before recording its first exact URL", async () => {
  const o = original(); o.conversation_url = "";
  const w = worker({ storage: { "c2c.originalRequests.v2": { [F.REQUEST_ID]: o } } });
  w.run('pinnedConversationUrl = ""; targetTabUrl = "https://chatgpt.com/";');
  await w.call("handleContentMessage", { type: "C2C_REVIEW_BOUND", ...request(), conversation_url: URL_VALUE },
    { id: "offline-extension", tab: { id: 7 }, url: URL_VALUE });
  assert.equal(w.data["c2c.originalRequests.v2"][F.REQUEST_ID].conversation_url, URL_VALUE);
  assert.equal(w.wire.at(-1).type, "review_bound");
  assert.equal(w.wire.at(-2).connected, true);
  assert.deepEqual(w.forbidden, []);
});
test("new binding cannot be confirmed by an old content component", async () => {
  const o = original(); o.conversation_url = "";
  const w = worker({ ping: "C2C_V2_CONTENT_READY",
    storage: { "c2c.originalRequests.v2": { [F.REQUEST_ID]: o } } });
  w.run('pinnedConversationUrl = ""; targetTabUrl = "https://chatgpt.com/";');
  await w.call("handleContentMessage", { type: "C2C_REVIEW_BOUND", ...request(), conversation_url: URL_VALUE },
    { id: "offline-extension", tab: { id: 7 }, url: URL_VALUE });
  assert.equal(w.data["c2c.originalRequests.v2"][F.REQUEST_ID].conversation_url, "");
  assert.equal(w.wire.some((m) => m.type === "review_bound"), false);
});

test("recovery with missing content never injects or upgrades code", async () => {
  const w = worker({ ping: null });
  await w.call("dispatchOriginalRecovery", request());
  assert.equal(w.wire.at(-1).error_code, "component_version_mismatch");
  assert.equal(w.contentCalls.some((m) => m.type === "C2C_RECOVER_ORIGINAL"), false);
  assert.deepEqual(w.forbidden, []);
});

const inspectionFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "legacy_inspection_fixture.json"), "utf8"));
function inspectionRequest(overrides = {}) { return { ...inspectionFixture, ...overrides }; }
function legacyUser(nonce = F.NONCE) {
  return new F.FixtureNode("div", { "data-message-author-role": "user" },
    inspectionFixture.original_message_template.replace("__OBSERVED_NONCE__", nonce));
}
test("inspection reads legacy message candidates without claiming original nonce verification", async () => {
  const c = content([legacyUser(), F.assistantMessage(F.SMOKE_REPLY)]);
  c.message({ type: "C2C_INSPECT_ORIGINAL", request: inspectionRequest() }); await c.settle();
  const m = c.sent.at(-1);
  assert.equal(m.candidate_count, 1);
  assert.equal(m.candidates[0].nonce, F.NONCE);
  assert.equal(m.candidates[0].reply_exact_observed, true);
  assert.equal(m.original_nonce_verified, undefined);
  assert.deepEqual(c.forbidden, []);
});
test("inspection reports duplicate candidates without selecting a nonce authority", async () => {
  const c = content([legacyUser(), F.assistantMessage(F.SMOKE_REPLY), legacyUser(F.OTHER_NONCE), F.assistantMessage(F.SMOKE_REPLY)]);
  c.message({ type: "C2C_INSPECT_ORIGINAL", request: inspectionRequest() }); await c.settle();
  assert.equal(c.sent.at(-1).candidate_count, 2);
  assert.equal(c.sent.at(-1).recovered_original, undefined);
});
test("inspection does not borrow reply across another user", async () => {
  const c = content([legacyUser(), F.userMessage({ nonce: F.OTHER_NONCE }), F.assistantMessage(F.SMOKE_REPLY)]);
  c.message({ type: "C2C_INSPECT_ORIGINAL", request: inspectionRequest() }); await c.settle();
  assert.equal(c.sent.at(-1).candidates[0].reply_exact_observed, false);
});
test("inspection rejects wrong commit iteration message and URL", async () => {
  for (const changes of [{ expected_commit: "f".repeat(40) }, { iteration: 2 },
    { original_message_template: "wrong __OBSERVED_NONCE__" }]) {
    const c = content([legacyUser(), F.assistantMessage(F.SMOKE_REPLY)]);
    c.message({ type: "C2C_INSPECT_ORIGINAL", request: inspectionRequest(changes) }); await c.settle();
    assert.equal(c.sent.at(-1).candidate_count, 0);
  }
  const c = content([legacyUser()]);
  c.message({ type: "C2C_INSPECT_ORIGINAL", request: inspectionRequest({ conversation_url: URL_VALUE + "other" }) }); await c.settle();
  assert.equal(c.sent.at(-1).error_code, "inspection_request_invalid");
});
test("inspection too many candidates fails boundedly", async () => {
  const c = content(Array.from({ length: 5 }, () => legacyUser()));
  c.message({ type: "C2C_INSPECT_ORIGINAL", request: inspectionRequest() }); await c.settle();
  assert.equal(c.sent.at(-1).error_code, "inspection_too_many_candidates");
});
test("worker inspection calls neither normal send nor recovery and leaves storage and pin unchanged", async () => {
  const w = worker(); const before = clone(w.data);
  w.run('dispatchRequest = () => { throw Error("send"); }; dispatchOriginalRecovery = () => { throw Error("recover"); };');
  await w.call("dispatchInspection", inspectionRequest());
  assert.deepEqual(w.contentCalls.map((c) => c.type), ["C2C_PING", "C2C_INSPECT_ORIGINAL"]);
  assert.deepEqual(w.data, before);
  assert.deepEqual(w.forbidden, []);
  assert.equal(w.run("targetTabId"), 7);
});
test("inspection can observe explicit historical tab without changing normal target", async () => {
  const other = "https://chatgpt.com/c/other";
  const w = worker({ tabs: [{ id: 7, url: other, status: "complete" }, { id: 8, url: URL_VALUE, status: "complete" }],
    storage: { "c2c.targetConversationUrl.v2": other } });
  w.run('targetTabUrl = "https://chatgpt.com/c/other"; pinnedConversationUrl = targetTabUrl;');
  const before = clone(w.data);
  await w.call("dispatchInspection", inspectionRequest({ target_tab_id: 8 }));
  assert.equal(w.contentCalls.at(-1).id, 8);
  assert.equal(w.run("targetTabId"), 7);
  assert.deepEqual(w.data, before);
});
test("inspection mismatched tab duplicate URL or old component never navigates or injects", async () => {
  for (const options of [
    { tabs: [{ id: 8, url: URL_VALUE, status: "complete" }] },
    { tabs: [{ id: 7, url: URL_VALUE, status: "complete" }, { id: 8, url: URL_VALUE, status: "complete" }] },
    { ping: "C2C_V2_CONTENT_READY" },
    { ping: { type: "C2C_V2_CONTENT_READY", ...component, version: "0.5.0", url: URL_VALUE } },
  ]) {
    const w = worker(options); await w.call("dispatchInspection", inspectionRequest());
    assert.equal(w.wire.at(-1).type, "inspection_error");
    assert.deepEqual(w.forbidden, []);
    assert.equal(w.contentCalls.some((c) => c.type === "C2C_INSPECT_ORIGINAL"), false);
  }
});
test("binding diagnostics are scoped bounded deterministic and never mutate a pin or request history", async () => {
  const cases = [
    { tabs: [], reason: "no_matching_conversation_tab", count: 0 },
    { tabs: [{ id: 8, url: URL_VALUE, status: "complete" }], reason: "historical_tab_id_mismatch", count: 1 },
    { tabs: [{ id: 7, url: URL_VALUE, status: "loading" }], reason: "original_tab_not_complete", count: 1 },
    { tabs: [{ id: 7, url: URL_VALUE }], reason: "original_tab_not_complete", count: 1 },
    { tabs: [{ id: 8, url: URL_VALUE, status: "complete" }, { id: 7, url: URL_VALUE, status: "complete" }], reason: "duplicate_conversation_tabs", count: 2 },
    { tabs: Array.from({ length: 6 }, (_, i) => ({ id: 12 - i, url: URL_VALUE, status: "complete" })), reason: "duplicate_conversation_tabs", count: 6 },
  ];
  for (const item of cases) {
    const unrelated = { id: 100, url: "https://chatgpt.com/c/private-unrelated", status: "complete", title: "private title", active: true };
    const w = worker({ tabs: [...item.tabs, unrelated] });
    const before = clone(w.data);
    await w.call("dispatchInspection", inspectionRequest());
    const message = w.wire.at(-1), d = message.binding_diagnostic;
    assert.equal(message.error_code, "inspection_binding_unconfirmed");
    assert.equal(d.reason, item.reason);
    assert.equal(d.matching_tab_count, item.count);
    assert.equal(d.matching_tabs.length, Math.min(item.count, 4));
    assert.equal(d.truncated, item.count > 4);
    assert.equal(d.authoritative, false);
    assert.equal(d.requested_tab_id, 7);
    assert.equal(d.exact_url, URL_VALUE);
    assert.equal(JSON.stringify(d).includes("private"), false);
    assert.equal(d.matching_tabs.every((t) => t.url === URL_VALUE && !Object.hasOwn(t, "title") && !Object.hasOwn(t, "active")), true);
    assert.deepEqual([...d.matching_tabs].map((t) => t.tab_id), item.tabs.map((t) => t.id).sort((a, b) => a - b).slice(0, 4));
    assert.deepEqual(w.data, before);
    assert.equal(w.run("targetTabId"), 7);
    assert.equal(w.run("pinnedConversationUrl"), URL_VALUE);
    assert.deepEqual(w.contentCalls, []);
    assert.deepEqual(w.forbidden, []);
  }
});

test("binding diagnostics do not select a nonce or permit the send or recovery paths", async () => {
  const w = worker({ tabs: [{ id: 8, url: URL_VALUE, status: "complete" }] });
  w.run('dispatchRequest = () => { throw Error("send"); }; dispatchOriginalRecovery = () => { throw Error("recover"); };');
  await w.call("dispatchInspection", inspectionRequest());
  assert.equal(w.wire.at(-1).binding_diagnostic.reason, "historical_tab_id_mismatch");
  assert.equal(Object.hasOwn(w.wire.at(-1), "nonce"), false);
  assert.deepEqual(w.contentCalls, []);
});

test("inspection user-message whitespace folding accepts a rendered line-wrapped legacy control turn", async () => {
  const text = inspectionFixture.original_message_template.replace("__OBSERVED_NONCE__", F.NONCE).split(/\s+/u).join(" \n\t");
  const user = new F.FixtureNode("div", { "data-message-author-role": "user" }, text);
  const c = content([user, F.assistantMessage(F.SMOKE_REPLY)]);
  c.message({ type: "C2C_INSPECT_ORIGINAL", request: inspectionRequest() }); await c.settle();
  assert.equal(c.sent.at(-1).candidate_count, 1);
  assert.equal(c.sent.at(-1).candidates[0].reply_exact_observed, true);
  assert.deepEqual(c.forbidden, []);
});

test("inspection result is marked unverified by worker even if content claimed authority", async () => {
  const w = worker(); await w.call("dispatchInspection", inspectionRequest());
  await w.call("handleContentMessage", { type: "C2C_INSPECTION_RESULT", ...inspectionRequest(),
    content_identity: component, candidates: [], candidate_count: 0, authoritative: true, recovered_original: true },
    { id: "offline-extension", tab: { id: 7 }, url: URL_VALUE });
  const result = w.wire.at(-1);
  assert.equal(result.type, "inspection_result");
  assert.equal(result.authoritative, false);
  assert.equal(result.recovered_original, false);
  assert.equal(result.original_nonce_verified, false);
});
test("inspection rejects result from wrong sender native tab URL identity or version", async () => {
  for (const change of [{ iteration: 2 }, { expected_commit: "f".repeat(40) },
    { conversation_url: URL_VALUE + "other" }, { content_identity: { ...component, version: "0.5.0" } }]) {
    const w = worker(); await w.call("dispatchInspection", inspectionRequest());
    await w.call("handleContentMessage", { type: "C2C_INSPECTION_RESULT", ...inspectionRequest(), content_identity: component, ...change },
      { id: "offline-extension", tab: { id: 7 }, url: URL_VALUE });
    assert.equal(w.wire.at(-1).type, "inspection_error");
  }
});


function normalRequest(overrides = {}) {
  const r = request();
  return { ...r, message: r.original_message, ...overrides };
}
function normalResult(overrides = {}) {
  return { type: "C2C_REVIEW_RESULT", ...request(), raw_reply: "  Cafe\u0301\r\n",
    content_identity: component, assistant_generation_complete: true,
    reply_match_rule: "raw-exact-v1", ...overrides };
}
const normalSender = { id: "offline-extension", tab: { id: 7 }, url: URL_VALUE };

test("normal resume preserves whole user identity raw reply and positive completion", async () => {
  const raw = "  Cafe\u0301\r\n";
  const c = content([F.userMessage(), F.assistantMessage(raw)]);
  c.message({ type: "C2C_REVIEW", request: normalRequest(), may_send: false });
  await c.settle();
  const result = c.sent.find((m) => m.type === "C2C_REVIEW_RESULT");
  assert.equal(result.raw_reply, raw);
  assert.equal(result.assistant_generation_complete, true);
  assert.equal(result.reply_match_rule, "raw-exact-v1");
  assert.equal(result.content_identity.version, component.version);
  assert.equal(result.conversation_url, URL_VALUE);
  assert.deepEqual(c.forbidden, []);
});
test("normal extraction rejects wrong tab URL and mixed content before transcript access", async () => {
  for (const change of [{ target_tab_id: 8 }, { conversation_url: URL_VALUE + "-other" }]) {
    const c = content([F.userMessage(), F.assistantMessage(F.SMOKE_REPLY)]);
    c.message({ type: "C2C_REVIEW", request: normalRequest(change), may_send: false });
    await c.settle();
    assert.equal(c.sent.at(-1).error_code, "conversation_binding_mismatch");
    assert.deepEqual(c.forbidden, []);
  }
  const c = content([F.userMessage(), F.assistantMessage(F.SMOKE_REPLY)], { oldLocator: true });
  c.message({ type: "C2C_REVIEW", request: normalRequest(), may_send: false });
  await c.settle();
  assert.equal(c.sent.at(-1).error_code, "conversation_binding_mismatch");
});
test("normal reply cannot cross another user or accept incomplete generation", async () => {
  const streaming = F.assistantMessage(F.SMOKE_REPLY); streaming.attributes["data-message-status"] = "streaming";
  for (const nodes of [
    [F.userMessage(), F.userMessage({ nonce: F.OTHER_NONCE }), F.assistantMessage(F.SMOKE_REPLY)],
    [F.userMessage(), streaming],
  ]) {
    const c = content(nodes);
    c.message({ type: "C2C_REVIEW", request: normalRequest(), may_send: false });
    await c.settle(15000);
    const result = c.sent.find((m) => m.type === "C2C_REVIEW_RESULT");
    assert.equal(result.error_code, "assistant_turn_timeout");
    assert.equal(result.raw_reply, undefined);
    assert.deepEqual(c.forbidden, []);
  }
});
test("normal extraction rejects navigation during completed samples", async () => {
  const c = content([F.userMessage(), F.assistantMessage(F.SMOKE_REPLY)], {
    onSleep(sandbox) { sandbox.location.href = URL_VALUE + "-other"; },
  });
  c.message({ type: "C2C_REVIEW", request: normalRequest(), may_send: false });
  await c.settle();
  assert.equal(c.sent.at(-1).error_code, "conversation_binding_mismatch");
});
test("normal worker and bridge envelope retains raw reply version URL tab and completion proof", async () => {
  const w = worker();
  await w.call("handleContentMessage", normalResult(), normalSender);
  const result = w.wire.at(-1);
  assert.equal(result.type, "review_result");
  assert.equal(result.raw_reply, "  Cafe\u0301\r\n");
  assert.equal(result.tab_id, 7);
  assert.equal(result.conversation_url, URL_VALUE);
  assert.equal(result.assistant_generation_complete, true);
  assert.equal(result.content_identity.version, component.version);
});
test("normal worker rejects wrong extraction URL completion version and duplicate targets", async () => {
  for (const change of [
    { conversation_url: URL_VALUE + "-other" }, { assistant_generation_complete: false },
    { reply_match_rule: "trimmed" }, { content_identity: { ...component, version: "0.3.0" } },
  ]) {
    const w = worker();
    await w.call("handleContentMessage", normalResult(change), normalSender);
    assert.equal(w.wire.at(-1).type, "review_error");
    assert.equal(w.data["c2c.lastResult"], undefined);
  }
  const w = worker({ tabs: [{ id: 7, url: URL_VALUE, status: "complete" }, { id: 8, url: URL_VALUE, status: "complete" }] });
  await w.call("handleContentMessage", normalResult(), normalSender);
  assert.equal(w.wire.at(-1).type, "review_error");
  assert.equal(w.data["c2c.lastResult"], undefined);
});
test("normal worker rejects wrong sender/current URL without storing result", async () => {
  for (const sender of [
    { ...normalSender, tab: { id: 8 } }, { ...normalSender, url: URL_VALUE + "-other" },
  ]) {
    const w = worker();
    await w.call("handleContentMessage", normalResult(), sender);
    assert.equal(w.wire.some((m) => m.type === "review_result"), false);
    assert.equal(w.data["c2c.lastResult"], undefined);
  }
  const w = worker({ tabs: [{ id: 7, url: URL_VALUE + "-other", status: "complete" }] });
  await w.call("handleContentMessage", normalResult(), normalSender);
  assert.equal(w.wire.at(-1).type, "review_error");
});
test("normal resume uses saved first binding and cannot send again", async () => {
  const w = worker();
  await w.call("dispatchRequest", normalRequest({ conversation_url: "" }), true);
  const sent = w.contentCalls.find((m) => m.type === "C2C_REVIEW");
  assert.equal(sent.request.conversation_url, URL_VALUE);
  assert.equal(sent.request.nonce, F.NONCE);
  assert.equal(sent.may_send, false);
  assert.deepEqual(w.forbidden, []);
});
test("normal dispatch rejects duplicate URL and changed saved binding before storage writes", async () => {
  for (const options of [
    { tabs: [{ id: 7, url: URL_VALUE, status: "complete" }, { id: 8, url: URL_VALUE, status: "complete" }] },
    {},
  ]) {
    const w = worker(options); const before = clone(w.data);
    await w.call("dispatchRequest", normalRequest(options.tabs ? {} : { conversation_url: URL_VALUE + "-other" }), true);
    assert.equal(w.wire.at(-1).error_code, "conversation_binding_mismatch");
    assert.deepEqual(w.data, before);
    assert.equal(w.contentCalls.some((m) => m.type === "C2C_REVIEW"), false);
    assert.deepEqual(w.forbidden, []);
  }
});


test("normal new send performs exactly one mock click then resumes without a second send", async () => {
  const nodes = [];
  const c = content(nodes, { allowComposer: true, url: "https://chatgpt.com/",
    afterSend(sandbox) { sandbox.location.href = URL_VALUE; } });
  const r = normalRequest({ conversation_url: "" });
  c.message({ type: "C2C_REVIEW", request: r, may_send: true });
  await c.settle();
  assert.equal(c.clicks(), 1);
  assert.equal(c.sent.find((m) => m.type === "C2C_REVIEW_RESULT").raw_reply, F.SMOKE_REPLY);
  assert.equal(c.sent.find((m) => m.type === "C2C_REVIEW_BOUND").conversation_url, URL_VALUE);
  c.message({ type: "C2C_REVIEW", request: { ...r, conversation_url: URL_VALUE }, may_send: false });
  await c.settle();
  assert.equal(c.clicks(), 1);
  assert.equal(c.sent.filter((m) => m.type === "C2C_REVIEW_RESULT").length, 2);
});
test("normal fresh dispatch records one identity and duplicate dispatch becomes resume-only", async () => {
  const w = worker({ storage: { "c2c.originalRequests.v2": {}, "c2c.seenNonces": [] } });
  const r = normalRequest();
  await w.call("dispatchRequest", r, false);
  await w.call("dispatchRequest", r, false);
  const calls = w.contentCalls.filter((m) => m.type === "C2C_REVIEW");
  assert.deepEqual(calls.map((m) => m.may_send), [true, false]);
  assert.equal(w.data["c2c.originalRequests.v2"][F.REQUEST_ID].nonce, F.NONCE);
  assert.deepEqual(w.data["c2c.seenNonces"], [F.NONCE]);
  assert.deepEqual(w.forbidden, []);
});

test("isolated transport uses its own fixed endpoint and rejects old bridge endpoint", () => {
  const w = worker();
  assert.equal(w.run("HTTP_BASE"), "http://127.0.0.1:18796");
  assert.equal(w.run("WS_URL"), "ws://127.0.0.1:18796/ws");
  for (const change of [{ port: 18795 }, { host: "localhost" }, { port: "18796" }, { port: undefined }, { host: undefined }]) {
    assert.equal(w.call("bridgeMatches", { ...bridgeIdentity, ...change }), false);
  }
  assert.equal(w.call("bridgeMatches", bridgeIdentity), true);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const csp = manifest.content_security_policy.extension_pages;
  assert.match(csp, /http:\/\/127\.0\.0\.1:18796/u);
  assert.match(csp, /ws:\/\/127\.0\.0\.1:18796/u);
  assert.equal(csp.includes("18795"), false);
});

test("bridge endpoint mismatch cannot report readiness", async () => {
  const w = worker();
  w.run("bridgeIdentity.port = 18795;");
  await w.call("sendStatus");
  assert.equal(w.wire.at(-1).connected, false);
  assert.deepEqual(w.forbidden, []);
});

test("cross-extension identity and absent mode cannot report readiness", async () => {
  for (const change of [{ extension_id: "old-extension" }, { extension_id: undefined }, { mode: "unknown" }, { mode: undefined }]) {
    const w = worker();
    assert.equal(w.call("bridgeMatches", { ...bridgeIdentity, ...change }), false);
    w.context.change = change;
    w.run("Object.assign(bridgeIdentity, change);");
    await w.call("sendStatus");
    assert.equal(w.wire.at(-1).connected, false);
    assert.deepEqual(w.forbidden, []);
  }
});

test("inspection-only welcome ignores cached sends and pending recovery without binding or injection", async () => {
  const w = worker();
  const before = clone(w.data);
  w.run('targetTabId = null; targetTabUrl = ""; pinnedConversationUrl = "";');
  await w.call("handleWireMessage", JSON.stringify({ type: "welcome",
    bridge_identity: { ...bridgeIdentity, mode: "inspection-only" },
    pending_request: normalRequest(), pending_recovery: request() }));
  assert.deepEqual(w.data, before);
  assert.equal(w.run("targetTabId"), null);
  assert.deepEqual(w.contentCalls, []);
  assert.deepEqual(w.forbidden, []);
  assert.deepEqual(w.wire.map((m) => m.type), ["tab_status"]);
  assert.equal(w.wire[0].connected, false);
});

test("inspection-only connect bootstraps without reading storage selecting a tab or injecting", async () => {
  const w = worker();
  w.context.bootstrap = { control_token: "a".repeat(43), bridge_identity: { ...bridgeIdentity, mode: "inspection-only" } };
  w.run('socket = null; bridgeIdentity = null; targetTabId = null; targetTabUrl = ""; pinnedConversationUrl = "";');
  w.run('globalThis.calls = []; fetch = async () => ({ ok: true, json: async () => bootstrap });'
    + 'chrome.tabs.query = async () => { calls.push("query"); throw Error("forbidden"); };'
    + 'chrome.storage.session.get = async () => { calls.push("get"); throw Error("forbidden"); };'
    + 'chrome.storage.session.set = async () => { calls.push("set"); throw Error("forbidden"); };'
    + 'WebSocket = class { static OPEN = 1; static CONNECTING = 0; constructor(url) { this.url = url; } };');
  await w.call("connect");
  assert.equal(w.run("socket.url"), "ws://127.0.0.1:18796/ws");
  assert.equal(w.run("targetTabId"), null);
  assert.equal(w.run("calls.length"), 0);
  assert.deepEqual(w.contentCalls, []);
  assert.deepEqual(w.forbidden, []);
});

test("inspection-only extension rejects normal dispatch and recovery before touching stored history", async () => {
  const w = worker();
  const before = clone(w.data);
  w.run('bridgeIdentity.mode = "inspection-only";');
  await w.call("dispatchRequest", normalRequest(), false);
  await w.call("dispatchOriginalRecovery", request());
  assert.deepEqual(w.data, before);
  assert.deepEqual(w.contentCalls, []);
  assert.deepEqual(w.forbidden, []);
  assert.equal(w.wire.length, 2);
  assert.equal(w.wire.every((m) => m.error_code === "inspection_mode_locked"), true);
});
