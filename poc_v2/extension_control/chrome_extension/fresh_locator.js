"use strict";

globalThis.C2CV2FreshLocator = (() => {
  const TIERS = [
    ["data-message-author-role", '[data-message-author-role]'],
    ["semantic-article", "main article, article, [role=\"article\"]"],
    ["accessible-role-name", '[role="listitem"][aria-label], [role="group"][aria-label], [role="region"][aria-label]'],
    ["stable-testid", '[data-testid^="conversation-turn"], [data-testid*="message"]'],
  ];
  const MAX_STRUCTURAL_NODES = 4000;
  const MAX_STRUCTURAL_DEPTH = 48;

  function normalizeText(value) {
    return String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
  }

  function textOf(node) {
    if (!node) return "";
    return String(node.innerText || node.textContent || "");
  }

  function attribute(node, name) {
    return typeof node?.getAttribute === "function" ? node.getAttribute(name) || "" : "";
  }

  function marker(text, label, valuePattern = "[^\\s]+") {
    const normalized = normalizeText(text);
    const expression = new RegExp(`(?:^|\\s)${label}:\\s*(${valuePattern})(?=\\s|$)`, "gu");
    const matches = [...normalized.matchAll(expression)];
    return matches.length === 1 ? matches[0][1] : "";
  }

  function extractMarkers(text) {
    return {
      task_id: marker(text, "TASK_ID", "[A-Za-z0-9_.:-]{1,96}"),
      iteration: Number(marker(text, "ITERATION", "[0-9]{1,5}")) || null,
      request_id: marker(text, "REQUEST_ID", "[0-9a-f-]{36}"),
      control_id: marker(text, "CONTROL_ID", "[0-9a-f-]{36}"),
      attempt_id: Number(marker(text, "ATTEMPT_ID", "[0-9]{1,8}")) || null,
      nonce: marker(text, "NONCE", "[A-Za-z0-9_-]{16,128}"),
      commit: marker(text, "COMMIT", "[A-Fa-f0-9]{40}"),
    };
  }

  function hasRoleMarkerSet(text) {
    const fields = extractMarkers(text);
    return Boolean(fields.task_id && fields.nonce && fields.commit);
  }

  function labelRole(node) {
    const label = normalizeText([
      attribute(node, "aria-label"),
      attribute(node, "aria-roledescription"),
      attribute(node, "title"),
    ].join(" ")).toLowerCase();
    if (/\b(user|you|your message|you said)\b|��˵|�����Ϣ/u.test(label)) return "user";
    if (/\b(assistant|chatgpt|chatgpt said|assistant response)\b|����|ChatGPT�ظ�/u.test(label)) return "assistant";
    const testId = attribute(node, "data-testid").toLowerCase();
    if (/(^|[-_])user([-_]|$)/u.test(testId)) return "user";
    if (/(^|[-_])(assistant|chatgpt)([-_]|$)/u.test(testId)) return "assistant";
    return "";
  }

  function roleOf(node, text, expectedReply = "") {
    const explicit = attribute(node, "data-message-author-role").toLocaleLowerCase();
    if (explicit === "user" || explicit === "assistant") return explicit;
    if (explicit) return "unknown";
    const labelled = labelRole(node);
    if (labelled) return labelled;
    const expected = normalizeText(expectedReply);
    const normalized = normalizeText(text);
    if (hasRoleMarkerSet(normalized)) return "user";
    if (expected && normalized.includes(expected)) return "assistant";
    if (/\bSTATE:\s*(PLAN|REVIEW|DONE|BLOCKED)\b/u.test(normalized) && /\bTASK_ID:\s*\S+/u.test(normalized)) return "assistant";
    if (hasRoleMarkerSet(normalized)) return "user";
    return "";
  }

  function isVisible(node) {
    if (!node || node.isConnected === false) return false;
    if (typeof node.getBoundingClientRect !== "function") return node.visible !== false;
    const rect = node.getBoundingClientRect();
    const style = typeof getComputedStyle === "function" ? getComputedStyle(node) : null;
    return rect.width > 0 && rect.height > 0 && (!style || (style.visibility !== "hidden" && style.display !== "none"));
  }

  function isEditable(node) {
    if (node?.isContentEditable === true) return true;
    const editable = typeof node?.getAttribute === "function" ? node.getAttribute("contenteditable") : null;
    return /^(INPUT|TEXTAREA)$/u.test(node?.tagName || "") || attribute(node, "contenteditable") === "true"
      || attribute(node, "role") === "textbox" || typeof editable === "string" && ["", "true", "plaintext-only"].includes(editable.trim().toLowerCase());
  }

  function isTranscriptSurface(node) {
    for (let parent = node, depth = 0; parent && depth < MAX_STRUCTURAL_DEPTH; parent = parent.parentElement, depth++) {
      if (isEditable(parent)) return false;
    }
    if (typeof node?.querySelectorAll === "function") {
      return ![...node.querySelectorAll('input, textarea, [contenteditable], [role="textbox"]')].some(isEditable);
    }
    const queue = [...(node?.children || [])]; let scanned = 0;
    while (queue.length && scanned++ < MAX_STRUCTURAL_NODES) {
      const child = queue.shift(); if (isEditable(child)) return false; queue.push(...(child.children || []));
    }
    return queue.length === 0;
  }

  function contains(outer, inner) {
    if (outer === inner) return false;
    if (typeof outer?.contains === "function") return outer.contains(inner);
    let parent = inner?.parentElement;
    while (parent) {
      if (parent === outer) return true;
      parent = parent.parentElement;
    }
    return false;
  }

  function pruneNested(nodes) {
    return nodes.filter((candidate) => !nodes.some((other) =>
      candidate !== other && (candidate.role === other.role || candidate.role === "unknown") && contains(candidate.node, other.node),
    ));
  }

  function headingRole(node) {
    if (!/^(H[1-6])$/u.test(node?.tagName || "") && attribute(node, "role") !== "heading") return "";
    const label = normalizeText(textOf(node));
    if (/^(?:\u4f60\u8bf4|You said)[\uff1a:]?$/iu.test(label)) return "user";
    if (/^ChatGPT\s*(?:\u8bf4|said)[\uff1a:]?$/iu.test(label)) return "assistant";
    return "";
  }

  function headedTurns(document) {
    const main = document?.querySelector?.("main");
    const queue = [...(main?.children || [])]; const found = []; let inspected = 0;
    while (queue.length && inspected++ < MAX_STRUCTURAL_NODES) {
      const node = queue.shift(); const children = [...(node.children || [])];
      const heads = children.filter((child) => /^(H[4-6])$/u.test(child?.tagName || "") || attribute(child, "role") === "heading");
      const payload = children.filter((child) => !heads.includes(child));
      if (heads.length === 1 && payload.length === 1 && isTranscriptSurface(payload[0]) && isVisible(payload[0])) {
        found.push({ node: payload[0], role: headingRole(heads[0]) || "unknown", text: textOf(payload[0]), strategy: "accessible-heading-turn" });
      }
      queue.push(...children);
    }
    return found;
  }

  function fromTier(document, strategy, selector, expectedReply) {
    if (typeof document?.querySelectorAll !== "function") return [];
    let candidates;
    try {
      candidates = [...document.querySelectorAll(selector)];
    } catch {
      return [];
    }
    const seen = new Set();
    const messages = [];
    for (const node of candidates) {
      if (seen.has(node) || !isTranscriptSurface(node) || !isVisible(node)) continue;
      seen.add(node);
      const text = textOf(node);
      const role = roleOf(node, text, expectedReply);
      if (role) messages.push({ node, role, text, strategy });
      else if (strategy !== "data-message-author-role") messages.push({ node, role: "unknown", text, strategy });
    }
    return pruneNested(messages);
  }

  function structuralFallback(document, expectedReply) {
    let main;
    try {
      main = document?.querySelector?.("main");
    } catch {
      main = null;
    }
    if (!main) return [];
    const pending = [...(main.children || [])].map((node) => ({ node, depth: 1 }));
    const candidates = [];
    let inspected = 0;
    while (pending.length && inspected < MAX_STRUCTURAL_NODES) {
      const current = pending.shift();
      inspected += 1;
      const { node, depth } = current;
      // Cheap necessary conditions before layout-dependent innerText/visibility reads.
      // Every roleOf branch is represented here; the final role and wire checks are unchanged.
      const cheap = String(node.textContent || "");
      const explicit = attribute(node, "data-message-author-role").toLowerCase();
      const relevant = Boolean(explicit) || labelRole(node)
        || cheap.includes("TASK_ID") && (cheap.includes("NONCE") && cheap.includes("COMMIT") || cheap.includes("STATE"))
        || expectedReply && normalizeText(cheap).includes(normalizeText(expectedReply));
      if (relevant && isTranscriptSurface(node) && isVisible(node)) {
        const text = textOf(node);
        const role = roleOf(node, text, expectedReply);
        if (role) candidates.push({ node, role, text, strategy: "bounded-structural-fallback" });
      }
      if (depth < MAX_STRUCTURAL_DEPTH) {
        for (const child of [...(node.children || [])]) pending.push({ node: child, depth: depth + 1 });
      }
    }
    return pruneNested(candidates);
  }

  function inDocumentOrder(document, messages) {
    const order = new Map();
    let main;
    try {
      main = document?.querySelector?.("main");
    } catch {
      main = null;
    }
    let index = 0;
    const stack = [...(main?.children || [])].reverse();
    while (stack.length && index < MAX_STRUCTURAL_NODES * 4) {
      const node = stack.pop();
      if (!order.has(node)) order.set(node, index++);
      const children = [...(node.children || [])];
      for (let child = children.length - 1; child >= 0; child -= 1) stack.push(children[child]);
    }
    return [...messages].sort((left, right) => {
      if (typeof left.node.compareDocumentPosition === "function") {
        const relation = left.node.compareDocumentPosition(right.node);
        if (relation & 4) return -1;
        if (relation & 2) return 1;
      }
      const leftOrder = order.get(left.node);
      const rightOrder = order.get(right.node);
      return leftOrder !== undefined && rightOrder !== undefined ? leftOrder - rightOrder : 0;
    });
  }

  function collectMessages(document, expectedReply = "") {
    const messages = headedTurns(document);
    const seen = new Set(messages.map((m) => m.node));
    for (const [strategy, selector] of TIERS) {
      for (const message of fromTier(document, strategy, selector, expectedReply)) {
        if (seen.has(message.node)) continue;
        seen.add(message.node);
        messages.push(message);
      }
    }
    for (const message of structuralFallback(document, expectedReply)) {
      if (seen.has(message.node)) continue;
      seen.add(message.node);
      messages.push(message);
    }
    return pruneNested(inDocumentOrder(document, messages));
  }

  function findUserTurn(document, identity, expectedReply = "") {
    const matches = collectMessages(document, expectedReply).filter((message) => {
      if (message.role !== "user") return false;
      const fields = extractMarkers(message.text);
      return fields.task_id === identity.task_id && fields.nonce === identity.nonce && fields.commit === identity.commit
        && (identity.iteration === undefined || fields.iteration === identity.iteration)
        && (identity.request_id === undefined || fields.request_id === identity.request_id);
    });
    return matches.length === 1 ? matches[0] : null;
  }

  function findOriginalUserTurn(document, identity, expectedReply = "") {
    if (!identity?.nonce || !identity.iteration || !identity.request_id || !identity.original_message) return null;
    const matches = collectMessages(document, expectedReply).filter((message) => {
      if (message.role !== "user") return false;
      const f = extractMarkers(message.text);
      return f.task_id === identity.task_id && f.commit === identity.commit && f.nonce === identity.nonce
        && f.iteration === identity.iteration && f.request_id === identity.request_id
        && f.control_id === identity.control_id && f.attempt_id === identity.attempt_id
        && normalizeText(message.text) === normalizeText(identity.original_message);
    });
    return matches.length === 1 ? { ...matches[0], nonce: identity.nonce } : null;
  }

  function findAssistantAfter(document, userTurn, expectedReply = "") {
    if (!userTurn?.node) return null;
    const messages = collectMessages(document, expectedReply);
    const index = messages.findIndex((message) => message.node === userTurn.node);
    if (index < 0) return null;
    for (const message of messages.slice(index + 1)) {
      if (message.role !== "assistant") return null;
      if (message.role === "assistant") return message;
    }
    return null;
  }

  function isAssistantComplete(document, assistant, userTurn = null) {
    if (!assistant?.node) return false;
    const stopSelectors = [
      '[data-testid="stop-button"]', 'button[aria-label*="Stop generating"]',
      'button[aria-label*="Stop response"]', '[aria-busy="true"]',
      '[data-message-status="streaming"]', '[data-is-streaming="true"]',
    ];
    if (stopSelectors.some((selector) => [...(document.querySelectorAll?.(selector) || [])].some(isVisible))) return false;
    const node = assistant.node;
    if (attribute(node, "aria-busy") === "true" || attribute(node, "data-is-streaming") === "true"
        || attribute(node, "data-message-status") === "streaming") return false;
    // Require positive completion evidence, not just absence of a Stop button.
    if (attribute(node, "data-message-status") === "complete") return true;
    const container = node.closest?.('article, [data-testid^="conversation-turn"]') || node;
    if ([...(container.querySelectorAll?.(
      'button[data-testid="copy-turn-action-button"], button[aria-label="Copy response"]',
    ) || [])].some(isVisible)) return true;
    let parent = node.parentElement;
    for (let depth = 0; parent && depth < 10; depth++, parent = parent.parentElement) {
      const heads = [...(parent.querySelectorAll?.('h4, h5, h6, [role="heading"]') || [])];
      const single = heads.length === 1 && headingRole(heads[0]) === "assistant";
      const pair = heads.length === 2 && headingRole(heads[0]) === "user" && headingRole(heads[1]) === "assistant"
        && userTurn?.node && contains(parent, userTurn.node) && findAssistantAfter(document, userTurn)?.node === node;
      if (!single && !pair && heads.length) break;
      if ((single || pair) && [...(parent.querySelectorAll?.('button, [role="button"]') || [])].some((button) => isVisible(button)
          && /^(?:Copy response|\u590d\u5236|\u590d\u5236\u56de\u590d)$/iu.test(attribute(button, "aria-label")))) return true;
    }
    return false;
  }

  return Object.freeze({ version: "0.9.8", build_id: "c2c-v2-fresh-paired-turn-completion-1",
    isAssistantComplete, normalizeText, extractMarkers, collectMessages, findOriginalUserTurn, findAssistantAfter });
})();
