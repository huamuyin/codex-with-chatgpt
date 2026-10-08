"use strict";

(() => {
  const CONTENT_VERSION = "0.8.1";
  function componentIdentity() {
    const shared = globalThis.C2CV2ComponentIdentity;
    const good = globalThis.C2CV2AdapterContract?.componentMatches(shared)
      && globalThis.C2CV2AdapterContract.version === CONTENT_VERSION
      && globalThis.C2CV2TranscriptLocator?.version === CONTENT_VERSION
      && globalThis.C2CV2TranscriptLocator?.build_id === shared.build_id;
    return { protocol_version: 2, version: good ? CONTENT_VERSION : "",
      build_id: good ? shared.build_id : "", url: location.href };
  }
  let boundContentTabId = null;
  const CONTENT_STATE_KEY = "__c2cV2ContentControl";
  const priorContent = globalThis[CONTENT_STATE_KEY];
  if (priorContent?.version === CONTENT_VERSION) {
    chrome.runtime.sendMessage({ type: "C2C_CONTENT_READY", ...componentIdentity() }).catch(() => {});
    return;
  }
  if (priorContent?.listener) chrome.runtime.onMessage.removeListener(priorContent.listener);

  const Locator = globalThis.C2CV2TranscriptLocator;
  const Contract = globalThis.C2CV2AdapterContract;
  const COMPOSER_RULES = [
    ["data-testid-prompt-textarea", '[data-testid="prompt-textarea"]'],
    ["prompt-textarea-id", "#prompt-textarea"],
    ["semantic-contenteditable", 'main [contenteditable="true"][role="textbox"]'],
    ["main-textarea", "main textarea"],
  ];
  const SEND_RULES = [
    ["data-testid-send-button", 'button[data-testid="send-button"]'],
    ["aria-send-prompt", 'button[aria-label="Send prompt"]'],
    ["aria-send-message", 'button[aria-label="Send message"]'],
    ["aria-send-name", 'button[aria-label*="Send" i]'],
  ];
  const GENERATING_RULES = [
    '[data-testid="stop-button"]',
    'button[aria-label*="Stop generating"]',
    'button[aria-label*="Stop response"]',
  ];
  const MAX_WAIT_MS = 10 * 60 * 1000;
  const POLL_MS = 500;
  const handledRequests = new Map();

  function visible(element) {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function readText(element) {
    if (!element) return "";
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value;
    return (element.innerText || element.textContent || "").replace(/\r/g, "");
  }

  function firstVisible(rules) {
    for (const [strategy, selector] of rules) {
      const element = [...document.querySelectorAll(selector)].find(visible);
      if (element) return { element, strategy };
    }
    return null;
  }

  function isGenerating() {
    return GENERATING_RULES.some((selector) => [...document.querySelectorAll(selector)].some(visible));
  }

  async function waitUntil(predicate, timeoutMs, errorCode) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = predicate();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    throw new Error(errorCode);
  }

  function setComposer(element, text) {
    element.focus();
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (!setter) throw new Error("composer_setter_unavailable");
      setter.call(element, text);
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      document.execCommand("selectAll", false);
      document.execCommand("insertText", false, text);
      if (readText(element) !== text) {
        element.replaceChildren(document.createTextNode(text));
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      }
    }
    if (readText(element) !== text) throw new Error("composer_text_verification_failed");
  }

  function firstUsableSend(composerElement) {
    for (const [strategy, selector] of SEND_RULES) {
      const element = [...document.querySelectorAll(selector)].find((candidate) =>
        visible(candidate) && !candidate.disabled && candidate.getAttribute("aria-disabled") !== "true",
      );
      if (element) return { element, strategy };
    }
    const form = composerElement?.closest("form");
    const submitButton = form && [...form.querySelectorAll('button[type="submit"]')].find((candidate) =>
      visible(candidate) && !candidate.disabled && candidate.getAttribute("aria-disabled") !== "true",
    );
    return submitButton ? { element: submitButton, strategy: "composer-form-submit" } : null;
  }

  function isTurnIdentity(text, request) {
    const fields = Locator.extractMarkers(text);
    return fields.task_id === request.task_id && fields.nonce === request.nonce
      && fields.commit === request.expected_commit && fields.iteration === request.iteration
      && fields.request_id === request.request_id;
  }

  function reviewResult(request, result) {
    return {
      type: "C2C_REVIEW_RESULT",
      request_id: request.request_id,
      task_id: request.task_id,
      iteration: request.iteration,
      nonce: request.nonce,
      expected_commit: request.expected_commit,
      raw_reply: result.raw_reply,
      selector_strategy: result.selector_strategy,
      conversation_url: result.conversation_url,
      content_identity: componentIdentity(),
      assistant_generation_complete: result.assistant_generation_complete,
      reply_match_rule: result.reply_match_rule,
    };
  }

  async function runReview(request, maySend) {
    if (!Locator || !Contract || typeof request?.message !== "string" || !isTurnIdentity(request.message, request)) {
      throw new Error("request_identity_mismatch");
    }

    const startingUrl = location.href;
    if (boundContentTabId !== request.target_tab_id || !Contract.componentMatches(componentIdentity())
        || (request.conversation_url && startingUrl !== request.conversation_url)
        || (!request.conversation_url && startingUrl !== "https://chatgpt.com/")) {
      throw new Error("conversation_binding_mismatch");
    }
    let pinnedUrl = request.conversation_url;
    function verifyBinding() {
      if (boundContentTabId !== request.target_tab_id || !Contract.componentMatches(componentIdentity())
          || (pinnedUrl ? location.href !== pinnedUrl
            : location.href !== startingUrl && !Contract.isConversationUrl(location.href))) {
        throw new Error("conversation_binding_mismatch");
      }
    }
    function findFullUser() {
      verifyBinding();
      return Locator.findOriginalUserTurn(document, {
        task_id: request.task_id, iteration: request.iteration, request_id: request.request_id,
        nonce: request.nonce, commit: request.expected_commit, original_message: request.message,
      }, request.expected_reply || "");
    }
    let userTurn = findFullUser();
    let sentThisCall = false;
    let composerStrategy = "transcript-resume";
    let sendStrategy = "transcript-resume";

    if (!userTurn) {
      const messages = Locator.collectMessages(document, request.expected_reply || "");
      const composer = firstVisible(COMPOSER_RULES);
      if (!composer) throw new Error("composer_not_found");
      composerStrategy = composer.strategy;
      const existingDraft = readText(composer.element);
      const staleDraftProven = false;
      const decision = Contract.decideSend({
        userTurnFound: false,
        nonceObserved: messages.some((message) => Locator.extractMarkers(message.text).nonce === request.nonce),
        maySend,
        composerText: existingDraft,
        staleDraftProven,
      });
      if (decision === "identity-conflict") throw new Error("nonce_identity_mismatch");
      if (decision === "uncertain-no-send") throw new Error("uncertain_send_state");
      if (decision === "composer-not-empty") throw new Error("composer_not_empty");
      if (decision !== "send-once") throw new Error("send_decision_invalid");
      setComposer(composer.element, request.message);
      const send = await waitUntil(() => firstUsableSend(composer.element), 8000, "send_button_not_ready");
      sendStrategy = send.strategy;
      send.element.click();
      sentThisCall = true;
      userTurn = await waitUntil(findFullUser, 30000, "outgoing_turn_not_confirmed");
    }

    verifyBinding();
    if (!Contract.isConversationUrl(location.href)) throw new Error("conversation_binding_mismatch");
    pinnedUrl = location.href;
    await chrome.runtime.sendMessage({
      type: "C2C_REVIEW_BOUND", request_id: request.request_id,
      task_id: request.task_id, iteration: request.iteration, nonce: request.nonce,
      expected_commit: request.expected_commit, conversation_url: location.href,
    });
    const deadline = Date.now() + MAX_WAIT_MS;
    let priorText = "";
    let stableSamples = 0;
    while (Date.now() < deadline) {
      const currentUser = findFullUser();
      if (!currentUser) throw new Error("outgoing_turn_binding_lost");
      const assistant = Locator.findAssistantAfter(document, currentUser, request.expected_reply || "");
      const assistantText = assistant ? String(assistant.node.innerText || assistant.node.textContent || "") : "";
      if (assistantText.trim() && !isGenerating() && Locator.isAssistantComplete(document, assistant)) {
        if (assistantText === priorText) stableSamples += 1;
        else stableSamples = 0;
        priorText = assistantText;
        if (stableSamples >= 3) {
          return {
            raw_reply: assistantText,
            conversation_url: pinnedUrl,
            assistant_generation_complete: true,
            reply_match_rule: "raw-exact-v1",
            selector_strategy: `${composerStrategy};${sendStrategy};${currentUser.strategy};${sentThisCall ? "single-click-send" : "transcript-resume"}`,
          };
        }
      } else {
        stableSamples = 0;
        priorText = assistantText;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    throw new Error("assistant_turn_timeout");
  }

  async function runOriginalRecovery(request) {
    if (!Locator || !Contract.validRecoveryRequest(request)
        || boundContentTabId !== request.target_tab_id
        || !Contract.componentMatches(componentIdentity())
        || location.href !== request.conversation_url) throw new Error("recovery_request_invalid");
    const initialUrl = location.href;
    let priorText = null;
    let samples = 0;
    const proof = await waitUntil(() => {
      if (location.href !== initialUrl || location.href !== request.conversation_url) {
        throw new Error("conversation_binding_mismatch");
      }
      const current = Locator.recoverOriginal(document, request);
      if (!current.original_user_turn_found || !current.subsequent_assistant_turn_found) return current;
      if (!current.assistant_generation_complete) {
        samples = 0; priorText = null; return null;
      }
      samples = current.raw_reply === priorText ? samples + 1 : 1;
      priorText = current.raw_reply;
      return samples >= 4 ? current : null;
    }, 30000, "assistant_completion_unconfirmed");
    return {
      type: "C2C_RECOVERY_RESULT", ...proof, conversation_url: initialUrl,
      content_identity: componentIdentity(),
    };
  }

  function errorCode(error) {
    const value = String(error?.message || "review_failed");
    return /^[a-z0-9_]{1,64}$/.test(value) ? value : "review_failed";
  }

  const contentMessageListener = (message, _sender, sendResponse) => {
    if (message?.type === "C2C_PING") {
      if (Number.isInteger(message.target_tab_id)) boundContentTabId = message.target_tab_id;
      sendResponse({ type: "C2C_V2_CONTENT_READY", ...componentIdentity() });
      return false;
    }
    if (message?.type === "C2C_INSPECT_ORIGINAL") {
      const r = message.request || {};
      const identity = {
        request_id: r.request_id, task_id: r.task_id, iteration: r.iteration,
        expected_commit: r.expected_commit, inspection: r.inspection,
        conversation_url: location.href, content_identity: componentIdentity(),
      };
      try {
        if (!Number.isInteger(r.inspection) || r.inspection < 1 || !Number.isInteger(r.iteration)
            || boundContentTabId !== r.target_tab_id || location.href !== r.conversation_url
            || !Contract.componentMatches(componentIdentity())
            || typeof r.original_message_template !== "string"
            || !r.original_message_template.includes("__OBSERVED_NONCE__")) throw new Error("inspection_request_invalid");
        const observation = Locator.inspectOriginal(document, r);
        if (location.href !== r.conversation_url) throw new Error("inspection_url_changed");
        chrome.runtime.sendMessage({ type: "C2C_INSPECTION_RESULT", ...identity, ...observation }).catch(() => {});
      } catch (error) {
        chrome.runtime.sendMessage({ type: "C2C_INSPECTION_RESULT", ...identity, error_code: errorCode(error) }).catch(() => {});
      }
      sendResponse({ accepted: true, authoritative: false });
      return false;
    }
    if (message?.type === "C2C_RECOVER_ORIGINAL") {
      const request = message.request || {};
      void runOriginalRecovery(request)
        .then((result) => chrome.runtime.sendMessage(result))
        .catch((error) => chrome.runtime.sendMessage({
          type: "C2C_RECOVERY_RESULT", request_id: request.request_id, task_id: request.task_id,
          iteration: request.iteration, expected_commit: request.expected_commit,
          nonce: request.nonce, attempt: request.attempt, error_code: errorCode(error),
          conversation_url: location.href, content_identity: componentIdentity(),
        })).catch(() => {});
      sendResponse({ accepted: true });
      return false;
    }
    if (message?.type !== "C2C_REVIEW") return false;
    const request = message.request;
    const requestId = request?.request_id;
    if (!requestId) {
      sendResponse({ accepted: false });
      return false;
    }
    if (handledRequests.has(requestId)) {
      sendResponse({ accepted: true, already_processing: true });
      return false;
    }

    const operation = runReview(request, message.may_send === true)
      .then((result) => chrome.runtime.sendMessage(reviewResult(request, result)))
      .catch((error) => chrome.runtime.sendMessage({
        type: "C2C_REVIEW_RESULT",
        request_id: request.request_id,
        task_id: request.task_id,
        iteration: request.iteration,
        nonce: request.nonce,
        expected_commit: request.expected_commit,
        error_code: errorCode(error),
        selector_strategy: "",
        conversation_url: location.href,
      }));
    handledRequests.set(requestId, operation);
    void operation.finally(() => handledRequests.delete(requestId));
    sendResponse({ accepted: true });
    return false;
  };

  chrome.runtime.onMessage.addListener(contentMessageListener);
  globalThis[CONTENT_STATE_KEY] = { version: CONTENT_VERSION, listener: contentMessageListener };

  chrome.runtime.sendMessage({ type: "C2C_CONTENT_READY", ...componentIdentity() }).catch(() => {});
})();
