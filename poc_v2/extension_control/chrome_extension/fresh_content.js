"use strict";

(() => {
  const CONTENT_VERSION = "0.9.8";
  const CONTENT_BUILD = "c2c-v2-fresh-paired-turn-completion-1";
  const CONTENT_STATE_KEY = "__c2cV2FreshContentControl";
  const priorContent = globalThis[CONTENT_STATE_KEY];
  priorContent?.dispose?.();
  if (priorContent?.listener) chrome.runtime.onMessage.removeListener(priorContent.listener);
  const Locator = globalThis.C2CV2FreshLocator;
  const Contract = globalThis.C2CV2FreshContract;
  const generation = Number.isSafeInteger(priorContent?.generation) && priorContent.generation < Number.MAX_SAFE_INTEGER ? priorContent.generation + 1 : 1;
  let active = true;
  const waiters = new Set();
  function wake() { for (const resolve of [...waiters]) resolve(); }
  function ensureCurrent() { if (!active) throw new Error("content_instance_retired"); }
  async function pause() {
    ensureCurrent();
    await new Promise((resolve) => {
      let timer;
      const finish = () => { waiters.delete(finish); if (timer !== undefined && typeof clearTimeout === "function") clearTimeout(timer); resolve(); };
      waiters.add(finish); timer = setTimeout(finish, 500);
    });
    ensureCurrent();
  }
  function componentIdentity() {
    const shared = globalThis.C2CV2FreshIdentity;
    const good = active && Locator === globalThis.C2CV2FreshLocator && Contract === globalThis.C2CV2FreshContract
      && shared?.version === CONTENT_VERSION && shared?.build_id === CONTENT_BUILD
      && globalThis.C2CV2FreshContract?.componentMatches(shared)
      && globalThis.C2CV2FreshContract.version === CONTENT_VERSION
      && globalThis.C2CV2FreshLocator?.version === CONTENT_VERSION
      && globalThis.C2CV2FreshLocator?.build_id === shared.build_id;
    return { protocol_version: 3, version: good ? CONTENT_VERSION : "",
      build_id: good ? CONTENT_BUILD : "", url: location.href, content_generation: generation };
  }
  let boundContentTabId = null;
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
      ensureCurrent();
      const result = predicate();
      if (result) return result;
      await pause();
    }
    throw new Error(errorCode);
  }

  function setComposer(element, text) {
    ensureCurrent();
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
      && fields.request_id === request.request_id && fields.control_id === request.control_id && fields.attempt_id === request.attempt_id;
  }

  function reviewResult(request, result) {
    return {
      type: "C2C_FRESH_RESULT",
      ...Contract.identityOf(request),
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

  async function runReview(request, maySend, observation = {}) {
    ensureCurrent();
    if (!observation || typeof observation !== "object" || Object.keys(observation).some((k) => !["reply_wait_ms", "locator_miss"].includes(k))
        || observation.reply_wait_ms !== undefined && (!Number.isInteger(observation.reply_wait_ms) || observation.reply_wait_ms < 1000 || observation.reply_wait_ms > MAX_WAIT_MS)
        || observation.locator_miss !== undefined && typeof observation.locator_miss !== "boolean"
        || maySend && observation.locator_miss) throw new Error("observation_options_invalid");
    if (!Locator || !Contract || !Contract.validRequest(request) || typeof request?.message !== "string" || !isTurnIdentity(request.message, request)) {
      throw new Error("request_identity_mismatch");
    }

    const startingUrl = location.href;
    if (boundContentTabId !== request.target_tab_id || !Contract.componentMatches(componentIdentity())
        || (request.conversation_url && startingUrl !== request.conversation_url)
        || (!request.conversation_url && startingUrl !== "https://chatgpt.com/")) {
      throw new Error("conversation_binding_mismatch");
    }
    let pinnedUrl = request.conversation_url === "https://chatgpt.com/" ? "" : request.conversation_url;
    function verifyBinding() {
      ensureCurrent();
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
        control_id: request.control_id, attempt_id: request.attempt_id,
      }, request.expected_reply || "");
    }
    if (observation.locator_miss) throw new Error("outgoing_turn_not_confirmed");
    let userTurn = findFullUser();
    let sentThisCall = false;
    let composerStrategy = "transcript-resume";
    let sendStrategy = "transcript-resume";

    if (!userTurn) {
      if (!maySend) throw new Error("outgoing_turn_not_confirmed");
      const messages = Locator.collectMessages(document, request.expected_reply || "");
      const composer = firstVisible(COMPOSER_RULES);
      if (!composer) throw new Error("composer_not_found");
      composerStrategy = composer.strategy;
      const existingDraft = readText(composer.element);
      const staleDraftProven = false;
      const decision = Contract.decideSend({
        userTurnFound: false,
        nonceObserved: messages.some((message) => { const f = Locator.extractMarkers(message.text);
          return f.nonce === request.nonce && (f.request_id !== request.request_id || f.control_id !== request.control_id); }),
        maySend,
        composerText: existingDraft,
        staleDraftProven,
      });
      if (decision === "identity-conflict") throw new Error("nonce_identity_mismatch");
      if (decision === "uncertain-no-send") throw new Error("uncertain_send_state");
      if (decision === "composer-not-empty") throw new Error("composer_not_empty");
      if (decision !== "send-once") throw new Error("send_decision_invalid");
      setComposer(composer.element, request.message);
      const send = await waitUntil(() => { verifyBinding(); return firstUsableSend(composer.element); }, 8000, "send_button_not_ready");
      sendStrategy = send.strategy;
      verifyBinding();
      send.element.click();
      sentThisCall = true;
      userTurn = await waitUntil(findFullUser, 30000, "outgoing_turn_not_confirmed");
    }

    verifyBinding();
    if (!Contract.isConversationUrl(location.href)) throw new Error("conversation_binding_mismatch");
    pinnedUrl = location.href;
    await chrome.runtime.sendMessage({
      type: "C2C_FRESH_BOUND", ...Contract.identityOf(request), request_id: request.request_id,
      task_id: request.task_id, iteration: request.iteration, nonce: request.nonce,
      expected_commit: request.expected_commit, conversation_url: location.href, content_identity: componentIdentity(),
    });
    const deadline = Date.now() + (observation.reply_wait_ms || MAX_WAIT_MS);
    let priorText = "";
    let stableSamples = 0;
    let sampledAt = -Infinity;
    while (Date.now() < deadline) {
      const currentUser = findFullUser();
      if (!currentUser) throw new Error("outgoing_turn_binding_lost");
      const assistant = Locator.findAssistantAfter(document, currentUser, request.expected_reply || "");
      const assistantText = assistant ? String(assistant.node.innerText || assistant.node.textContent || "") : "";
      if (assistantText.trim() && !isGenerating() && Locator.isAssistantComplete(document, assistant, currentUser)) {
        if (Date.now() - sampledAt >= POLL_MS) {
          if (assistantText === priorText) stableSamples += 1;
          else stableSamples = 0;
          priorText = assistantText; sampledAt = Date.now();
        }
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
      await pause();
    }
    throw new Error("assistant_turn_timeout");
  }

  const contentMessageListener = (m, _sender, respond) => {
    if (m?.type === "C2C_FRESH_PING") {
      if (Number.isInteger(m.target_tab_id)) boundContentTabId = m.target_tab_id;
      wake();
      const diagnostics = [];
      const requests = Array.isArray(m.requests) ? m.requests.slice(-10) : [];
      const messages = requests.length ? Locator.collectMessages(document) : [];
      const indexed = messages.map((message) => ({ message, fields: Locator.extractMarkers(message.text), normalized: Locator.normalizeText(message.text) }));
      for (const r of requests) {
        if (!Contract.validRequest(r) || r.target_tab_id !== boundContentTabId
            || (r.conversation_url !== location.href && !(r.conversation_url === "https://chatgpt.com/"
              && Contract.isConversationUrl(location.href)))) continue;
        const matches = indexed.filter(({ message, fields: f, normalized }) => message.role === "user"
          && f.task_id === r.task_id && f.iteration === r.iteration && f.request_id === r.request_id
          && f.control_id === r.control_id && f.attempt_id === r.attempt_id && f.nonce === r.nonce
          && f.commit === r.expected_commit && normalized === Locator.normalizeText(r.message));
        const u = matches.length === 1 ? matches[0].message : null;
        const following = u && messages[messages.indexOf(u) + 1];
        const a = following?.role === "assistant" ? following : null;
        const rawNodes = m.include_structure === true
          ? [...document.querySelectorAll('article, [data-message-author-role], [data-testid^="conversation-turn"]')].slice(-40) : [];
        const queue = m.include_structure === true ? [...((document.body || document.querySelector("main"))?.children || [])] : [];
        let inspected = 0;
        while (queue.length && inspected < 4000) {
          const node = queue.shift(); inspected++;
          const text = String(node.innerText || node.textContent || "");
          if (text.includes(r.request_id) && text.includes(r.control_id) && !rawNodes.includes(node)) rawNodes.push(node);
          queue.push(...(node.children || []));
        }
        const ownNodes = rawNodes.filter((node) => { const text = String(node.innerText || node.textContent || "");
          return text.includes(r.request_id) && text.includes(r.control_id); });
        const userNode = ownNodes.filter((node) => Locator.normalizeText(node.innerText || node.textContent || "") === Locator.normalizeText(r.message)).slice(-1);
        const replyNode = ownNodes.filter((node) => !isTurnIdentity(node.innerText || node.textContent || "", r)
          && String(node.innerText || node.textContent || "").length < 400).slice(-1);
        const structure = [...userNode, ...replyNode].map((node) => {
          const text = String(node.innerText || node.textContent || "");
          const rect = node.getBoundingClientRect?.() || { width: 0, height: 0 };
          const ownWire = text.includes(r.request_id) && text.includes(r.control_id);
          const parents = []; let parent = node.parentElement;
          for (let depth = 0; parent && depth < 10; depth++, parent = parent.parentElement) {
            const headings = [...(parent.querySelectorAll?.('h1, h2, h3, h4, h5, h6, [role="heading"]') || [])]
              .map((h) => String(h.innerText || h.textContent || "")).filter((t) => /^(你说|ChatGPT ?说|You said|ChatGPT said)[：:]?$/u.test(t)).slice(0, 3);
            const controls = [...(parent.querySelectorAll?.('button, [role="button"]') || [])]
              .filter((b) => /copy|复制/iu.test(b.getAttribute('aria-label') || b.getAttribute('title') || '')).slice(0, 3)
              .map((b) => ({ label: (b.getAttribute('aria-label') || '').slice(0, 60), title: (b.getAttribute('title') || '').slice(0, 60),
                testid: (b.getAttribute('data-testid') || '').slice(0, 60), visible: visible(b) }));
            parents.push({ tag: parent.tagName, role: parent.getAttribute('role'), label: parent.getAttribute('aria-label'),
              state: Object.fromEntries(['aria-busy','data-is-streaming','data-message-status','data-status','data-state'].map((k) => [k,parent.getAttribute(k)])),
              child_tags: [...(parent.children || [])].slice(0, 12).map((n) => n.tagName), headings, controls });
          }
          return { tag: node.tagName, role: node.getAttribute("role"), author: node.getAttribute("data-message-author-role"),
            label: node.getAttribute("aria-label"), testid: node.getAttribute("data-testid"),
            width: rect.width, height: rect.height, visible: typeof node.getBoundingClientRect === "function" && visible(node), text_length: text.length,
            contains_identity: ownWire, normalized_equals_wire: Locator.normalizeText(text) === Locator.normalizeText(r.message),
            markers: ownWire ? Locator.extractMarkers(text) : null,
            identity_text_sample: ownWire && text.length <= 1600 ? text : "", parents };
        });
        diagnostics.push({ request_id: r.request_id, control_id: r.control_id, attempt_id: r.attempt_id,
          full_user_match: Boolean(u), assistant_after_match: Boolean(a),
          assistant_complete: Boolean(a && Locator.isAssistantComplete(document, a, u)), generating: isGenerating(),
          assistant_text_length: a ? String(a.node.innerText || a.node.textContent || "").length : 0,
          assistant_text_preview: a && String(a.node.innerText || a.node.textContent || "").length <= 256
            ? String(a.node.innerText || a.node.textContent || "") : "",
          assistant_candidates: (() => { const result = []; if (!u) return result;
            for (const item of messages.slice(messages.indexOf(u) + 1)) {
              if (item.role !== "assistant" || result.length === 3) break;
              const text = String(item.node.innerText || item.node.textContent || "");
              result.push({ text_length: text.length, short_preview: text.length <= 256 ? text : "",
                complete: Locator.isAssistantComplete(document, item, u) });
            } return result; })(),
          roles: messages.slice(-20).map((item) => item.role),
          marker_matches: messages.filter((item) => isTurnIdentity(item.text, r)).length, structure, inspected,
          main_present: Boolean(document.querySelector("main")) });
      }
      if (JSON.stringify(diagnostics).length > 12000) for (const d of diagnostics) d.structure = [];
      const mainText = String(document.querySelector("main")?.innerText || "");
      const pageState = { title: String(document.title || "").slice(0, 160), ready_state: document.readyState || "",
        main_text_length: mainText.length, main_notice: mainText.length <= 256 ? mainText : "",
        composer_present: Boolean(document.querySelectorAll('main textarea, main [contenteditable="true"]').length) };
      respond({ type: "C2C_FRESH_READY", ...componentIdentity(), attempt_diagnostics: diagnostics, page_state: pageState }); return false;
    }
    if (m?.type === "C2C_FRESH_CLEAR_OWNED_DRAFT") {
      const r = m.request;
      try {
        ensureCurrent();
        if (!Contract.validRequest(r) || r.target_tab_id !== boundContentTabId || r.conversation_url !== location.href
            || !Contract.componentMatches(componentIdentity())) throw Error("draft_binding_unconfirmed");
        const found = firstVisible(COMPOSER_RULES);
        if (!found || Locator.normalizeText(readText(found.element)) !== Locator.normalizeText(r.message)) throw Error("draft_ownership_unconfirmed");
        // Synchronous recheck and editor-only clear: no runReview, send button, identity allocation or result publication.
        ensureCurrent(); setComposer(found.element, "");
        respond({ cleared: !readText(found.element).trim(), attempt_id: r.attempt_id });
      } catch (e) { respond({ cleared: false, error_code: e.message }); }
      return false;
    }
    if (m?.type === "C2C_FRESH_INSPECT_DRAFT") {
      const r = m.request;
      try {
        ensureCurrent();
        if (!Contract.validRequest(r) || r.target_tab_id !== boundContentTabId || r.conversation_url !== location.href
            || !Contract.componentMatches(componentIdentity())) throw Error("draft_binding_unconfirmed");
        const found = firstVisible(COMPOSER_RULES), draft = found ? readText(found.element) : "";
        const known = (Array.isArray(m.candidates) ? m.candidates.slice(-10) : []).filter((a) => Contract.validRequest(a)
          && a.request_id === r.request_id && a.control_id === r.control_id && a.target_tab_id === r.target_tab_id
          && a.conversation_url === r.conversation_url);
        const candidates = known.filter((a) => draft === a.message);
        const normalized = known.filter((a) => Locator.normalizeText(draft) === Locator.normalizeText(a.message));
        const form = found?.element.closest?.("form");
        const buttons = form ? [...form.querySelectorAll("button")].slice(0, 12).map((b) => ({
          test_id: String(b.getAttribute("data-testid") || "").slice(0, 64),
          aria_label: String(b.getAttribute("aria-label") || "").slice(0, 80),
          type: String(b.getAttribute("type") || "").slice(0, 16),
          disabled: b.disabled === true, aria_disabled: b.getAttribute("aria-disabled") === "true", visible: visible(b),
        })) : [];
        respond({ inspected: true, draft_summary: { composer_present: Boolean(found), composer_tag: found?.element.tagName || "",
          contenteditable: found?.element.isContentEditable === true, length: draft.length, empty: !draft.trim(),
          format_only: /^[\p{White_Space}\p{Cf}]*$/u.test(draft), owned_attempt_id: candidates.length === 1 ? candidates[0].attempt_id : null,
          normalized_owned_attempt_id: normalized.length === 1 ? normalized[0].attempt_id : null,
          composer_form_present: Boolean(form), composer_buttons: buttons } });
      } catch (e) { respond({ inspected: false, error_code: e.message }); }
      return false;
    }
    if (m?.type === "C2C_FRESH_PROBE_REJECTION") {
      const r = m.request;
      try {
        ensureCurrent();
        if (!Contract.validRequest(r) || r.target_tab_id !== boundContentTabId || r.conversation_url !== location.href
            || !Contract.componentMatches(componentIdentity())) throw Error("probe_binding_unconfirmed");
        const u = Locator.findOriginalUserTurn(document, { task_id: r.task_id, iteration: r.iteration,
          request_id: r.request_id, nonce: r.nonce, commit: r.expected_commit, original_message: r.message,
          control_id: r.control_id, attempt_id: r.attempt_id });
        const a = u && Locator.findAssistantAfter(document, u);
        if (!a || isGenerating() || !Locator.isAssistantComplete(document, a, u)) throw Error("probe_reply_unconfirmed");
        const candidate = reviewResult(r, { raw_reply: String(a.node.innerText || a.node.textContent || ""),
          conversation_url: location.href, assistant_generation_complete: true, reply_match_rule: "raw-exact-v1" });
        void chrome.runtime.sendMessage({ type: "C2C_FRESH_PROBE_RESULT", probe_id: m.probe_id, candidate })
          .then(respond).catch(() => respond({ rejected: false, error_code: "probe_channel_unavailable" }));
      } catch (e) { respond({ rejected: false, error_code: e.message }); }
      return true;
    }
    if (!["C2C_FRESH_REVIEW", "C2C_FRESH_OBSERVE"].includes(m?.type) || !Contract.validRequest(m.request)) { respond({ accepted: false }); return false; }
    const r = m.request, k = Contract.key(r);
    if (handledRequests.has(k)) { respond({ accepted: true }); return false; }
    const operation = runReview(r, m.type === "C2C_FRESH_REVIEW" && m.may_send === true, m.observation || {})
      .then((result) => { ensureCurrent(); return chrome.runtime.sendMessage(reviewResult(r, result)); })
      .catch((e) => active && chrome.runtime.sendMessage({ type: "C2C_FRESH_RESULT", ...Contract.identityOf(r),
        error_code: /^[a-z0-9_]{1,64}$/u.test(e?.message || "") ? e.message : "content_error",
        conversation_url: location.href, content_identity: componentIdentity() }));
    handledRequests.set(k, operation);
    void operation.finally(() => handledRequests.delete(k)).catch(() => {});
    respond({ accepted: true }); return false;
  };
  chrome.runtime.onMessage.addListener(contentMessageListener);
  globalThis[CONTENT_STATE_KEY] = { version: CONTENT_VERSION, listener: contentMessageListener, generation,
    dispose() { active = false; wake(); } };
})();
