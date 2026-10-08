"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), test = require("node:test");
const F = require("./offline_fixtures.cjs");
const ROOT = F.extensionRoot;
if (!process.env.C2C_V2_TEST_DATA_ROOT || !path.isAbsolute(process.env.C2C_V2_TEST_DATA_ROOT)) throw Error("explicit evidence root required");
const fixture = JSON.parse(fs.readFileSync(path.join(process.env.C2C_V2_TEST_DATA_ROOT, "fresh-cross-language.json"), "utf8"));
const R = fixture.checkpoint.requests[0];
const I = { version: "0.9.8", protocol_version: 3, build_id: "c2c-v2-fresh-paired-turn-completion-1" };
const clone = (v) => JSON.parse(JSON.stringify(v));
function retry(r = R) { return { ...r, attempt_id: r.attempt_id + 1, message: r.message.replace(`ATTEMPT_ID: ${r.attempt_id}`, `ATTEMPT_ID: ${r.attempt_id + 1}`) }; }
function worker(options = {}) {
  const sent = [], contentCalls = [], forbidden = [], storage = clone(options.storage || {}), listeners = {};
  const tabs = options.tabs || [{ id: R.target_tab_id, url: R.conversation_url, status: "complete" }];
  let contentGeneration = 1;
  const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  const forbid = (op) => async () => { forbidden.push(op); throw Error("forbidden " + op); };
  const sandbox = { URL, JSON, Map, Set, Promise, console,
    WebSocket: class { static OPEN = 1; static CONNECTING = 0; constructor() { throw Error("real socket forbidden"); } },
    fetch: options.fetch || forbid("fetch"), setTimeout(fn, ms) { if (options.timers) options.timers.push({ fn, ms }); return 1; }, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {},
    chrome: { runtime: { id: fixture.bridge_identity.extension_id, getManifest: () => ({ version: options.manifestVersion || I.version }),
      onMessage: event("message"), onStartup: event("startup"), onInstalled: event("installed"), reload: options.runtimeReload || forbid("extension_reload") },
      alarms: { create() {}, onAlarm: event("alarm") },
      tabs: { query: async () => clone(tabs), get: options.tabGet || (async (id) => clone(tabs.find((t) => t.id === id))),
        create: forbid("create"), update: options.tabUpdate || forbid("navigate"), reload: options.tabReload || forbid("reload"), onUpdated: event("update"), onRemoved: event("remove"),
        async sendMessage(id, m) { contentCalls.push({ id, ...clone(m) });
          if (options.sendMessage) return options.sendMessage(id, m);
          if (m.type === "C2C_FRESH_PING") return { type: "C2C_FRESH_READY", ...I, url: tabs.find((t) => t.id === id)?.url,
            content_generation: contentGeneration, ...options.ping }; return { accepted: true }; } },
      scripting: { async executeScript(value) { const result = await (options.executeScript || forbid("inject"))(value); contentGeneration++; return result; } },
      storage: { session: { async get() { return clone(storage); }, async set(value) { Object.assign(storage, clone(value)); } } },
    } };
  const ctx = vm.createContext(sandbox);
  sandbox.importScripts = (...files) => files.forEach((name) => vm.runInContext(fs.readFileSync(path.join(ROOT, name), "utf8"), ctx));
  sandbox.capture = (raw) => sent.push(JSON.parse(raw)); sandbox.fixtureBridge = clone(fixture.bridge_identity);
  let background = fs.readFileSync(path.join(ROOT, "fresh_background.js"), "utf8");
  if (options.backgroundVersion) background = background.replace('BACKGROUND_VERSION = "0.9.8"', `BACKGROUND_VERSION = "${options.backgroundVersion}"`);
  vm.runInContext(background, ctx);
  if (options.oldLocator) sandbox.C2CV2FreshLocator = { ...sandbox.C2CV2FreshLocator, version: "0.8.1" };
  vm.runInContext("socket = { readyState: 1, send: capture }; bridge = fixtureBridge;", ctx);
  return { sent, contentCalls, forbidden, storage, tabs, sandbox, listeners,
    run(expr) { return vm.runInContext(expr, ctx); },
    call(name, ...args) { sandbox.args = args; return vm.runInContext(`${name}(...args)`, ctx); } };
}
function content(nodes, options = {}) {
  let clock = 0, listener, clicks = 0;
  const sent = [], forbidden = [], activeListeners = new Set();
  class Input { constructor() { this.value = ""; this.isConnected = true; this.disabled = false; }
    focus() {} dispatchEvent() {} getBoundingClientRect() { return { width: 20, height: 20 }; } getAttribute() { return null; } }
  // The native setter shape is used by the production composer code.
  class TextArea extends Input { get value() { return this._v || ""; } set value(v) { this._v = v; } }
  const composer = new TextArea(), doc = F.semanticDocument(nodes);
  const originalQuery = doc.querySelectorAll;
  const button = { isConnected: true, disabled: false, getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 20, height: 20 }), click() {
      clicks++;
      const user = new F.FixtureNode("div", { "data-message-author-role": "user" }, composer.value);
      user.parentElement = doc.querySelector("main"); nodes.push(user); composer.value = "";
      if (options.afterClick) options.afterClick(nodes, clicks, sandbox);
    } };
  doc.querySelectorAll = (selector) => {
    if (selector.includes("prompt-textarea") || selector === "main textarea") {
      if (!options.allowSend) { forbidden.push("composer"); throw Error("composer forbidden"); } return [composer];
    }
    if (selector.includes("send-button")) {
      if (!options.allowSend) { forbidden.push("send"); throw Error("send forbidden"); } return [button];
    }
    if (selector.includes("Stop") || selector.includes("stop-button") || selector.includes("aria-busy") || selector.includes("streaming")) return [];
    return originalQuery.call(doc, selector);
  };
  const sandbox = { URL, console, Map, Set, Promise, document: doc, location: { href: options.url || R.conversation_url },
    HTMLTextAreaElement: TextArea, HTMLInputElement: Input, Event: class {}, InputEvent: class {},
    Date: { now: () => clock }, setTimeout(fn, ms) { clock += ms; if (options.onSleep) options.onSleep(sandbox, clock); queueMicrotask(fn); },
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; activeListeners.add(fn); },
      removeListener(fn) { activeListeners.delete(fn); if (listener === fn) listener = null; } },
      async sendMessage(m) { sent.push(clone(m)); } } } };
  const ctx = vm.createContext(sandbox);
  for (const file of ["fresh_component_identity.js", "fresh_contract.js", "fresh_locator.js"]) vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), ctx);
  if (options.oldLocator) sandbox.C2CV2FreshLocator = { ...sandbox.C2CV2FreshLocator, version: "0.8.1" };
  vm.runInContext(fs.readFileSync(path.join(ROOT, "fresh_content.js"), "utf8"), ctx);
  listener({ type: "C2C_FRESH_PING", target_tab_id: R.target_tab_id }, {}, () => {});
  return { sent, forbidden, clicks: () => clicks, sandbox, activeListeners,
    reinject() { vm.runInContext(fs.readFileSync(path.join(ROOT, "fresh_content.js"), "utf8"), ctx); },
    message(m) { let response; listener(m, {}, (r) => { response = r; }); return response; },
    async settle(n = 14000) { for (let i = 0; i < n; i++) await Promise.resolve(); } };
}
function user(r = R) { return new F.FixtureNode("div", { "data-message-author-role": "user" }, r.message); }
function result(r = R, change = {}) { return { type: "C2C_FRESH_RESULT", ...r, conversation_url: r.conversation_url,
  raw_reply: "  Fresh exact\r\n", assistant_generation_complete: true, content_identity: I, ...change }; }
function sender(r = R) { return { id: fixture.bridge_identity.extension_id, tab: { id: r.target_tab_id }, url: r.conversation_url }; }

test("future thread preparation opens exact frozen URL for a new request only with no old binding mutation or send", async () => {
  const id = R.target_tab_id + 1, updates = [];
  const w = worker({ tabs: [{ id, url: "https://chatgpt.com/", status: "complete" }], tabUpdate: async (...v) => updates.push(clone(v)) });
  await w.call("restore", fixture.checkpoint); const before = clone(w.storage);
  await w.call("maintenance", { maintenance_id: R.request_id, action: "prepare_future_thread", future_only: true,
    request: R, tab_id: id, url: R.conversation_url });
  assert.deepEqual(updates, [[id, { url: R.conversation_url }]]); assert.equal(w.sent.at(-1).complete, true);
  assert.deepEqual(w.storage, before); assert.deepEqual(w.contentCalls, []); assert.deepEqual(w.forbidden, []);
});

test("future thread preparation rejects ambiguous changed or still present old authority with zero navigation", async () => {
  const id = R.target_tab_id + 1;
  for (const variant of ["unknown", "control", "nonce", "url", "tab", "flag", "old_exists", "duplicate", "loading", "pending_url", "other_url", "running", "mixed"]) {
    const updates = [], tabs = [{ id, url: "https://chatgpt.com/", status: "complete" }];
    if (variant === "old_exists") tabs.push({ id: R.target_tab_id, url: R.conversation_url, status: "complete" });
    if (variant === "duplicate") tabs.push({ id: id + 1, url: "https://chatgpt.com/", status: "complete" });
    if (variant === "loading") tabs[0].status = "loading";
    if (variant === "pending_url") tabs[0].pendingUrl = R.conversation_url;
    if (variant === "other_url") tabs[0].url = R.conversation_url;
    const w = worker({ tabs, tabUpdate: async (...v) => updates.push(clone(v)) }); await w.call("restore", fixture.checkpoint);
    const before = clone(w.storage), m = { maintenance_id: R.request_id, action: "prepare_future_thread", future_only: true,
      request: clone(R), tab_id: id, url: R.conversation_url };
    if (variant === "unknown") m.request.request_id = "00000000-0000-4000-8000-000000000001";
    if (variant === "control") m.request.control_id = "00000000-0000-4000-8000-000000000002";
    if (variant === "nonce") m.request.nonce = "a".repeat(32);
    if (variant === "url") m.url = "https://chatgpt.com/c/other";
    if (variant === "tab") m.tab_id = R.target_tab_id;
    if (variant === "flag") m.future_only = false;
    if (variant === "running") w.run('running.add("synthetic-active");');
    if (variant === "mixed") w.run('bridge.version = "0.8.1";');
    await w.call("maintenance", m); assert.deepEqual(updates, [], variant);
    assert.equal(w.sent.some((x) => x.complete === true), false, variant);
    assert.deepEqual(w.storage, before, variant); assert.deepEqual(w.contentCalls, [], variant);
  }
});

test("Python checkpoint restores after cache loss without sending, recovery, navigation or injection", async () => {
  const w = worker({ storage: { "c2c.originalRequests.v2": { legacy: "untrusted" } } });
  await w.call("wire", JSON.stringify({ type: "fresh_welcome", bridge_identity: fixture.bridge_identity, checkpoint: fixture.checkpoint }));
  assert.equal(w.contentCalls.some((m) => m.type === "C2C_FRESH_REVIEW"), false);
  assert.equal(w.sent.filter((m) => m.type !== "fresh_status").length, 0);
  assert.equal(w.storage["c2c.fresh.v3.attemptMirror"][0].request_id, R.request_id);
  assert.deepEqual(w.storage["c2c.originalRequests.v2"], { legacy: "untrusted" });
  assert.deepEqual(w.forbidden, []);
});

test("sealed Python failure canonical duplicate checkpoint welcome restores only mirror and pings", async () => {
  const roundtrip = JSON.parse(fs.readFileSync(path.join(process.env.C2C_V2_TEST_DATA_ROOT, "fresh-roundtrip-cross-language.json"), "utf8"));
  assert.equal(roundtrip.checkpoint.requests.length, 2); const record = Object.values(roundtrip.records)[0];
  assert.equal(record.status, "complete"); assert.equal(record.duplicate_count, 1); assert.equal(record.result.attempt_id, 2);
  const w = worker(); await w.call("wire", JSON.stringify({ type: "fresh_welcome", bridge_identity: roundtrip.bridge_identity, checkpoint: roundtrip.checkpoint }));
  assert.deepEqual(w.storage["c2c.fresh.v3.attemptMirror"], roundtrip.checkpoint.requests);
  assert.equal(w.contentCalls.every((m) => m.type === "C2C_FRESH_PING"), true);
  assert.equal(w.sent.every((m) => m.type === "fresh_status"), true); assert.deepEqual(w.forbidden, []);
  assert.equal(JSON.stringify(w.storage).includes('"control_token"'), false);
});
test("new attempt for same logical request may send; same attempt is an expendable resume", async () => {
  const w = worker(); await w.call("restore", { ...fixture.checkpoint, requests: [] });
  await w.call("dispatch", R); await w.call("dispatch", retry());
  assert.deepEqual(w.contentCalls.filter((m) => m.type === "C2C_FRESH_REVIEW").map((m) => [m.request.attempt_id, m.may_send]), [[1, true], [2, true]]);
  w.run("running.clear()"); await w.call("dispatch", R);
  assert.equal(w.contentCalls.at(-1).may_send, false);
});
for (const [key, value] of Object.entries({ nonce: "wrong", iteration: 9, expected_commit: "f".repeat(40), request_id: "4754374f-14dd-4004-bf87-3b87972e17fa",
  control_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", attempt_id: 99, conversation_url: "https://other.invalid/", target_tab_id: true })) {
  test(`checkpoint rejects invalid ${key}`, async () => { const w = worker();
    await assert.rejects(w.call("restore", { ...fixture.checkpoint, requests: [{ ...R, [key]: value }] }));
    assert.equal(w.run("mirrorReady"), false); assert.deepEqual(w.storage, {}); });
}
test("checkpoint duplicate attempts and conflicting logical control identities are rejected", async () => {
  const w = worker(); await assert.rejects(w.call("restore", { ...fixture.checkpoint, requests: [R, R] }));
  await assert.rejects(w.call("restore", { ...fixture.checkpoint, requests: [R, { ...retry(), repo: "other/repo" }] }));
});
for (const options of [ { tabs: [] }, { tabs: [{ id: 7, url: R.conversation_url, status: "complete" }, { id: 8, url: R.conversation_url, status: "complete" }] },
  { tabs: [{ id: 7, url: R.conversation_url, status: "loading" }] }, { tabs: [{ id: 8, url: R.conversation_url, status: "complete" }] },
  { ping: { version: "0.8.1" } }, { ping: { build_id: "old" } }, { manifestVersion: "0.8.1" } ]) {
  test(`dispatch rejects missing/duplicate/loading/wrong target or mixed components ${JSON.stringify(options)}`, async () => {
    const w = worker(options); await w.call("restore", { ...fixture.checkpoint, requests: [] });
    await assert.rejects(w.call("dispatch", R)); assert.equal(w.contentCalls.some((m) => m.type === "C2C_FRESH_REVIEW"), false);
    assert.deepEqual(w.forbidden, []);
  });
}
test("old bridge version, protocol, ID, build, port and source identity cannot report ready", () => {
  const w = worker();
  for (const change of [{ version: "0.8.1" }, { protocol_version: 2 }, { extension_id: "other" }, { build_id: "old" }, { port: 18795 }, { source_sha256: "" }]) {
    assert.equal(w.call("bridgeMatches", { ...fixture.bridge_identity, ...change }), false);
  }
});
test("background accepts valid earlier and later attempts as the same logical reply stream", async () => {
  const w = worker(); await w.call("restore", { ...fixture.checkpoint, requests: [R, retry()] });
  await w.call("content", result(R), sender()); await w.call("content", result(retry()), sender());
  const replies = w.sent.filter((m) => m.type === "fresh_result");
  assert.deepEqual(replies.map((m) => m.attempt_id), [1, 2]); assert.equal(replies[0].request_id, replies[1].request_id);
  assert.equal(replies[0].raw_reply, "  Fresh exact\r\n");
});
for (const change of [{ control_id: "wrong" }, { request_id: "unknown" }, { expected_commit: "f".repeat(40) }, { iteration: 9 },
  { repo: "other/repo" }, { branch: "wrong" }, { conversation_url: R.conversation_url + "other" },
  { assistant_generation_complete: false }, { content_identity: { ...I, version: "0.8.1" } }]) {
  test(`background rejects reply ${JSON.stringify(change)}`, async () => { const w = worker(); await w.call("restore", fixture.checkpoint);
    await w.call("content", result(R, change), sender()); assert.equal(w.sent.some((m) => m.type === "fresh_result"), false); });
}
test("content matches the full control and attempt envelope and preserves raw completed reply", async () => {
  const c = content([user(), F.assistantMessage("  Fresh exact\r\n")]);
  c.message({ type: "C2C_FRESH_REVIEW", request: R, may_send: false }); await c.settle();
  const m = c.sent.find((m) => m.type === "C2C_FRESH_RESULT");
  assert.equal(m.raw_reply, "  Fresh exact\r\n"); assert.equal(m.control_id, R.control_id); assert.equal(m.attempt_id, 1);
  assert.equal(m.assistant_generation_complete, true); assert.deepEqual(c.forbidden, []);
});
test("same nonce/control across different attempts no longer prohibits another actual mock send", async () => {
  const nodes = [user()];
  const c = content(nodes, { allowSend: true, afterClick(list) { list.push(F.assistantMessage("retry completed")); } });
  c.message({ type: "C2C_FRESH_REVIEW", request: retry(), may_send: true }); await c.settle();
  assert.equal(c.clicks(), 1); assert.equal(c.sent.find((m) => m.type === "C2C_FRESH_RESULT").attempt_id, 2);
  assert.equal(c.sent.find((m) => m.type === "C2C_FRESH_RESULT").raw_reply, "retry completed");
});
test("root-to-thread navigation is observed in the same mock tab without actual navigation", async () => {
  const rootRequest = { ...R, conversation_url: "https://chatgpt.com/" };
  const c = content([], { allowSend: true, url: "https://chatgpt.com/", afterClick(list, _, sandbox) {
    sandbox.location.href = R.conversation_url; list.push(F.assistantMessage("fresh thread reply")); } });
  c.message({ type: "C2C_FRESH_REVIEW", request: rootRequest, may_send: true }); await c.settle();
  assert.equal(c.clicks(), 1); assert.equal(c.sent.find((m) => m.type === "C2C_FRESH_BOUND").conversation_url, R.conversation_url);
});
test("content cannot cross an unrelated user turn or accept an unfinished assistant", async () => {
  const streaming = F.assistantMessage("unfinished"); streaming.attributes["data-message-status"] = "streaming";
  for (const nodes of [[user(), user({ ...retry(), request_id: R.request_id }), F.assistantMessage("other turn")], [user(), streaming]]) {
    const c = content(nodes); c.message({ type: "C2C_FRESH_REVIEW", request: R, may_send: false }); await c.settle();
    const m = c.sent.find((m) => m.type === "C2C_FRESH_RESULT"); assert.equal(m.raw_reply, undefined); assert.ok(m.error_code);
  }
});
test("fresh source has no legacy recovery protocol; manifest uses only fresh components", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "fresh_manifest.json"), "utf8"));
  assert.equal(manifest.version, I.version); assert.equal(manifest.background.service_worker, "fresh_background.js");
  assert.equal(manifest.key, undefined);
  for (const file of manifest.content_scripts[0].js) { assert.ok(fs.existsSync(path.join(ROOT, file))); assert.ok(file.startsWith("fresh_")); }
  for (const file of ["fresh_background.js", "fresh_content.js", "fresh_contract.js", "fresh_locator.js"]) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8"); assert.equal(source.includes("RECOVER_ORIGINAL"), false);
    assert.equal(source.includes("runOriginalRecovery"), false);
  }
});

test("old background declaration or locator cannot claim Fresh readiness with new shared identity", async () => {
  for (const options of [{ backgroundVersion: "0.8.1" }, { oldLocator: true }]) {
    const w = worker(options); assert.equal(w.call("bridgeMatches", fixture.bridge_identity), false);
    await w.call("restore", { ...fixture.checkpoint, requests: [] });
    await assert.rejects(w.call("dispatch", R));
  }
});
test("content with an old helper cannot claim completion or a matching component version", async () => {
  const c = content([user(), F.assistantMessage("completed")], { oldLocator: true });
  const pong = c.message({ type: "C2C_FRESH_PING", target_tab_id: R.target_tab_id });
  assert.equal(pong.version, "");
  c.message({ type: "C2C_FRESH_REVIEW", request: R, may_send: false }); await c.settle();
  assert.equal(c.sent.find((m) => m.type === "C2C_FRESH_RESULT").raw_reply, undefined);
});

for (const helper of ["Locator", "Contract"]) {
  test(`same-version reinjection replaces the listener and uses current ${helper} without sending`, async () => {
    const c = content([user(), F.assistantMessage("old helper would accept this")]);
    const key = "__c2cV2FreshContentControl", prior = c.sandbox[key], original = c.sandbox[`C2CV2Fresh${helper}`];
    assert.equal(prior.version, I.version); assert.equal(c.activeListeners.size, 1);
    let currentCalls = 0;
    c.sandbox[`C2CV2Fresh${helper}`] = { ...original,
      ...(helper === "Locator" ? { findOriginalUserTurn() { currentCalls++; return null; } }
        : { validRequest() { currentCalls++; return false; } }) };
    c.reinject();
    const current = c.sandbox[key];
    assert.equal(current.version, prior.version); assert.notEqual(current.listener, prior.listener);
    assert.equal(c.activeListeners.has(prior.listener), false); assert.equal(c.activeListeners.has(current.listener), true);
    assert.equal(c.activeListeners.size, 1); assert.deepEqual(c.sent, []); assert.equal(c.clicks(), 0); assert.deepEqual(c.forbidden, []);
    const pong = c.message({ type: "C2C_FRESH_PING", target_tab_id: R.target_tab_id });
    assert.equal(pong.version, I.version); assert.equal(pong.build_id, I.build_id);
    const response = c.message({ type: "C2C_FRESH_OBSERVE", request: R, may_send: false });
    await c.settle();
    assert.ok(currentCalls > 0);
    if (helper === "Locator") assert.equal(c.sent.at(-1).error_code, "outgoing_turn_not_confirmed");
    else { assert.equal(response.accepted, false); assert.deepEqual(c.sent, []); }
    assert.equal(c.sent.some((m) => ["C2C_FRESH_REVIEW", "fresh_review", "review", "retry", "logical_created", "send_attempt"].includes(m.type)), false);
    assert.equal(c.sent.some((m) => m.raw_reply), false); assert.equal(c.clicks(), 0); assert.deepEqual(c.forbidden, []);
  });
}

test("bootstrap uses real connect path: POST without forged Origin, auth, welcome, ready; no credential mirror", async () => {
  const calls = [], sockets = [], token = "offline-bootstrap-only-" + "x".repeat(30);
  const w = worker({ fetch: async (url, options) => { calls.push({ url, options });
    return { ok: true, async json() { return { bridge_identity: clone(fixture.bridge_identity), control_token: token }; } }; } });
  w.sandbox.WebSocket = class { static OPEN = 1; static CONNECTING = 0;
    constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); }
    send(raw) { w.sent.push(JSON.parse(raw)); } close() { this.readyState = 3; } };
  w.run("socket = null; bridge = null; mirrorReady = false;");
  await w.call("connect");
  assert.equal(calls.length, 1); assert.equal(calls[0].url, "http://127.0.0.1:18797/bootstrap");
  assert.equal(calls[0].options.method, "POST"); assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.headers, undefined);
  assert.equal(sockets.length, 1); assert.equal(sockets[0].url, "ws://127.0.0.1:18797/ws");
  const ws = sockets[0]; ws.readyState = 1; ws.onopen();
  assert.equal(w.sent[0].type, "auth"); assert.equal(w.sent[0].control_token, token);
  ws.onmessage({ data: JSON.stringify({ type: "fresh_welcome", bridge_identity: fixture.bridge_identity,
    checkpoint: { ...fixture.checkpoint, requests: [] } }) });
  await new Promise(setImmediate); await new Promise(setImmediate);
  assert.equal(w.run("mirrorReady"), true); assert.equal(w.sent.at(-1).type, "fresh_status");
  assert.equal(w.sent.at(-1).connected, true); assert.equal(w.sent.at(-1).readiness_code, "ready");
  assert.equal(JSON.stringify(w.storage).includes(token), false);
  assert.equal(w.contentCalls.some((m) => m.type === "C2C_FRESH_REVIEW"), false);
});

test("bootstrap rejection or mixed identity cannot open WebSocket or claim ready", async () => {
  for (const value of [{ ok: false, bridge_identity: fixture.bridge_identity },
    { ok: true, bridge_identity: { ...fixture.bridge_identity, version: "0.9.0" } }]) {
    let sockets = 0;
    const w = worker({ fetch: async () => ({ ok: value.ok, async json() { return { ...value, control_token: "x".repeat(43) }; } }) });
    w.sandbox.WebSocket = class { static OPEN = 1; static CONNECTING = 0; constructor() { sockets++; } };
    w.run("socket = null; bridge = null; mirrorReady = false;"); await w.call("connect");
    assert.equal(sockets, 0); assert.equal(w.run("mirrorReady"), false); assert.deepEqual(w.storage, {});
  }
});

test("maintenance reloads only Fresh runtime after ACK and never dispatches", async () => {
  const timers = []; let reloads = 0;
  const w = worker({ timers, runtimeReload: () => { reloads++; } }); await w.call("restore", { ...fixture.checkpoint, requests: [] });
  await w.call("wire", JSON.stringify({ type: "fresh_maintenance", maintenance_id: R.request_id, action: "reload_extension" }));
  assert.equal(w.sent.at(-1).type, "fresh_maintenance_result"); assert.equal(w.sent.at(-1).complete, true);
  assert.equal(reloads, 0); timers.at(-1).fn(); assert.equal(reloads, 1);
  assert.equal(w.contentCalls.some((m) => m.type === "C2C_FRESH_REVIEW"), false); assert.deepEqual(w.forbidden, []);
});

test("content generation advances on same-version replacement and retired handler cannot act", async () => {
  const c = content([user(), F.assistantMessage("completed")]);
  const old = c.sandbox.__c2cV2FreshContentControl, before = c.message({ type: "C2C_FRESH_PING", target_tab_id: R.target_tab_id });
  c.reinject(); const after = c.message({ type: "C2C_FRESH_PING", target_tab_id: R.target_tab_id });
  assert.equal(after.content_generation, before.content_generation + 1); assert.equal(after.version, before.version);
  old.listener({ type: "C2C_FRESH_OBSERVE", request: R }, {}, () => {}); await c.settle();
  assert.deepEqual(c.sent, []); assert.equal(c.clicks(), 0); assert.equal(c.activeListeners.size, 1);
});

test("bounded reply budget causes timeout without accepting an unfinished reply", async () => {
  const streaming = F.assistantMessage("in progress"); streaming.attributes["data-message-status"] = "streaming";
  const c = content([user(), streaming]); c.message({ type: "C2C_FRESH_OBSERVE", request: R, observation: { reply_wait_ms: 1000 } }); await c.settle();
  assert.equal(c.sent.at(-1).error_code, "assistant_turn_timeout"); assert.equal(c.sent.some((m) => m.raw_reply), false); assert.equal(c.clicks(), 0);
});

test("controlled locator miss is isolated to observation and later real observation succeeds", async () => {
  const c = content([user(), F.assistantMessage("completed")]);
  c.message({ type: "C2C_FRESH_OBSERVE", request: R, observation: { locator_miss: true } }); await c.settle();
  assert.equal(c.sent.at(-1).error_code, "outgoing_turn_not_confirmed");
  c.message({ type: "C2C_FRESH_OBSERVE", request: R }); await c.settle();
  assert.equal(c.sent.at(-1).raw_reply, "completed"); assert.equal(c.clicks(), 0); assert.deepEqual(c.forbidden, []);
});

test("invalid observation budgets and send-path locator faults are rejected", async () => {
  for (const observation of [{ reply_wait_ms: 0 }, { reply_wait_ms: true }, { reply_wait_ms: 600001 }, { locator_miss: "yes" }, { unknown: true }]) {
    const c = content([user(), F.assistantMessage("completed")]);
    c.message({ type: "C2C_FRESH_OBSERVE", request: R, observation }); await c.settle();
    assert.equal(c.sent.at(-1).error_code, "observation_options_invalid"); assert.equal(c.clicks(), 0);
  }
  const c = content([user()]); c.message({ type: "C2C_FRESH_REVIEW", request: R, may_send: true, observation: { locator_miss: true } }); await c.settle();
  assert.equal(c.sent.at(-1).error_code, "observation_options_invalid"); assert.deepEqual(c.forbidden, []);
});

test("exact Fresh tab reload is acknowledged only after API success and never sends", async () => {
  const reloads = []; const w = worker({ tabReload: async (id) => reloads.push(id) }); await w.call("restore", fixture.checkpoint);
  await w.call("maintenance", { maintenance_id: R.request_id, action: "reload_tab", tab_id: R.target_tab_id, url: R.conversation_url });
  assert.deepEqual(reloads, [R.target_tab_id]); assert.equal(w.sent.at(-1).complete, true);
  assert.equal(w.contentCalls.some((m) => m.type === "C2C_FRESH_REVIEW"), false);
});

test("authenticated status sample only pings and never dispatches or creates authority", async () => {
  const w = worker(); await w.call("restore", fixture.checkpoint); const before = clone(w.storage);
  await w.call("maintenance", { maintenance_id: R.request_id, action: "sample_status" });
  assert.equal(w.sent.at(-1).complete, true); assert.equal(w.sent.some((m) => m.type === "fresh_status"), true);
  assert.equal(w.contentCalls.some((m) => m.type !== "C2C_FRESH_PING"), false); assert.deepEqual(w.storage, before);
});

test("concurrent target queries cannot mix a healthy status with another query's missing identity", async () => {
  let release, pings = 0; const held = new Promise((resolve) => { release = resolve; });
  const w = worker({ sendMessage: async () => { if (++pings === 2) await held;
    return { type: "C2C_FRESH_READY", ...I, content_generation: 1, url: R.conversation_url }; } });
  await w.call("restore", fixture.checkpoint); const sampling = w.call("status");
  for (let i = 0; pings < 2 && i < 100; i++) await Promise.resolve(); assert.equal(pings, 2);
  await w.call("selectTarget", "https://chatgpt.com/c/missing"); release(); await sampling;
  const status = w.sent.at(-1); assert.equal(status.connected, true); assert.equal(status.readiness_code, "ready");
  assert.equal(status.components.content_version, I.version); assert.equal(status.tab_id, R.target_tab_id);
});

test("older ready status cannot publish or commit after newer loading status starts", async () => {
  let release, pings = 0; const held = new Promise((resolve) => { release = resolve; });
  const w = worker({ sendMessage: async () => { if (++pings === 1) await held;
    return { type: "C2C_FRESH_READY", ...I, content_generation: 1, url: R.conversation_url }; } });
  await w.call("restore", fixture.checkpoint); const before = clone(w.storage), older = w.call("status");
  for (let i = 0; pings < 1 && i < 100; i++) await Promise.resolve(); assert.equal(pings, 1);
  w.tabs[0].status = "loading"; await w.call("status"); release(); const old = await older;
  assert.equal(old.superseded, true); const statuses = w.sent.filter((m) => m.type === "fresh_status");
  assert.equal(statuses.length, 1); assert.equal(statuses[0].connected, false); assert.equal(statuses[0].readiness_code, "target_loading");
  assert.equal(w.run("target"), null); assert.equal(w.run("targetDiagnostic.readiness_code"), "target_loading");
  assert.deepEqual(w.storage, before); assert.equal(w.contentCalls.some((m) => m.type === "C2C_FRESH_REVIEW"), false);
});

test("older unavailable status cannot overwrite a newer ready status or shared target", async () => {
  let release, reads = 0; const held = new Promise((resolve) => { release = resolve; });
  const tabs = [{ id: R.target_tab_id, url: R.conversation_url, status: "loading" }];
  const w = worker({ tabs, tabGet: async () => { const captured = clone(tabs[0]); if (++reads === 1) await held; return captured; } });
  await w.call("restore", fixture.checkpoint); const before = clone(w.storage), older = w.call("status");
  for (let i = 0; reads < 1 && i < 100; i++) await Promise.resolve(); assert.equal(reads, 1);
  tabs[0].status = "complete"; await w.call("status"); release(); const old = await older;
  assert.equal(old.superseded, true); const statuses = w.sent.filter((m) => m.type === "fresh_status");
  assert.equal(statuses.length, 1); assert.equal(statuses[0].connected, true); assert.equal(statuses[0].readiness_code, "ready");
  assert.equal(w.run("target.id"), R.target_tab_id); assert.equal(w.run("targetDiagnostic.readiness_code"), "ready");
  assert.deepEqual(w.storage, before); assert.equal(w.contentCalls.some((m) => m.type === "C2C_FRESH_REVIEW"), false);
});

test("unanswered content ping is bounded and cannot prevent reporting the exact unavailable target", async () => {
  const timers = []; const w = worker({ timers, sendMessage: async () => new Promise(() => {}) });
  await w.call("restore", fixture.checkpoint); const sampling = w.call("status");
  for (let i = 0; !timers.length && i < 100; i++) await Promise.resolve();
  assert.equal(timers[0].ms, 15000); timers[0].fn(); await sampling;
  const status = w.sent.at(-1); assert.equal(status.connected, false); assert.equal(status.readiness_code, "content_unavailable");
  assert.equal(status.tab_id, R.target_tab_id); assert.equal(status.url, R.conversation_url);
  assert.equal(status.components.content_version, ""); assert.deepEqual(w.forbidden, []);
});

test("routine content status finds complete exact turns without a full body structural diagnostic scan", async () => {
  const c = content([user(), new F.FixtureNode("div", { "data-message-author-role": "assistant", "data-message-status": "complete" }, "actual reply")]);
  const result = c.message({ type: "C2C_FRESH_PING", target_tab_id: R.target_tab_id, requests: [R] });
  const d = result.attempt_diagnostics[0]; assert.equal(d.full_user_match, true); assert.equal(d.assistant_after_match, true);
  assert.equal(d.assistant_complete, true); assert.deepEqual(clone(d.structure), []); assert.equal(d.inspected, 0);
});

test("pending reply diagnostics are short scoped previews and never publish or cross a user turn", () => {
  const thinking = new F.FixtureNode("div", { "data-message-author-role": "assistant" }, "Thinking pending");
  const completed = new F.FixtureNode("div", { "data-message-author-role": "assistant", "data-message-status": "complete" }, "x".repeat(500));
  const anotherUser = new F.FixtureNode("div", { "data-message-author-role": "user" }, "Unrelated user");
  const c = content([user(), thinking, completed, anotherUser, completed]);
  const d = c.message({ type: "C2C_FRESH_PING", target_tab_id: R.target_tab_id, requests: [R] }).attempt_diagnostics[0];
  assert.equal(d.assistant_text_preview, "Thinking pending"); assert.equal(d.assistant_candidates.length, 2);
  assert.equal(d.assistant_candidates[1].short_preview, ""); assert.deepEqual(c.sent, []); assert.equal(c.clicks(), 0);
});

test("structural locator skips layout reads for unrelated decoration while retaining full wire and assistant checks", () => {
  const w = worker(), L = w.sandbox.C2CV2FreshLocator;
  const noise = Array.from({ length: 1000 }, () => { const n = new F.FixtureNode("div");
    Object.defineProperty(n, "textContent", { value: "unrelated decoration" });
    Object.defineProperty(n, "innerText", { get() { throw Error("unnecessary layout read"); } }); return n; });
  const u = user(), a = new F.FixtureNode("div", { "data-message-author-role": "assistant", "data-message-status": "complete" }, "actual reply");
  const main = new F.FixtureNode("main", {}, "", [...noise, u, a]);
  const doc = { querySelector: (s) => s === "main" ? main : null, querySelectorAll: () => [] };
  const found = L.findOriginalUserTurn(doc, { task_id: R.task_id, iteration: R.iteration, request_id: R.request_id,
    control_id: R.control_id, attempt_id: R.attempt_id, nonce: R.nonce, commit: R.expected_commit, original_message: R.message });
  assert.equal(found.node, u); assert.equal(L.findAssistantAfter(doc, found).node, a); assert.equal(L.isAssistantComplete(doc, { node: a }, found), true);
});

test("draft inspection is read only and returns no raw draft while proving exact owned wire", () => {
  const c = content([user()], { allowSend: true });
  const composer = c.sandbox.document.querySelectorAll("main textarea")[0]; composer.tagName = "TEXTAREA"; composer.value = R.message;
  const answer = c.message({ type: "C2C_FRESH_INSPECT_DRAFT", request: R, candidates: [R] });
  assert.equal(answer.inspected, true); assert.equal(answer.draft_summary.owned_attempt_id, R.attempt_id);
  assert.equal(answer.draft_summary.length, R.message.length); assert.equal(JSON.stringify(answer).includes(R.message), false);
  assert.equal(composer.value, R.message); assert.equal(c.clicks(), 0);
  composer.value = R.message.replace("\n", " ");
  const wrapped = c.message({ type: "C2C_FRESH_INSPECT_DRAFT", request: R, candidates: [R] });
  assert.equal(wrapped.draft_summary.owned_attempt_id, null); assert.equal(wrapped.draft_summary.normalized_owned_attempt_id, R.attempt_id);
  composer.value = "unknown private draft";
  const unknown = c.message({ type: "C2C_FRESH_INSPECT_DRAFT", request: R, candidates: [R] });
  assert.equal(unknown.draft_summary.owned_attempt_id, null); assert.equal(unknown.draft_summary.normalized_owned_attempt_id, null); assert.equal(composer.value, "unknown private draft");
});

test("wire inside an editable draft and its ancestors cannot prove an outgoing transcript turn", () => {
  const w = worker(), L = w.sandbox.C2CV2FreshLocator;
  const draft = new F.FixtureNode("div", { contenteditable: "true", role: "textbox" }, R.message);
  const wrapper = new F.FixtureNode("div", {}, "", [draft]); const doc = F.semanticDocument([wrapper]);
  const identity = { task_id: R.task_id, iteration: R.iteration, request_id: R.request_id,
    control_id: R.control_id, attempt_id: R.attempt_id, nonce: R.nonce, commit: R.expected_commit, original_message: R.message };
  assert.equal(L.findOriginalUserTurn(doc, identity), null);
  const real = user(); const actual = F.semanticDocument([real, wrapper]); assert.equal(L.findOriginalUserTurn(actual, identity).node, real);
});

test("explicit tool and system author nodes are retained as unknown barriers without results or sends", async () => {
  for (const role of ["tool", "system"]) {
    const barrier = new F.FixtureNode("div", { "data-message-author-role": role }, "Unrelated explicit role");
    const reply = new F.FixtureNode("div", { "data-message-author-role": "assistant", "data-message-status": "complete" }, "completed reply");
    const c = content([user(), barrier, reply]);
    const L = c.sandbox.C2CV2FreshLocator, u = L.collectMessages(c.sandbox.document).find((m) => m.role === "user");
    assert.equal(L.collectMessages(c.sandbox.document).some((m) => m.node === barrier && m.role === "unknown"), true);
    assert.equal(L.findAssistantAfter(c.sandbox.document, u), null);
    c.message({ type: "C2C_FRESH_OBSERVE", request: R, observation: { reply_wait_ms: 1000 } }); await c.settle();
    assert.equal(c.sent.some((m) => m.raw_reply), false); assert.equal(c.clicks(), 0); assert.deepEqual(c.forbidden, []);
  }
});

test("empty plaintext-only and inherited editability exclude draft wire while normal sibling still matches", async () => {
  for (const kind of ["empty", "plaintext-only", "inherited"]) {
    const attrs = kind === "empty" ? { contenteditable: "" } : kind === "plaintext-only" ? { contenteditable: "plaintext-only" } : {};
    const draft = new F.FixtureNode("div", {}, R.message), editor = new F.FixtureNode("div", attrs, "", [draft]);
    if (kind === "inherited") editor.isContentEditable = true;
    const c = content([editor]); c.message({ type: "C2C_FRESH_OBSERVE", request: R }); await c.settle();
    assert.equal(c.sent.some((m) => m.raw_reply), false); assert.equal(c.sent.at(-1).error_code, "outgoing_turn_not_confirmed");
    assert.equal(c.clicks(), 0); assert.deepEqual(c.forbidden, []);
    const normal = user(); const positive = content([normal, editor]);
    const d = positive.message({ type: "C2C_FRESH_PING", target_tab_id: R.target_tab_id, requests: [R] }).attempt_diagnostics[0];
    assert.equal(d.full_user_match, true);
  }
});

test("duplicate full labels or two full users remain ambiguous with no association result or send", async () => {
  for (const nodes of [[user(), user()], ...["REQUEST_ID", "CONTROL_ID", "NONCE"].map((key) => {
    const value = key === "REQUEST_ID" ? R.request_id : R.control_id;
    return [new F.FixtureNode("div", { "data-message-author-role": "user" }, R.message + `\n${key}: ${value}`)];
  })]) {
    const c = content(nodes); const d = c.message({ type: "C2C_FRESH_PING", target_tab_id: R.target_tab_id, requests: [R] }).attempt_diagnostics[0];
    assert.equal(d.full_user_match, false); c.message({ type: "C2C_FRESH_OBSERVE", request: R }); await c.settle();
    assert.equal(c.sent.some((m) => m.raw_reply), false); assert.equal(c.clicks(), 0); assert.deepEqual(c.forbidden, []);
  }
});

test("explicit owned draft clear keeps unknown input and never clicks or emits a review result", () => {
  const c = content([user()], { allowSend: true }), composer = c.sandbox.document.querySelectorAll("main textarea")[0];
  composer.value = "unknown private draft";
  assert.equal(c.message({ type: "C2C_FRESH_CLEAR_OWNED_DRAFT", request: R }).cleared, false); assert.equal(composer.value, "unknown private draft");
  composer.value = R.message.replace("\n", " ");
  assert.equal(c.message({ type: "C2C_FRESH_CLEAR_OWNED_DRAFT", request: R }).cleared, true); assert.equal(composer.value, "");
  assert.equal(c.clicks(), 0); assert.deepEqual(c.sent, []);
});

test("loading target is distinct from ambiguity and diagnostics never select pending URLs", async () => {
  const w = worker({ tabs: [{ id: R.target_tab_id, url: R.conversation_url, status: "loading", pendingUrl: "https://other.example/private" }] });
  await w.call("restore", fixture.checkpoint); await w.call("status");
  const status = w.sent.at(-1); assert.equal(status.readiness_code, "target_loading");
  assert.equal(status.connected, false); assert.equal(status.candidate_count, 1);
  assert.deepEqual(status.observed_targets, [{ tab_id: R.target_tab_id, url: R.conversation_url, status: "loading", pending_url: "" }]);
  assert.deepEqual(w.contentCalls, []); assert.deepEqual(w.forbidden, []);
});

test("missing known tab diagnostic preserves identity without creating or rebinding a tab", async () => {
  const w = worker({ tabs: [] }); await w.call("restore", fixture.checkpoint); await w.call("status");
  const status = w.sent.at(-1); assert.equal(status.connected, false); assert.equal(status.readiness_code, "no_target");
  assert.deepEqual(status.bound_tab_diagnostics, [{ tab_id: R.target_tab_id, exists: false, status: "missing", url: "", pending_url: "", other_origin: "", active: null, frozen: null, discarded: null }]);
  assert.deepEqual(w.forbidden, []);
});

test("explicit thread restoration navigates only the original native tab to its journal URL and never sends", async () => {
  const updates = []; const w = worker({ tabs: [{ id: R.target_tab_id, url: "https://chatgpt.com/", status: "complete" }], tabUpdate: async (...args) => updates.push(args) });
  await w.call("restore", fixture.checkpoint); const before = clone(w.storage);
  await w.call("maintenance", { maintenance_id: R.request_id, action: "restore_thread", tab_id: R.target_tab_id, url: R.conversation_url, request: R });
  assert.deepEqual(clone(updates), [[R.target_tab_id, { url: R.conversation_url }]]); assert.equal(w.sent.at(-1).complete, true);
  assert.deepEqual(w.storage, before); assert.deepEqual(w.contentCalls, []);
});

test("activation can unfreeze only the exact known native tab without URL changes or sends", async () => {
  const updates = []; const w = worker({ tabUpdate: async (...args) => updates.push(clone(args)) }); await w.call("restore", fixture.checkpoint);
  await w.call("maintenance", { maintenance_id: R.request_id, action: "activate_tab", tab_id: R.target_tab_id, url: R.conversation_url, request: R });
  assert.deepEqual(updates, [[R.target_tab_id, { active: true }]]); assert.equal(w.sent.at(-1).complete, true); assert.deepEqual(w.contentCalls, []);
  await w.call("maintenance", { maintenance_id: R.request_id, action: "activate_tab", tab_id: R.target_tab_id, url: R.conversation_url, request: { ...R, control_id: "wrong" } });
  assert.equal(w.sent.at(-1).complete, false); assert.equal(updates.length, 1);
});

test("thread restoration rejects wrong tab URL identity and duplicate targets without navigation", async () => {
  for (const change of [{ tab_id: R.target_tab_id + 1 }, { url: "https://chatgpt.com/c/other" }, { request: { ...R, control_id: "x" } },
      { tabs: [{ id: R.target_tab_id, url: "https://chatgpt.com/", status: "complete" }, { id: R.target_tab_id + 1, url: R.conversation_url, status: "complete" }] }]) {
    const w = worker({ tabs: change.tabs || [{ id: R.target_tab_id, url: "https://chatgpt.com/", status: "complete" }] }); await w.call("restore", fixture.checkpoint);
    await w.call("maintenance", { maintenance_id: R.request_id, action: "restore_thread", tab_id: R.target_tab_id, url: R.conversation_url, request: R, ...change });
    assert.equal(w.sent.at(-1).complete, false); assert.deepEqual(w.forbidden, []);
  }
});

test("restoration refuses unrelated current conversation or duplicate current root with zero updates", async () => {
  for (const tabs of [
    [{ id: R.target_tab_id, url: "https://chatgpt.com/c/unrelated", status: "complete" }],
    [{ id: R.target_tab_id, url: "https://chatgpt.com/", status: "complete" }, { id: 99, url: "https://chatgpt.com/", status: "complete" }],
    [{ id: R.target_tab_id, url: "https://chatgpt.com/", status: "complete" }, { id: 99, url: R.conversation_url, status: "complete" }],
  ]) {
    const updates = [], w = worker({ tabs, tabUpdate: async (...args) => updates.push(args) }); await w.call("restore", fixture.checkpoint);
    const before = clone(w.storage); await w.call("maintenance", { maintenance_id: R.request_id, action: "restore_thread", tab_id: R.target_tab_id, url: R.conversation_url, request: R });
    assert.equal(w.sent.at(-1).complete, false); assert.deepEqual(updates, []); assert.deepEqual(w.storage, before); assert.deepEqual(w.contentCalls, []);
  }
});

test("completed known request observation does not dispatch a send or mint identity", async () => {
  const w = worker(); await w.call("restore", fixture.checkpoint);
  await w.call("maintenance", { maintenance_id: R.request_id, action: "observe_request", tab_id: R.target_tab_id, url: R.conversation_url,
    request: R, observation: { reply_wait_ms: 1000 } });
  const m = w.contentCalls.find((m) => m.type === "C2C_FRESH_OBSERVE");
  assert.deepEqual(m.request, R); assert.deepEqual(m.observation, { reply_wait_ms: 1000 });
  assert.equal(w.contentCalls.some((m) => m.type === "C2C_FRESH_REVIEW"), false);
});

for (const field of ["request_id", "control_id", "attempt_id", "expected_commit", "conversation_url"]) {
  test(`shared reply validator rejects probe ${field} and never forwards a result`, async () => {
    const w = worker(); await w.call("restore", fixture.checkpoint);
    w.sandbox.probe = { request: clone(R), field }; w.sandbox.probeId = R.request_id;
    w.run("pendingProbes.set(probeId, probe)");
    const before = clone(w.storage), answer = await w.call("probeContent", { probe_id: R.request_id, candidate: result(R) }, sender());
    assert.equal(answer.rejected, true); assert.ok(answer.rejection_code);
    assert.equal(w.sent.some((m) => m.type === "fresh_result"), false); assert.deepEqual(w.storage, before);
  });
}

test("diagnostics inspect known full Fresh wire without composer, click or reply acceptance", async () => {
  const root = { ...R, conversation_url: "https://chatgpt.com/" };
  const c = content([user(root), F.assistantMessage("completed")]);
  const pong = c.message({ type: "C2C_FRESH_PING", target_tab_id: R.target_tab_id, requests: [root] });
  assert.equal(pong.attempt_diagnostics[0].full_user_match, true);
  assert.equal(pong.attempt_diagnostics[0].assistant_after_match, true);
  assert.equal(pong.attempt_diagnostics[0].assistant_complete, true);
  assert.equal(pong.attempt_diagnostics[0].raw_reply, undefined);
  assert.ok(Array.isArray(pong.attempt_diagnostics[0].structure));
  assert.ok(JSON.stringify(pong.attempt_diagnostics).length <= 12000);
  assert.equal(pong.attempt_diagnostics[0].structure.some((n) => n.identity_text_sample && !n.contains_identity), false);
  assert.equal(c.clicks(), 0); assert.deepEqual(c.forbidden, []); assert.deepEqual(c.sent, []);
  for (const change of [{ target_tab_id: 8 }, { request_id: "unknown" }, { conversation_url: R.conversation_url + "wrong" }]) {
    const bad = c.message({ type: "C2C_FRESH_PING", target_tab_id: R.target_tab_id, requests: [{ ...root, ...change }] });
    assert.equal(bad.attempt_diagnostics.length, 0);
  }
});

function headed(role, text) {
  const payload = new F.FixtureNode("div", {}, text);
  const heading = new F.FixtureNode("h4", {}, role);
  const outer = new F.FixtureNode("div", {}, "", [heading, payload]);
  return { outer, payload, heading };
}
test("deep localized heading turns match full wire and first assistant without author attributes", () => {
  const u = headed("你说：", R.message), a = headed("ChatGPT 说：", "exact reply");
  let branch = new F.FixtureNode("div", {}, "", [u.outer, a.outer]);
  for (let i = 0; i < 15; i++) branch = new F.FixtureNode("div", {}, "", [branch]);
  const c = content([branch]); const L = c.sandbox.C2CV2FreshLocator;
  const match = L.findOriginalUserTurn(c.sandbox.document, { task_id: R.task_id, iteration: R.iteration, request_id: R.request_id,
    nonce: R.nonce, commit: R.expected_commit, original_message: R.message, control_id: R.control_id, attempt_id: R.attempt_id });
  assert.ok(match); assert.equal(L.findAssistantAfter(c.sandbox.document, match).text, "exact reply");
  assert.deepEqual(c.forbidden, []);
});
test("heading turns preserve unknown and unrelated user barriers and reject duplicate full users", () => {
  for (const middle of [headed("你说：", "unrelated"), headed("Unknown speaker", "unknown")]) {
    const u = headed("你说：", R.message), a = headed("ChatGPT 说：", "later reply");
    const c = content([u.outer, middle.outer, a.outer]); const L = c.sandbox.C2CV2FreshLocator;
    const turn = L.collectMessages(c.sandbox.document).find((m) => m.node === u.payload);
    assert.equal(L.findAssistantAfter(c.sandbox.document, turn), null);
  }
  const c = content([headed("你说：", R.message).outer, headed("你说：", R.message).outer]);
  const L = c.sandbox.C2CV2FreshLocator;
  assert.equal(L.findOriginalUserTurn(c.sandbox.document, { task_id: R.task_id, iteration: R.iteration, request_id: R.request_id,
    nonce: R.nonce, commit: R.expected_commit, original_message: R.message, control_id: R.control_id, attempt_id: R.attempt_id }), null);
});

test("paired heading completion requires assistant copy evidence and rejects user-only, streaming and another turn", () => {
  for (const kind of ["valid", "user_only", "streaming", "another_user", "unknown"] ) {
    const u = headed("你说：", R.message), a = headed("ChatGPT 说：", "reply");
    if (kind === "streaming") a.payload.attributes["data-message-status"] = "streaming";
    const button = new F.FixtureNode("button", { "aria-label": kind === "user_only" ? "复制消息" : "复制" });
    const extra = kind === "another_user" ? headed("你说：", "later user") : kind === "unknown" ? headed("Unknown speaker", "later unknown") : null;
    const pair = new F.FixtureNode("div", {}, "", [u.outer, a.outer, ...(extra ? [extra.outer] : []), button]);
    pair.querySelectorAll = (selector) => selector.startsWith("h4") ? [u.heading, a.heading, ...(extra ? [extra.heading] : [])]
      : selector.startsWith("button") ? [button] : [];
    const c = content([pair]), L = c.sandbox.C2CV2FreshLocator;
    const messages = L.collectMessages(c.sandbox.document), userTurn = messages.find((m) => m.node === u.payload), assistant = messages.find((m) => m.node === a.payload);
    assert.equal(L.isAssistantComplete(c.sandbox.document, assistant, userTurn), kind === "valid", kind);
  }
});
test("Fresh observation matches existing attempt and never accesses composer or sends even with may_send true", async () => {
  const c = content([user(), F.assistantMessage("late real-style reply")]);
  c.message({ type: "C2C_FRESH_OBSERVE", request: R, may_send: true }); await c.settle();
  assert.equal(c.sent.find((m) => m.type === "C2C_FRESH_RESULT").raw_reply, "late real-style reply");
  assert.equal(c.clicks(), 0); assert.deepEqual(c.forbidden, []);
  const missing = content([]); missing.message({ type: "C2C_FRESH_OBSERVE", request: R, may_send: true }); await missing.settle();
  assert.equal(missing.sent.at(-1).error_code, "outgoing_turn_not_confirmed"); assert.deepEqual(missing.forbidden, []);
});
test("background observation requires exact saved attempt and native target; no new dispatch or injection", async () => {
  const root = { ...R, conversation_url: "https://chatgpt.com/" }, w = worker();
  await w.call("restore", { ...fixture.checkpoint, requests: [root] });
  const command = { maintenance_id: R.request_id, action: "observe_attempt", tab_id: R.target_tab_id, url: R.conversation_url, request: root };
  await w.call("maintenance", command);
  assert.equal(w.sent.at(-1).complete, true);
  assert.equal(w.contentCalls.filter((m) => m.type === "C2C_FRESH_OBSERVE").length, 1);
  assert.equal(w.contentCalls.some((m) => m.type === "C2C_FRESH_REVIEW"), false); assert.deepEqual(w.forbidden, []);
  for (const change of [{ request: { ...root, control_id: "wrong" } }, { tab_id: 8 }, { url: R.conversation_url+"wrong" }]) {
    const count = w.contentCalls.filter((m) => m.type === "C2C_FRESH_OBSERVE").length;
    await w.call("maintenance", { ...command, ...change }); assert.equal(w.sent.at(-1).complete, false);
    assert.equal(w.contentCalls.filter((m) => m.type === "C2C_FRESH_OBSERVE").length, count);
  }
});

test("pending Fresh root transition content maintenance preserves mirror root without sending", async () => {
  const root = { ...R, conversation_url: "https://chatgpt.com/" }, injections = [];
  const w = worker({ executeScript: async (value) => injections.push(clone(value)) });
  await w.call("restore", { ...fixture.checkpoint, requests: [root] });
  await w.call("maintenance", { maintenance_id: R.request_id, action: "reload_content", tab_id: R.target_tab_id, url: R.conversation_url });
  assert.equal(injections.length, 1); assert.equal(w.sent.at(-1).complete, true);
  assert.equal(w.storage["c2c.fresh.v3.attemptMirror"][0].conversation_url, "https://chatgpt.com/");
  assert.equal(w.contentCalls.some((m) => m.type === "C2C_FRESH_REVIEW"), false);
});

test("stale sender URL remains rejected and provides a machine-readable rejection code", async () => {
  const w = worker(); await w.call("restore", fixture.checkpoint);
  await w.call("content", result(R, { content_identity: { ...I, url: R.conversation_url } }), { ...sender(), url: "https://chatgpt.com/" });
  assert.equal(w.sent.at(-1).type, "fresh_diagnostic"); assert.equal(w.sent.at(-1).code, "sender_url_mismatch");
  assert.equal(w.sent.some((m) => m.type === "fresh_result" || m.type === "fresh_bound"), false);
});

test("maintenance content update is limited to exact unique Fresh setup root and files", async () => {
  const injections = [], tabs = [{ id: 7, url: "https://chatgpt.com/", status: "complete" }];
  const w = worker({ tabs, executeScript: async (value) => { injections.push(clone(value)); } });
  await w.call("restore", { ...fixture.checkpoint, requests: [] });
  await w.call("maintenance", { maintenance_id: R.request_id, action: "reload_content", tab_id: 7, url: tabs[0].url });
  assert.equal(injections.length, 1); assert.deepEqual(injections[0].target, { tabId: 7 });
  assert.deepEqual(injections[0].files, ["fresh_component_identity.js", "fresh_contract.js", "fresh_locator.js", "fresh_content.js"]);
  assert.equal(w.sent.at(-1).complete, true); assert.equal(w.contentCalls.some((m) => m.type === "C2C_FRESH_REVIEW"), false);
});

test("maintenance rejects wrong tab, duplicate, old thread and unknown command without injecting", async () => {
  for (const change of [{ tab_id: 8 }, { url: "https://chatgpt.com/c/6abcb6a6-a1b8-83e8-bc72-f85af94bb2f0" }, { action: "send" }]) {
    const w = worker({ tabs: [{ id: 7, url: "https://chatgpt.com/", status: "complete" }] });
    await w.call("restore", { ...fixture.checkpoint, requests: [] });
    await w.call("maintenance", { maintenance_id: R.request_id, action: "reload_content", tab_id: 7, url: "https://chatgpt.com/", ...change });
    assert.equal(w.sent.at(-1).complete, false); assert.deepEqual(w.forbidden, []);
  }
  const w = worker({ tabs: [{ id: 7, url: "https://chatgpt.com/", status: "complete" }, { id: 8, url: "https://chatgpt.com/", status: "complete" }] });
  await w.call("restore", { ...fixture.checkpoint, requests: [] });
  await w.call("maintenance", { maintenance_id: R.request_id, action: "reload_content", tab_id: 7, url: "https://chatgpt.com/" });
  assert.equal(w.sent.at(-1).complete, false); assert.deepEqual(w.forbidden, []);
});
