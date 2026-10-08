"use strict";
globalThis.C2CV2FreshContract = (() => {
  const I = globalThis.C2CV2FreshIdentity;
  const CONTRACT_VERSION = "0.9.8", CONTRACT_BUILD = "c2c-v2-fresh-paired-turn-completion-1";
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  function isChatUrl(value) { return value === "https://chatgpt.com/" || isConversationUrl(value); }
  function isConversationUrl(value) { return /^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9_-]{1,128}$/u.test(value || ""); }
  function componentMatches(value) { return value?.protocol_version === 3 && value?.version === CONTRACT_VERSION && value?.build_id === CONTRACT_BUILD; }
  function validRequest(r) {
    if (!r || !uuid.test(r.request_id || "") || r.request_id === "4754374f-14dd-4004-bf87-3b87972e17fa"
        || !uuid.test(r.control_id || "") || r.nonce !== r.control_id || !Number.isInteger(r.attempt_id) || r.attempt_id < 1
        || !/^[A-Za-z0-9_.:-]{1,96}$/u.test(r.task_id || "") || !Number.isInteger(r.iteration) || r.iteration < 1
        || !/^[a-fA-F0-9]{40}$/u.test(r.expected_commit || "") || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(r.repo || "")
        || typeof r.branch !== "string" || !r.branch || !Number.isInteger(r.target_tab_id) || r.target_tab_id < 0
        || !isChatUrl(r.conversation_url) || typeof r.message !== "string" || r.message.length > 16000) return false;
    const L = globalThis.C2CV2FreshLocator;
    const f = L?.extractMarkers(r.message);
    return Boolean(f && f.request_id === r.request_id && f.control_id === r.control_id && f.attempt_id === r.attempt_id
      && f.task_id === r.task_id && f.iteration === r.iteration && f.commit === r.expected_commit && f.nonce === r.control_id);
  }
  function identityOf(r) { return Object.fromEntries(["request_id", "control_id", "attempt_id", "task_id", "iteration", "repo", "branch", "expected_commit"].map((k) => [k, r[k]])); }
  function sameAttempt(a, b) { return Boolean(a && b && JSON.stringify(identityOf(a)) === JSON.stringify(identityOf(b))
    && a.message === b.message && a.target_tab_id === b.target_tab_id && a.conversation_url === b.conversation_url); }
  function key(r) { return `${r.request_id}/${r.control_id}/${r.attempt_id}`; }
  function decideSend({ userTurnFound, nonceObserved, maySend, composerText }) {
    if (userTurnFound) return "transcript-resume";
    if (nonceObserved) return "identity-conflict";
    if (!maySend) return "uncertain-no-send";
    if (String(composerText || "").trim()) return "composer-not-empty";
    return "send-once"; // One click per attempt; another attempt is explicitly allowed.
  }
  return Object.freeze({ version: CONTRACT_VERSION, build_id: CONTRACT_BUILD, isChatUrl, isConversationUrl,
    componentMatches, validRequest, identityOf, sameAttempt, key, decideSend });
})();
