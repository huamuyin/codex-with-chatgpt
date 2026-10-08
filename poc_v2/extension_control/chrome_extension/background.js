"use strict";

importScripts("component_identity.js", "adapter_contract.js");
const HTTP_BASE = "http://" + globalThis.C2CV2ComponentIdentity.bridge_host + ":" + globalThis.C2CV2ComponentIdentity.bridge_port;
const WS_URL = "ws://" + globalThis.C2CV2ComponentIdentity.bridge_host + ":" + globalThis.C2CV2ComponentIdentity.bridge_port + "/ws";
const CHAT_URL_PATTERN = "https://chatgpt.com/*";
const RECONNECT_ALARM = "c2c-control-reconnect";
const ADAPTER_VERSION = "0.8.1";
const Contract = globalThis.C2CV2AdapterContract;
const Identity = globalThis.C2CV2ComponentIdentity;
const SESSION_KEYS = {
  targetTabId: "c2c.targetTabId", targetConversationUrl: "c2c.targetConversationUrl.v2",
  inFlight: "c2c.inFlight", seenNonces: "c2c.seenNonces", lastResult: "c2c.lastResult",
  originals: "c2c.originalRequests.v2",
};
let socket = null;
let controlToken = null;
let bridgeIdentity = null;
let contentIdentity = null;
let connecting = false;
let reconnectTimer = null;
let keepAliveTimer = null;
let reconnectDelayMs = 1000;
let targetTabId = null;
let targetTabUrl = "";
let pinnedConversationUrl = "";
let tabReady = false;
const dispatching = new Map();
const recoveries = new Map();
const inspections = new Map();

function isChatUrl(value) { return Contract.isChatUrl(value); }
function manifestVersion() { return chrome.runtime.getManifest().version; }
function bridgeMatches(value) {
  return value?.bridge_version === ADAPTER_VERSION && value?.build_id === Identity.build_id
    && value?.host === Identity.bridge_host && value?.port === Identity.bridge_port
    && value?.protocol_version === Identity.protocol_version
    && value?.extension_id === chrome.runtime.id
    && ["normal", "inspection-only"].includes(value?.mode)
    && typeof value?.bridge_session_id === "string" && Boolean(value.bridge_session_id)
    && /^[a-f0-9]{64}$/u.test(value?.startup_source_sha256 || "")
    && Number.isInteger(value?.pid) && value.pid > 0;
}
function inspectionMode() { return bridgeIdentity?.mode === "inspection-only"; }
function versionsReady() {
  return Contract.componentMatches(Identity) && Contract.version === ADAPTER_VERSION
    && manifestVersion() === ADAPTER_VERSION && bridgeMatches(bridgeIdentity)
    && Contract.componentMatches(contentIdentity);
}
function bindTargetTab(tab) {
  if (!tab || !Number.isInteger(tab.id) || !isChatUrl(tab.url)) return false;
  if (targetTabId !== null && targetTabId !== tab.id) return false;
  if (pinnedConversationUrl && tab.url !== pinnedConversationUrl) return false;
  targetTabId = tab.id;
  targetTabUrl = tab.url;
  if (!pinnedConversationUrl && Contract.isConversationUrl(tab.url)) pinnedConversationUrl = tab.url;
  return true;
}
async function saveBinding() {
  await chrome.storage.session.set({
    [SESSION_KEYS.targetTabId]: targetTabId,
    [SESSION_KEYS.targetConversationUrl]: pinnedConversationUrl,
  });
}
function sendWire(value) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try { socket.send(JSON.stringify(value)); return true; } catch { return false; }
}
async function reportTabState(tab, connected) {
  const ready = Boolean(connected && tab && tab.id === targetTabId && tab.url === targetTabUrl
    && isChatUrl(tab.url) && versionsReady());
  sendWire({
    type: "tab_status", connected: ready, tab_id: ready ? tab.id : null, url: ready ? tab.url : "",
    protocol_version: Identity.protocol_version, background_version: ADAPTER_VERSION,
    content_version: contentIdentity?.version || "", manifest_version: manifestVersion(),
    background_build_id: Identity.build_id, content_build_id: contentIdentity?.build_id || "",
  });
}
async function findOrCreateTarget() {
  // Name retained for compatibility; this function never creates a tab or selects the active page.
  if (targetTabId === null) {
    const stored = await chrome.storage.session.get([SESSION_KEYS.targetTabId, SESSION_KEYS.targetConversationUrl]);
    if (Number.isInteger(stored[SESSION_KEYS.targetTabId])) {
      targetTabId = stored[SESSION_KEYS.targetTabId];
      pinnedConversationUrl = stored[SESSION_KEYS.targetConversationUrl] || "";
    } else {
      const tabs = await chrome.tabs.query({ url: CHAT_URL_PATTERN });
      if (tabs.length !== 1) return null;
      if (!bindTargetTab(tabs[0])) return null;
      await saveBinding();
    }
  }
  const tab = await chrome.tabs.get(targetTabId).catch(() => null);
  if (!bindTargetTab(tab)) { tabReady = false; return null; }
  await saveBinding();
  return tab;
}
async function ensureContentScript(tab, allowInjection = true) {
  if (!tab || tab.id !== targetTabId || !isChatUrl(tab.url) || !bindTargetTab(tab)) return false;
  tabReady = false;
  try {
    let response = await chrome.tabs.sendMessage(tab.id, { type: "C2C_PING", target_tab_id: tab.id }).catch(() => null);
    if (response === null && allowInjection) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id }, files: ["component_identity.js", "adapter_contract.js", "transcript_locator.js", "content.js"],
      });
      response = await chrome.tabs.sendMessage(tab.id, { type: "C2C_PING", target_tab_id: tab.id });
    }
    // An old string-only ping is not readiness and is not silently upgraded here.
    contentIdentity = response;
    if (response?.type !== "C2C_V2_CONTENT_READY" || response.url !== tab.url || !versionsReady()) {
      await reportTabState(tab, false); return false;
    }
    tabReady = true;
    await saveBinding();
    await reportTabState(tab, true);
    return true;
  } catch { await reportTabState(tab, false); return false; }
}
async function waitForConversationTabReady(tabId, conversationUrl, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.id !== tabId) return null;
    if (tab.status === "complete") {
      if (tab.url !== conversationUrl || !bindTargetTab(tab)) return null;
      if (await ensureContentScript(tab)) return tab;
    }
    // A loading tab may still report its previous URL; wait without navigating.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}
async function sendStatus() {
  const tab = targetTabId === null ? null : await chrome.tabs.get(targetTabId).catch(() => null);
  if (!tab || !bindTargetTab(tab)) tabReady = false;
  await reportTabState(tab, tabReady);
}
async function connect() {
  if (connecting || (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING))) return;
  connecting = true;
  try {
    const response = await fetch(HTTP_BASE + "/bootstrap", { method: "GET", cache: "no-store", credentials: "omit", redirect: "error" });
    if (!response.ok) throw new Error("bootstrap_failed");
    const body = await response.json();
    if (typeof body.control_token !== "string" || body.control_token.length < 40 || !bridgeMatches(body.bridge_identity)) throw new Error("bridge_version_mismatch");
    bridgeIdentity = body.bridge_identity;
    controlToken = body.control_token;
    if (!inspectionMode()) {
      const target = await findOrCreateTarget();
      if (target?.status === "complete") await ensureContentScript(target);
    }
    const ws = new WebSocket(WS_URL);
    socket = ws;
    ws.onopen = () => {
      reconnectDelayMs = 1000;
      ws.send(JSON.stringify({ type: "auth", control_token: controlToken }));
      chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 });
      if (keepAliveTimer !== null) clearInterval(keepAliveTimer);
      keepAliveTimer = setInterval(() => sendWire({ type: "ping" }), 20000);
    };
    ws.onmessage = (event) => { void handleWireMessage(event.data); };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      bridgeIdentity = null; controlToken = null; tabReady = false;
      if (keepAliveTimer !== null) clearInterval(keepAliveTimer);
      keepAliveTimer = null; scheduleReconnect();
    };
    ws.onerror = () => { try { ws.close(); } catch { /* close reports disconnect */ } };
  } catch { controlToken = null; tabReady = false; scheduleReconnect(); }
  finally { connecting = false; }
}
function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect(); }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30000);
}
function identityOf(r) {
  return { request_id: r.request_id, task_id: r.task_id, iteration: r.iteration,
    nonce: r.nonce, expected_commit: r.expected_commit };
}
async function originals() {
  return (await chrome.storage.session.get(SESSION_KEYS.originals))[SESSION_KEYS.originals] || {};
}
async function dispatchRequest(request, forcedResume) {
  if (inspectionMode()) {
    sendWire({ type: "review_error", ...identityOf(request || {}), error_code: "inspection_mode_locked" }); return;
  }
  if (!request?.request_id || !request.nonce || dispatching.has(request.request_id)) return;
  dispatching.set(request.request_id, true);
  try {
    const stored = await chrome.storage.session.get([SESSION_KEYS.inFlight, SESSION_KEYS.seenNonces]);
    const all = await originals();
    const known = all[request.request_id];
    const seen = stored[SESSION_KEYS.seenNonces] || [];
    const current = stored[SESSION_KEYS.inFlight];
    if (known && (JSON.stringify(identityOf(known)) !== JSON.stringify(identityOf(request)) || known.message !== request.message)) {
      sendWire({ type: "review_error", ...identityOf(request), error_code: "original_identity_mismatch" }); return;
    }
    if (!tabReady || !versionsReady() || request.target_tab_id !== targetTabId) {
      sendWire({ type: "review_error", ...identityOf(request), error_code: "chat_tab_unavailable" }); return;
    }
    const effectiveUrl = known?.conversation_url || request.conversation_url || targetTabUrl;
    const tabs = await chrome.tabs.query({ url: CHAT_URL_PATTERN });
    const matches = tabs.filter((tab) => tab.url === effectiveUrl);
    if (matches.length !== 1 || matches[0].id !== request.target_tab_id || matches[0].status !== "complete"
        || effectiveUrl !== targetTabUrl || (known && known.target_tab_id !== request.target_tab_id)
        || (known?.conversation_url && request.conversation_url && known.conversation_url !== request.conversation_url)
        || (!known && request.conversation_url && request.conversation_url !== targetTabUrl)) {
      sendWire({ type: "review_error", ...identityOf(request), error_code: "conversation_binding_mismatch" }); return;
    }
    if (!known && (forcedResume || seen.includes(request.nonce) || Object.keys(all).length >= 64)) {
      sendWire({ type: "review_error", ...identityOf(request), error_code: "original_evidence_missing" }); return;
    }
    if (!known) {
      all[request.request_id] = { ...request, schema: 2 };
      await chrome.storage.session.set({ [SESSION_KEYS.originals]: all });
    }
    const maySend = !forcedResume && !known && !seen.includes(request.nonce) && !current;
    await chrome.storage.session.set({
      [SESSION_KEYS.inFlight]: identityOf(request),
      [SESSION_KEYS.seenNonces]: seen.includes(request.nonce) ? seen : [...seen, request.nonce],
    });
    await chrome.tabs.sendMessage(targetTabId, { type: "C2C_REVIEW",
      request: { ...request, conversation_url: known?.conversation_url || request.conversation_url },
      may_send: maySend });
  } catch {
    sendWire({ type: "review_error", ...identityOf(request), error_code: "content_script_delivery_uncertain" });
  } finally { dispatching.delete(request.request_id); }
}
function recoveryError(request, code) {
  sendWire({ type: "recovery_error", ...identityOf(request), attempt: request.attempt,
    tab_id: request.target_tab_id, conversation_url: request.conversation_url, error_code: code });
}
async function dispatchOriginalRecovery(request) {
  if (inspectionMode()) { recoveryError(request || {}, "inspection_mode_locked"); return; }
  if (!request?.request_id || recoveries.has(request.request_id)) return;
  const all = await originals();
  const original = all[request.request_id];
  if (!Contract.sameOriginal(request, original)) { recoveryError(request, "original_identity_mismatch"); return; }
  if (!versionsReady() || !tabReady || targetTabId !== original.target_tab_id
      || pinnedConversationUrl !== original.conversation_url) {
    recoveryError(request, "conversation_binding_mismatch"); return;
  }
  const tabs = await chrome.tabs.query({ url: CHAT_URL_PATTERN });
  const matches = tabs.filter((tab) => tab.url === original.conversation_url);
  if (matches.length !== 1 || matches[0].id !== original.target_tab_id
      || Contract.decideRecoveryTarget({ targetTabId: matches[0].id, targetUrl: matches[0].url,
        conversationUrl: original.conversation_url, originalTabId: original.target_tab_id }) !== "reuse-same-tab") {
    recoveryError(request, "conversation_binding_mismatch"); return;
  }
  if (!(await ensureContentScript(matches[0], false))) { recoveryError(request, "component_version_mismatch"); return; }
  recoveries.set(request.request_id, request);
  try {
    // DOM-only operation: no navigation, composer, normal dispatch, nonce allocation, or send queue.
    await chrome.tabs.sendMessage(original.target_tab_id, { type: "C2C_RECOVER_ORIGINAL", request });
  } catch {
    recoveries.delete(request.request_id); recoveryError(request, "content_script_delivery_uncertain");
  }
}
function inspectionError(r, code, bindingDiagnostic = null) {
  sendWire({ type: "inspection_error", request_id: r.request_id, task_id: r.task_id,
    iteration: r.iteration, expected_commit: r.expected_commit, inspection: r.inspection,
    tab_id: r.target_tab_id, conversation_url: r.conversation_url, error_code: code,
    ...(bindingDiagnostic ? { binding_diagnostic: bindingDiagnostic } : {}) });
}
function inspectionBindingDiagnostic(r, matches) {
  const reason = matches.length === 0 ? "no_matching_conversation_tab"
    : matches.length > 1 ? "duplicate_conversation_tabs"
    : matches[0].id !== r.target_tab_id ? "historical_tab_id_mismatch" : "original_tab_not_complete";
  return { schema: 1, requested_tab_id: r.target_tab_id, exact_url: r.conversation_url,
    reason, matching_tab_count: matches.length, truncated: matches.length > 4, authoritative: false,
    matching_tabs: [...matches].sort((a, b) => a.id - b.id).slice(0, 4).map((tab) => ({
      tab_id: tab.id, url: tab.url, status: ["loading", "complete"].includes(tab.status) ? tab.status : "unknown",
    })) };
}
async function dispatchInspection(r) {
  if (!r || !Number.isInteger(r.inspection) || inspections.has(r.inspection)) return;
  if (!bridgeMatches(bridgeIdentity) || manifestVersion() !== ADAPTER_VERSION
      || !Contract.componentMatches(Identity) || Contract.version !== ADAPTER_VERSION
      || !Number.isInteger(r.target_tab_id) || !Contract.isConversationUrl(r.conversation_url)) {
    inspectionError(r, "inspection_reference_invalid"); return;
  }
  const tabs = await chrome.tabs.query({ url: CHAT_URL_PATTERN });
  const matches = tabs.filter((tab) => tab.url === r.conversation_url);
  if (matches.length !== 1 || matches[0].id !== r.target_tab_id || matches[0].status !== "complete") {
    inspectionError(r, "inspection_binding_unconfirmed", inspectionBindingDiagnostic(r, matches)); return;
  }
  const pong = await chrome.tabs.sendMessage(r.target_tab_id, { type: "C2C_PING", target_tab_id: r.target_tab_id }).catch(() => null);
  if (!Contract.componentMatches(pong) || pong?.type !== "C2C_V2_CONTENT_READY" || pong.url !== r.conversation_url) {
    inspectionError(r, "inspection_component_mismatch"); return;
  }
  inspections.set(r.inspection, r);
  try {
    // No normal binding, original-state write, injection, navigation, recovery or send.
    await chrome.tabs.sendMessage(r.target_tab_id, { type: "C2C_INSPECT_ORIGINAL", request: r });
  } catch {
    inspections.delete(r.inspection); inspectionError(r, "inspection_delivery_uncertain");
  }
}
async function handleInspectionResult(m, sender) {
  const r = inspections.get(m.inspection);
  if (!r) return;
  const tab = await chrome.tabs.get(r.target_tab_id).catch(() => null);
  const good = sender.id === chrome.runtime.id && sender.tab?.id === r.target_tab_id
    && sender.url === r.conversation_url && tab?.url === r.conversation_url
    && m.conversation_url === r.conversation_url && Contract.componentMatches(m.content_identity)
    && ["request_id", "task_id", "iteration", "expected_commit", "inspection"].every((key) => m[key] === r[key]);
  inspections.delete(r.inspection);
  if (!good) { inspectionError(r, "inspection_identity_mismatch"); return; }
  sendWire({ ...m, type: m.error_code ? "inspection_error" : "inspection_result",
    tab_id: sender.tab.id, authoritative: false, original_nonce_verified: false, recovered_original: false });
}
async function handleWireMessage(raw) {
  let m; try { m = JSON.parse(raw); } catch { return; }
  if (m.type === "welcome") {
    if (!bridgeMatches(m.bridge_identity)) { tabReady = false; bridgeIdentity = null; await sendStatus(); return; }
    bridgeIdentity = m.bridge_identity;
    if (inspectionMode()) {
      // Read-only mode never auto-binds, injects, reads/replays cached requests or resumes recovery.
      tabReady = false;
      await reportTabState(null, false);
      return;
    }
    const target = await findOrCreateTarget();
    if (target) await ensureContentScript(target);
    await sendStatus();
    const result = (await chrome.storage.session.get(SESSION_KEYS.lastResult))[SESSION_KEYS.lastResult];
    if (result) sendWire({ type: "review_result", ...result });
    if (m.pending_request) await dispatchRequest(m.pending_request, true);
    if (m.pending_recovery) await dispatchOriginalRecovery(m.pending_recovery);
  } else if (m.type === "review") await dispatchRequest(m.request, Boolean(m.resume));
  else if (m.type === "inspect_original") await dispatchInspection(m.request);
  else if (m.type === "recover_original") await dispatchOriginalRecovery(m.request);
  else if (m.type === "recovery_ack") recoveries.delete(m.request_id);
  else if (m.type === "result_ack") {
    const stored = await chrome.storage.session.get([SESSION_KEYS.lastResult, SESSION_KEYS.inFlight]);
    if (stored[SESSION_KEYS.lastResult]?.request_id === m.request_id || stored[SESSION_KEYS.inFlight]?.request_id === m.request_id) {
      await chrome.storage.session.remove([SESSION_KEYS.lastResult, SESSION_KEYS.inFlight]);
    }
  }
}
async function handleContentMessage(m, sender) {
  if (m.type === "C2C_INSPECTION_RESULT") { await handleInspectionResult(m, sender); return; }
  if (sender.id !== chrome.runtime.id || !sender.tab || sender.tab.id !== targetTabId || !isChatUrl(sender.url)) return;
  const tab = await chrome.tabs.get(sender.tab.id).catch(() => null);
  if (!tab) { tabReady = false; await reportTabState(null, false); return; }
  if (m.type === "C2C_CONTENT_READY") {
    if (!bindTargetTab(tab)) return;
    if (!Contract.componentMatches(m) || m.url !== tab.url) { tabReady = false; await reportTabState(tab, false); return; }
    await ensureContentScript(tab);
    return;
  }
  const all = await originals();
  const original = all[m.request_id];
  if (m.type === "C2C_RECOVERY_RESULT") {
    const request = recoveries.get(m.request_id);
    if (!request) return;
    const same = Contract.sameOriginal(request, original)
      && ["request_id", "task_id", "iteration", "nonce", "expected_commit", "attempt"].every((key) => m[key] === request[key])
      && sender.tab.id === request.target_tab_id && sender.url === request.conversation_url
      && m.conversation_url === request.conversation_url && tab.url === request.conversation_url
      && Contract.componentMatches(m.content_identity) && versionsReady();
    if (!same) { recoveryError(request, "recovery_response_identity_invalid"); return; }
    sendWire({ ...m, type: m.error_code ? "recovery_error" : "recovery_result",
      tab_id: sender.tab.id, conversation_url: m.conversation_url });
    return;
  }
  if (!original || !["request_id", "task_id", "iteration", "nonce", "expected_commit"].every((key) => m[key] === original[key])) return;
  if (m.type === "C2C_REVIEW_BOUND") {
    if (tab.url !== m.conversation_url || !Contract.isConversationUrl(tab.url) || !bindTargetTab(tab)
        || (original.conversation_url && original.conversation_url !== tab.url)) return;
    if (!(await ensureContentScript(tab))) return;
    if (!original.conversation_url) {
      original.conversation_url = tab.url;
      await chrome.storage.session.set({ [SESSION_KEYS.originals]: all });
    }
    await saveBinding(); await reportTabState(tab, tabReady);
    sendWire({ type: "review_bound", ...identityOf(m), tab_id: sender.tab.id, conversation_url: m.conversation_url });
  } else if (m.type === "C2C_REVIEW_RESULT") {
    if (m.error_code) { sendWire({ type: "review_error", ...identityOf(m), error_code: m.error_code }); return; }
    const candidates = (await chrome.tabs.query({ url: CHAT_URL_PATTERN }))
      .filter((candidate) => candidate.url === original.conversation_url);
    const bound = candidates.length === 1 && candidates[0].id === original.target_tab_id
      && tab.status === "complete" && Contract.isConversationUrl(original.conversation_url)
      && sender.tab.id === original.target_tab_id && sender.url === original.conversation_url
      && tab.url === original.conversation_url && m.conversation_url === original.conversation_url
      && Contract.componentMatches(m.content_identity) && versionsReady()
      && m.assistant_generation_complete === true && m.reply_match_rule === "raw-exact-v1";
    if (!bound || typeof m.raw_reply !== "string" || m.raw_reply.length > 200000) {
      sendWire({ type: "review_error", ...identityOf(m), error_code: "normal_response_unconfirmed" }); return;
    }
    const result = { ...identityOf(m), raw_reply: m.raw_reply, selector_strategy: m.selector_strategy,
      tab_id: sender.tab.id, conversation_url: m.conversation_url,
      content_identity: m.content_identity, assistant_generation_complete: true, reply_match_rule: "raw-exact-v1" };
    await chrome.storage.session.set({ [SESSION_KEYS.lastResult]: result });
    sendWire({ type: "review_result", ...result });
  }
}
chrome.runtime.onMessage.addListener((m, sender) => { void handleContentMessage(m, sender).catch(() => {}); return false; });
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (id !== targetTabId) return;
  if (change.status === "loading") { tabReady = false; void reportTabState(tab, false); }
  if (change.status === "complete") {
    tabReady = false;
    if (bindTargetTab(tab)) void ensureContentScript(tab);
    else void reportTabState(tab, false);
  }
});
chrome.tabs.onRemoved.addListener((id) => {
  if (id !== targetTabId) return;
  // Preserve the missing target ID and URL; never silently select another tab.
  tabReady = false; void reportTabState(null, false);
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RECONNECT_ALARM) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) void connect(); else void sendStatus();
});
chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 }); void connect(); });
