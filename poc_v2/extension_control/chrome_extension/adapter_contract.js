"use strict";

globalThis.C2CV2AdapterContract = (() => {
  function isChatUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "chatgpt.com" && !url.username && !url.password && !url.port;
    } catch {
      return false;
    }
  }

  function isConversationUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "chatgpt.com" && !url.username && !url.password && !url.port && !url.search && !url.hash && /^\/c\/[A-Za-z0-9_-]{1,128}$/u.test(url.pathname);
    } catch {
      return false;
    }
  }

  function decideRecoveryTarget({ targetTabId, targetUrl, conversationUrl, originalTabId }) {
    if (!Number.isInteger(originalTabId) || targetTabId !== originalTabId) return "binding-mismatch";
    if (!isConversationUrl(conversationUrl)) return "invalid-conversation-url";
    return targetUrl === conversationUrl ? "reuse-same-tab" : "binding-mismatch";
  }

  function replyMatches(actual, expected) {
    return typeof actual === "string" && typeof expected === "string" && Boolean(expected) && actual === expected;
  }

  function componentMatches(identity) {
    return identity?.protocol_version === 2 && identity?.version === "0.8.1"
      && identity?.build_id === "c2c-v2-binding-diagnostic-1";
  }

  function validRecoveryRequest(r) {
    return Boolean(r && /^[0-9a-f-]{36}$/u.test(r.request_id || "")
      && typeof r.task_id === "string" && r.task_id
      && Number.isInteger(r.iteration) && r.iteration > 0
      && /^[A-Za-z0-9_-]{16,128}$/u.test(r.nonce || "")
      && /^[a-fA-F0-9]{40}$/u.test(r.expected_commit || "")
      && Number.isInteger(r.target_tab_id) && r.target_tab_id >= 0
      && isConversationUrl(r.conversation_url)
      && typeof r.original_message === "string" && r.original_message
      && typeof r.expected_reply === "string" && r.expected_reply
      && Number.isInteger(r.attempt) && r.attempt > 0);
  }

  function sameOriginal(r, o) {
    return validRecoveryRequest(r) && o?.schema === 2
      && ["request_id", "task_id", "iteration", "nonce", "expected_commit", "target_tab_id", "conversation_url"]
        .every((key) => r[key] === o[key])
      && r.original_message === o.message;
  }

  function bindChatTab(previous, tab) {
    if (!tab || !Number.isInteger(tab.id) || !isChatUrl(tab.url)) return null;
    const sameTab = previous?.tab_id === tab.id;
    const previousUrl = sameTab ? previous.tab_url : "";
    return {
      tab_id: tab.id,
      tab_url: tab.url,
      same_tab: sameTab,
      url_changed: sameTab && previousUrl !== tab.url,
      generation: (sameTab ? Number(previous.generation) || 0 : Number(previous?.generation) || 0) + (sameTab && previousUrl === tab.url ? 0 : 1),
    };
  }

  function decideSend({ userTurnFound, nonceObserved, maySend, composerText, staleDraftProven }) {
    if (userTurnFound) return "transcript-resume";
    if (nonceObserved) return "identity-conflict";
    if (!maySend) return "uncertain-no-send";
    if (String(composerText || "").trim() && !staleDraftProven) return "composer-not-empty";
    return "send-once";
  }

  return {
    version: "0.8.1", build_id: "c2c-v2-binding-diagnostic-1",
    isChatUrl, isConversationUrl, bindChatTab, decideSend, decideRecoveryTarget,
    replyMatches, componentMatches, validRecoveryRequest, sameOriginal,
  };
})();
