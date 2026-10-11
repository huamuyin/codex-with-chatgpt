"use strict";
// Offline candidate only: one explicit creation; no send/retry/navigation/cleanup.
globalThis.C2CV2ReviewSessionSetup = (() => {
  const build = "c2c-v2-r6-new-review-session-offline-1", root = "https://chatgpt.com/";
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u, claimed = new Set();
  const keys = "bridge_session_id,build_id,iteration,namespace,nonce,review_commit,root_url,schema,setup_id";
  function validGrant(g, scope, bridge) {
    return g && typeof g === "object" && Object.keys(g).sort().join(",") === keys
      && g.schema === 1 && g.build_id === build && scope?.build_id === build
      && /^CHROME_R6_M3_FINAL_[A-Za-z0-9_-]{1,64}$/u.test(g.namespace || "")
      && g.namespace === scope.namespace && /^[a-f0-9]{40}$/u.test(g.review_commit || "")
      && g.review_commit === scope.review_commit && Number.isSafeInteger(g.iteration)
      && g.iteration >= 1 && g.iteration <= 1000 && g.iteration === scope.iteration
      && g.root_url === root && uuid.test(g.setup_id || "") && uuid.test(g.nonce || "")
      && g.setup_id !== g.nonce && uuid.test(g.bridge_session_id || "")
      && g.bridge_session_id === bridge?.bridge_session_id
      && (!scope.intent || Object.keys(g).every(k => scope.intent[k] === g[k])
        && Object.keys(scope.intent).length === Object.keys(g).length) && !scope.binding;
  }
  async function create(chrome, grant, scope, bridge) {
    if (!validGrant(grant, scope, bridge)) throw Error("new_review_grant_invalid");
    const key = "c2c.r6.newReviewSession." + grant.namespace;
    if (claimed.has(key)) throw Error("new_review_creation_already_consumed");
    claimed.add(key); // Synchronous latch precedes every await; competing commands lose.
    if ((await chrome.storage.session.get(key))[key]) throw Error("new_review_creation_already_consumed");
    const before = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
    const ids = before.map(t => t.id);
    if (ids.length > 256 || ids.some(x => !Number.isSafeInteger(x) || x < 0) || new Set(ids).size !== ids.length
        || before.some(t => t.url === root || t.pendingUrl === root)) throw Error("new_review_root_ambiguous");
    // Persist a latch before native creation. Worker death cannot create again.
    await chrome.storage.session.set({ [key]: { build_id: build, grant, state: "creation_started" } });
    const created = await chrome.tabs.create({ url: root, active: false });
    if (!Number.isSafeInteger(created?.id) || created.id < 0 || ids.includes(created.id)) throw Error("new_review_native_id_unconfirmed");
    const tab = await chrome.tabs.get(created.id), after = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
    const roots = after.filter(t => t.url === root || t.pendingUrl === root);
    if (tab?.id !== created.id || !["loading", "complete"].includes(tab.status)
        || ![undefined, "", root].includes(tab.url) || ![undefined, "", root].includes(tab.pendingUrl)
        || tab.url !== root && tab.pendingUrl !== root
        || tab.status === "complete" && (tab.url !== root || Boolean(tab.pendingUrl))
        || roots.length !== 1 || roots[0].id !== created.id) throw Error("new_review_native_creation_unconfirmed");
    const proof = { grant, tab_id: created.id, before_tab_ids: ids, creation_observed: true,
      status: tab.status, url: tab.url || "", pending_url: tab.pendingUrl || "" };
    await chrome.storage.session.set({ [key]: { build_id: build, grant, state: "created", proof } });
    return proof;
  }
  function readyProof(scope) {
    const g = scope?.intent, b = scope?.binding;
    if (!g || !b || !Number.isSafeInteger(b.tab_id)) return null;
    return { build_id: build, namespace: g.namespace, setup_id: g.setup_id, nonce: g.nonce,
      review_commit: g.review_commit, iteration: g.iteration, tab_id: b.tab_id };
  }
  function validScope(s) {
    if (!s || typeof s !== "object" || Object.keys(s).sort().join(",") !== "binding,build_id,intent,iteration,namespace,review_commit"
        || s.build_id !== build || !/^CHROME_R6_M3_FINAL_[A-Za-z0-9_-]{1,64}$/u.test(s.namespace || "")
        || !/^[a-f0-9]{40}$/u.test(s.review_commit || "") || !Number.isSafeInteger(s.iteration)
        || s.iteration < 1 || s.iteration > 1000) return false;
    if (s.intent === null) return s.binding === null;
    if (!validGrant(s.intent, { ...s, binding: null }, { bridge_session_id: s.intent?.bridge_session_id })) return false;
    if (s.binding === null) return true; // Consumed unconfirmed creation; never retry it.
    const b = s.binding, ids = b.before_tab_ids;
    return b && typeof b === "object" && b.grant && Object.keys(s.intent).every(k => b.grant[k] === s.intent[k])
      && Object.keys(b.grant).length === Object.keys(s.intent).length
      && Number.isSafeInteger(b.tab_id) && b.tab_id >= 0 && Array.isArray(ids) && ids.length <= 256
      && ids.every(x => Number.isSafeInteger(x) && x >= 0) && new Set(ids).size === ids.length && !ids.includes(b.tab_id)
      && b.creation_observed === true && ["loading", "complete"].includes(b.status)
      && ["", root].includes(b.url) && ["", root].includes(b.pending_url)
      && (b.url === root || b.pending_url === root) && (b.status !== "complete" || b.url === root && !b.pending_url);
  }
  function validRequest(r, s) {
    return Boolean(s?.binding && r?.target_tab_id === s.binding.tab_id && r.task_id === "C2C_V2_CHROME_R6_M3"
      && r.repo === "huamuyin/codex-with-chatgpt" && r.branch === "codex/c2c-v2-chrome-r6"
      && r.expected_commit === s.review_commit && r.iteration === s.iteration);
  }
  return Object.freeze({ build, root, create, readyProof, validGrant, validScope, validRequest });
})();
