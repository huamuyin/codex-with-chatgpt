"use strict";
importScripts("fresh_component_identity.js", "fresh_contract.js", "fresh_locator.js");
const I = globalThis.C2CV2FreshIdentity, C = globalThis.C2CV2FreshContract;
const BACKGROUND_VERSION = "0.9.8", BACKGROUND_BUILD = "c2c-v2-fresh-paired-turn-completion-1";
const BASE = `http://${I.host}:${I.port}`, WS = `ws://${I.host}:${I.port}/ws`;
const CACHE_KEY = "c2c.fresh.v3.attemptMirror";
let socket = null, bridge = null, connecting = false, mirrorReady = false, target = null;
let reconnectTimer = null, heartbeat = null;
let targetDiagnostic = { readiness_code: "not_checked", candidate_count: 0, tab_id: null, url: "", content_version: "", content_generation: null };
const LEGACY_SMOKE_URL = "https://chatgpt.com/c/6abcb6a6-a1b8-83e8-bc72-f85af94bb2f0";
const attempts = new Map(), running = new Set();
const pendingProbes = new Map();

function bridgeMatches(b) { return I.version === BACKGROUND_VERSION && I.build_id === BACKGROUND_BUILD
  && C.version === BACKGROUND_VERSION && C.build_id === BACKGROUND_BUILD
  && globalThis.C2CV2FreshLocator.version === BACKGROUND_VERSION && globalThis.C2CV2FreshLocator.build_id === BACKGROUND_BUILD
  && b?.version === BACKGROUND_VERSION && b?.build_id === BACKGROUND_BUILD && b?.protocol_version === 3
  && b?.host === I.host && b?.port === I.port && b?.extension_id === chrome.runtime.id && b?.delivery_semantics === "AT_LEAST_ONCE"
  && typeof b?.bridge_session_id === "string" && Boolean(b.bridge_session_id)
  && Number.isInteger(b?.pid) && b.pid > 0 && /^[a-f0-9]{64}$/u.test(b?.source_sha256 || ""); }
function send(m) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(m)); }
async function saveMirror() { await chrome.storage.session.set({ [CACHE_KEY]: [...attempts.values()] }); }
async function restore(checkpoint) {
  mirrorReady = false;
  if (checkpoint?.schema !== 1 || checkpoint?.protocol_version !== 3 || checkpoint?.delivery_semantics !== "AT_LEAST_ONCE"
      || !Array.isArray(checkpoint.requests)) throw Error("checkpoint_invalid");
  const checked = new Map(), logical = new Map();
  for (const r of checkpoint.requests) {
    if (!C.validRequest(r) || checked.has(C.key(r))) throw Error("checkpoint_attempt_invalid");
    const prior = logical.get(r.request_id);
    if (prior && ["control_id", "task_id", "iteration", "repo", "branch", "expected_commit"].some((k) => r[k] !== prior[k])) throw Error("checkpoint_logical_conflict");
    logical.set(r.request_id, r); checked.set(C.key(r), r);
  }
  // No legacy storage import and no replay: the bridge's verified checkpoint replaces this expendable mirror.
  attempts.clear(); for (const [k, r] of checked) attempts.set(k, r);
  await saveMirror(); mirrorReady = true;
}
async function selectTarget(preferredUrl = null) {
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  const matches = tabs.filter((t) => t.url !== LEGACY_SMOKE_URL && (preferredUrl ? t.url === preferredUrl : C.isChatUrl(t.url)));
  targetDiagnostic = { readiness_code: matches.length === 0 ? "no_target" : "target_ambiguous",
    candidate_count: matches.length, tab_id: matches.length === 1 ? matches[0].id : null,
    url: matches.length === 1 ? matches[0].url : "", content_version: "", content_generation: null };
  if (matches.length !== 1 || matches[0].status !== "complete") { target = null; return null; }
  const tab = matches[0];
  const pong = await chrome.tabs.sendMessage(tab.id, { type: "C2C_FRESH_PING", target_tab_id: tab.id }).catch(() => null);
  targetDiagnostic.content_version = pong?.version || "";
  targetDiagnostic.content_generation = Number.isSafeInteger(pong?.content_generation) ? pong.content_generation : null;
  targetDiagnostic.readiness_code = pong ? "content_identity_mismatch" : "content_unavailable";
  if (pong?.type !== "C2C_FRESH_READY" || pong.url !== tab.url || !C.componentMatches(pong)
      || chrome.runtime.getManifest().version !== I.version) { target = null; return null; }
  targetDiagnostic.readiness_code = "ready"; target = tab; return tab;
}
async function status() {
  const urls = new Set([...attempts.values()].map((r) => r.conversation_url).filter(C.isConversationUrl));
  const tab = mirrorReady && urls.size <= 1 ? await selectTarget([...urls][0] || null) : null;
  let diagnostics = [];
  if (tab) {
    const requests = [...attempts.values()].filter((r) => r.target_tab_id === tab.id
      && (r.conversation_url === tab.url || r.conversation_url === "https://chatgpt.com/")).slice(-10);
    const pong = await chrome.tabs.sendMessage(tab.id, { type: "C2C_FRESH_PING", target_tab_id: tab.id, requests }).catch(() => null);
    if (C.componentMatches(pong) && pong.url === tab.url) diagnostics = pong.attempt_diagnostics || [];
    if (JSON.stringify(diagnostics).length > 12000) diagnostics = [];
  }
  send({ type: "fresh_status", connected: Boolean(tab && bridgeMatches(bridge)), candidate_count: targetDiagnostic.candidate_count,
    tab_id: targetDiagnostic.tab_id, url: targetDiagnostic.url, readiness_code: targetDiagnostic.readiness_code,
    attempt_diagnostics: diagnostics,
    content_generation: targetDiagnostic.content_generation,
    components: { protocol_version: 3, background_version: BACKGROUND_VERSION,
      content_version: targetDiagnostic.content_version, manifest_version: chrome.runtime.getManifest().version, build_id: I.build_id } });
}
async function maintenance(m) {
  if (!mirrorReady || !bridgeMatches(bridge) || !/^[a-f0-9-]{36}$/u.test(m.maintenance_id || "")) return;
  try {
    if (m.action === "sample_status") {
      await status();
    } else if (["reload_content", "reload_tab", "observe_attempt", "observe_request", "probe_reply_rejection"].includes(m.action)) {
      const allowed = m.url === "https://chatgpt.com/" && attempts.size === 0
        || [...attempts.values()].some((r) => r.target_tab_id === m.tab_id && (r.conversation_url === m.url
          || r.conversation_url === "https://chatgpt.com/" && C.isConversationUrl(m.url)));
      const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
      const matches = tabs.filter((t) => t.url === m.url && t.url !== LEGACY_SMOKE_URL);
      if (!allowed || matches.length !== 1 || matches[0].id !== m.tab_id || matches[0].status !== "complete") throw Error("maintenance_target_unconfirmed");
      if (m.action === "reload_tab") {
        await chrome.tabs.reload(m.tab_id);
        send({ type: "fresh_maintenance_result", maintenance_id: m.maintenance_id, action: m.action, complete: true }); return;
      }
      const before = m.action === "reload_content" ? await chrome.tabs.sendMessage(m.tab_id,
        { type: "C2C_FRESH_PING", target_tab_id: m.tab_id }).catch(() => null) : null;
      if (m.action === "reload_content") await chrome.scripting.executeScript({ target: { tabId: m.tab_id },
        files: ["fresh_component_identity.js", "fresh_contract.js", "fresh_locator.js", "fresh_content.js"] });
      await status();
      if (!target || target.id !== m.tab_id || target.url !== m.url) throw Error("content_identity_mismatch");
      if (m.action === "reload_content" && (!Number.isSafeInteger(targetDiagnostic.content_generation)
          || targetDiagnostic.content_generation < 1 || Number.isSafeInteger(before?.content_generation)
          && targetDiagnostic.content_generation <= before.content_generation)) throw Error("content_reinjection_unconfirmed");
      if (["observe_attempt", "observe_request"].includes(m.action)) {
        const known = attempts.get(C.key(m.request || {}));
        if (!known || !C.validRequest(m.request) || !C.sameAttempt(known, m.request) || known.target_tab_id !== m.tab_id) throw Error("maintenance_attempt_unconfirmed");
        const answer = await chrome.tabs.sendMessage(m.tab_id, { type: "C2C_FRESH_OBSERVE", request: { ...known, conversation_url: m.url }, observation: m.observation || {} });
        if (answer?.accepted !== true) throw Error("content_observation_rejected");
      }
      if (m.action === "probe_reply_rejection") {
        const known = attempts.get(C.key(m.request || {}));
        if (!known || !C.sameAttempt(known, m.request)
            || !["request_id", "control_id", "attempt_id", "expected_commit", "conversation_url"].includes(m.field)) throw Error("probe_identity_unconfirmed");
        pendingProbes.set(m.maintenance_id, { request: known, field: m.field });
        try {
          const answer = await chrome.tabs.sendMessage(m.tab_id, { type: "C2C_FRESH_PROBE_REJECTION", probe_id: m.maintenance_id, request: known });
          send({ type: "fresh_maintenance_result", maintenance_id: m.maintenance_id, action: m.action,
            complete: answer?.rejected === true, rejected: answer?.rejected === true, field: m.field,
            rejection_code: answer?.rejection_code || "probe_unconfirmed" });
        } finally { pendingProbes.delete(m.maintenance_id); }
        return;
      }
    } else if (m.action !== "reload_extension") throw Error("maintenance_action_invalid");
    send({ type: "fresh_maintenance_result", maintenance_id: m.maintenance_id, action: m.action, complete: true,
      ...(Number.isSafeInteger(targetDiagnostic.content_generation) ? { content_generation: targetDiagnostic.content_generation } : {}) });
    if (m.action === "reload_extension") setTimeout(() => chrome.runtime.reload(), 100);
  } catch (error) {
    const code = /^[a-z0-9_]{1,64}$/u.test(error.message) ? error.message : "maintenance_failed";
    send({ type: "fresh_maintenance_result", maintenance_id: m.maintenance_id, action: m.action, complete: false, error_code: code });
  }
}
async function dispatch(r, observation = {}) {
  if (!mirrorReady || !bridgeMatches(bridge) || !C.validRequest(r)) throw Error("fresh_request_invalid");
  const k = C.key(r), known = attempts.get(k);
  if (known && !C.sameAttempt(known, r)) throw Error("attempt_identity_conflict");
  if (running.has(k)) return;
  const logical = [...attempts.values()].find((a) => a.request_id === r.request_id);
  if (logical && ["control_id", "task_id", "iteration", "repo", "branch", "expected_commit"].some((f) => logical[f] !== r[f])) throw Error("logical_identity_conflict");
  const tab = await selectTarget(r.conversation_url);
  if (!tab || tab.id !== r.target_tab_id) throw Error("attempt_binding_unconfirmed");
  attempts.set(k, r); await saveMirror(); running.add(k);
  try {
    // A new attempt can send even when a previous attempt for this logical request is known.
    await chrome.tabs.sendMessage(tab.id, { type: "C2C_FRESH_REVIEW", request: r, may_send: !known, observation });
  } catch (error) { running.delete(k); throw error; }
}
async function wire(raw) {
  const m = JSON.parse(raw);
  if (m.type === "fresh_welcome") {
    if (!bridgeMatches(m.bridge_identity)) throw Error("bridge_version_mismatch");
    bridge = m.bridge_identity; await restore(m.checkpoint); await status();
  } else if (m.type === "fresh_maintenance") {
    await maintenance(m);
  } else if (m.type === "fresh_review") {
    try { await dispatch(m.request, m.observation || {}); }
    catch (e) { const code = /^[a-z0-9_]{1,64}$/u.test(e.message) ? e.message : "delivery_uncertain";
      send({ type: "fresh_error", ...C.identityOf(m.request || {}), error_code: code }); }
  } else if (m.type === "fresh_result_ack") running.delete(C.key(m));
}
async function inspectContent(m, sender) {
  if (!["C2C_FRESH_BOUND", "C2C_FRESH_RESULT"].includes(m?.type) || sender.id !== chrome.runtime.id || !sender.tab) return { error: "sender_identity_mismatch" };
  const r = attempts.get(C.key(m));
  if (!r) return { error: "request_identity_unknown" };
  if (Object.keys(C.identityOf(r)).some((k) => m[k] !== r[k])) return { error: "reply_identity_mismatch", r };
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  const tab = tabs.find((t) => t.id === r.target_tab_id);
  if (!tab || sender.tab.id !== r.target_tab_id || sender.url !== tab.url || !C.componentMatches(m.content_identity)) {
    return { error: !tab ? "tab_missing" : sender.tab.id !== r.target_tab_id ? "sender_tab_mismatch"
      : sender.url !== tab.url ? "sender_url_mismatch" : "content_version_mismatch", r, tab };
  }
  if (m.error_code) return { r, tab };
  if (!C.isConversationUrl(tab.url) || m.conversation_url !== tab.url || tab.status !== "complete"
      || tabs.filter((t) => t.url === tab.url).length !== 1
      || (r.conversation_url !== "https://chatgpt.com/" && r.conversation_url !== tab.url)) return { error: "reply_binding_unconfirmed", r, tab };
  if (m.type === "C2C_FRESH_RESULT" && (m.assistant_generation_complete !== true || typeof m.raw_reply !== "string" || !m.raw_reply.trim())) return { error: "reply_not_complete", r, tab };
  return { r, tab };
}
async function probeContent(m, sender) {
  const pending = pendingProbes.get(m.probe_id);
  if (!pending || !m.candidate || !C.sameAttempt(pending.request, attempts.get(C.key(pending.request)))) return { rejected: false, error_code: "probe_unknown" };
  const base = await inspectContent(m.candidate, sender);
  if (base.error || C.key(m.candidate) !== C.key(pending.request)) return { rejected: false, error_code: "probe_base_unconfirmed" };
  const candidate = { ...m.candidate };
  const values = { request_id: "00000000-0000-4000-8000-000000000000", control_id: "00000000-0000-4000-8000-000000000001",
    attempt_id: pending.request.attempt_id + 100000, expected_commit: "0".repeat(40), conversation_url: "https://chatgpt.com/c/invalid-authority-probe" };
  candidate[pending.field] = values[pending.field];
  const checked = await inspectContent(candidate, sender);
  // A probe never forwards any result, even if the shared validator unexpectedly accepts it.
  return { rejected: Boolean(checked.error), rejection_code: checked.error || "probe_unexpected_accept" };
}
async function content(m, sender) {
  const checked = await inspectContent(m, sender), { r, tab } = checked;
  if (checked.error) {
    if (r && ["tab_missing", "sender_tab_mismatch", "sender_url_mismatch", "content_version_mismatch"].includes(checked.error)) {
      send({ type: "fresh_diagnostic", ...C.identityOf(r), code: checked.error,
        sender_url: sender.url, tab_url: tab?.url, content_url: m.content_identity?.url });
    }
    return;
  }
  if (m.error_code) { running.delete(C.key(m)); send({ type: "fresh_error", ...C.identityOf(r), error_code: m.error_code }); return; }
  r.conversation_url = tab.url; await saveMirror(); await status();
  if (m.type === "C2C_FRESH_BOUND") {
    send({ type: "fresh_bound", ...C.identityOf(r), tab_id: tab.id, conversation_url: tab.url }); return;
  }
  if (m.assistant_generation_complete !== true || typeof m.raw_reply !== "string" || !m.raw_reply.trim()) return;
  send({ type: "fresh_result", ...C.identityOf(r), tab_id: tab.id, conversation_url: tab.url,
    raw_reply: m.raw_reply, assistant_generation_complete: true,
    content_identity: { version: I.version, build_id: I.build_id, protocol_version: 3 } });
}
async function connect() {
  if (connecting || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  connecting = true;
  try {
    const response = await fetch(BASE + "/bootstrap", { method: "POST", cache: "no-store", credentials: "omit", redirect: "error" });
    const b = await response.json();
    if (!response.ok || !bridgeMatches(b.bridge_identity) || typeof b.control_token !== "string" || b.control_token.length < 40) throw Error("bootstrap_invalid");
    const ws = new WebSocket(WS); socket = ws; bridge = b.bridge_identity;
    ws.onopen = () => { ws.send(JSON.stringify({ type: "auth", control_token: b.control_token }));
      if (heartbeat !== null) clearInterval(heartbeat); heartbeat = setInterval(() => send({ type: "ping" }), 20000); };
    ws.onmessage = (e) => { void wire(e.data).catch(() => { mirrorReady = false; void status(); }); };
    ws.onclose = () => { if (socket === ws) socket = null; bridge = null; mirrorReady = false; target = null;
      if (heartbeat !== null) clearInterval(heartbeat); heartbeat = null; scheduleReconnect(); };
    ws.onerror = () => ws.close();
  } catch { scheduleReconnect(); }
  finally { connecting = false; }
}
function scheduleReconnect() { if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect(); }, 2000); }
chrome.runtime.onMessage.addListener((m, s, respond) => {
  if (m?.type === "C2C_FRESH_PROBE_RESULT") { void probeContent(m, s).then(respond).catch(() => respond({ rejected: false, error_code: "probe_error" })); return true; }
  void content(m, s).catch(() => {}); return false;
});
chrome.tabs.onUpdated.addListener(() => { void status(); });
chrome.tabs.onRemoved.addListener(() => { void status(); });
chrome.alarms.onAlarm.addListener(() => { if (!socket || socket.readyState !== WebSocket.OPEN) void connect(); else void status(); });
chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create("c2c-fresh-reconnect", { periodInMinutes: 1 }); void connect(); });
