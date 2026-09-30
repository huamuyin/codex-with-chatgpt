import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readSharedRuntimeConfig } from "../config/shared-runtime.js";
import { getStateDir, writeSecureJson } from "../config/paths.js";
import {
  MAX_BROWSER_RESPONSE_TEXT_BYTES,
  getBrowserReceipt,
  listBrowserReceipts,
  storeBrowserReceipt,
  type BrowserReceipt,
  type BrowserReceiptExpected,
} from "../session/browser-receipt.js";
import { advanceExecutedSent } from "../session/protocol.js";
import { readSession, writeSession, type SavedSession } from "../session/state.js";
import { getWorkspaceTransport, type WorkspaceTransportMode } from "../session/transport.js";
import {
  canonicalChatTargetUrl,
  LocalCdpAdapter,
  type CdpUiPage,
  type SelectedChatTarget,
} from "./cdp-adapter.js";

export const MAX_CONTROL_MESSAGE_BYTES = 64 * 1024;
const MAX_DELIVERY_OPERATIONS = 100;
const MAX_DELIVERY_STORE_BYTES = 512 * 1024;
const CONTROL_WAIT_TIMEOUT_MS = 300_000;
const CONTROL_POLL_INTERVAL_MS = 500;
const CONTROL_STABLE_MS = 1_500;

interface DeliveryOperation {
  workspaceId: string;
  taskId: string;
  round: number;
  controlId: string;
  chatUrl: string;
  requestTimestamp: string;
  requestPayloadHash: string;
  status: "prepared" | "send-attempted" | "completed";
  sendAttemptedAt?: string;
  completedAt?: string;
}

interface DeliveryOperationStore {
  schemaVersion: 1;
  workspaceId: string;
  operations: DeliveryOperation[];
}

export interface ControlTransportInput extends BrowserReceiptExpected {
  message: string;
}

export interface ControlTransportResult {
  status: "EXECUTED_SENT";
  recovered: boolean;
  receipt: Omit<BrowserReceipt, "responseText"> & { responseTextPresent: boolean };
}

export interface ControlBrowser {
  openOrSelectChatPage(chatUrl: string): Promise<SelectedChatTarget>;
  disconnect(): Promise<void>;
}

export interface ControlTransportDependencies {
  getTransport(workspaceId: string): WorkspaceTransportMode;
  getConfig(): NonNullable<ReturnType<typeof readSharedRuntimeConfig>> | null;
  readSession(workspaceId: string): SavedSession | null;
  writeSession(workspaceId: string, session: SavedSession): void;
  getReceipt(expected: BrowserReceiptExpected, now: number): BrowserReceipt | null;
  listReceipts(workspaceId: string, now: number): BrowserReceipt[];
  storeReceipt(receipt: BrowserReceipt, now: number): BrowserReceipt;
  attach(endpoint: string): Promise<ControlBrowser>;
  now(): number;
  wait(page: CdpUiPage, milliseconds: number): Promise<void>;
  waitTimeoutMs: number;
}

const defaults: ControlTransportDependencies = {
  getTransport: (workspaceId) => getWorkspaceTransport(workspaceId).mode,
  getConfig: readSharedRuntimeConfig,
  readSession,
  writeSession,
  getReceipt: getBrowserReceipt,
  listReceipts: listBrowserReceipts,
  storeReceipt: storeBrowserReceipt,
  attach: async (endpoint) => LocalCdpAdapter.attach({ cdpEndpoint: endpoint }),
  now: () => Date.now(),
  wait: (page, milliseconds) => page.waitForTimeout(milliseconds),
  waitTimeoutMs: CONTROL_WAIT_TIMEOUT_MS,
};

function operationStoreFile(workspaceId: string): string {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(workspaceId)) throw new Error("DELIVERY_WORKSPACE_INVALID");
  return path.join(getStateDir(), "deliveries", `${workspaceId}.json`);
}

function operationKey(value: Pick<DeliveryOperation, "taskId" | "round" | "controlId">): string {
  return `${value.taskId}\u001f${value.round}\u001f${value.controlId}`;
}

function readOperations(workspaceId: string): DeliveryOperation[] {
  const file = operationStoreFile(workspaceId);
  if (!fs.existsSync(file)) return [];
  try {
    if (fs.statSync(file).size > MAX_DELIVERY_STORE_BYTES) throw new Error("DELIVERY_JOURNAL_INVALID");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as DeliveryOperationStore;
    if (
      parsed.schemaVersion !== 1 ||
      parsed.workspaceId !== workspaceId ||
      !Array.isArray(parsed.operations) ||
      parsed.operations.length > MAX_DELIVERY_OPERATIONS
    ) {
      throw new Error("DELIVERY_JOURNAL_INVALID");
    }
    const keys = new Set<string>();
    for (const item of parsed.operations) {
      if (
        item.workspaceId !== workspaceId ||
        typeof item.taskId !== "string" || item.taskId.length < 1 || item.taskId.length > 160 ||
        !Number.isSafeInteger(item.round) ||
        typeof item.controlId !== "string" || item.controlId.length < 1 || item.controlId.length > 160 ||
        typeof item.chatUrl !== "string" || item.chatUrl.length > 2048 || canonicalChatTargetUrl(item.chatUrl) !== item.chatUrl ||
        typeof item.requestTimestamp !== "string" ||
        !Number.isFinite(Date.parse(item.requestTimestamp)) || new Date(item.requestTimestamp).toISOString() !== item.requestTimestamp ||
        !/^[a-f0-9]{64}$/.test(item.requestPayloadHash) ||
        !["prepared", "send-attempted", "completed"].includes(item.status) ||
        (item.sendAttemptedAt !== undefined && !Number.isFinite(Date.parse(item.sendAttemptedAt))) ||
        (item.completedAt !== undefined && !Number.isFinite(Date.parse(item.completedAt)))
      ) {
        throw new Error("DELIVERY_JOURNAL_INVALID");
      }
      const key = operationKey(item);
      if (keys.has(key)) throw new Error("DELIVERY_JOURNAL_INVALID");
      keys.add(key);
    }
    return parsed.operations;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("DELIVERY_")) throw error;
    throw new Error("DELIVERY_JOURNAL_INVALID");
  }
}

function writeOperations(workspaceId: string, operations: DeliveryOperation[]): void {
  const bounded = operations.slice(-MAX_DELIVERY_OPERATIONS);
  writeSecureJson(operationStoreFile(workspaceId), { schemaVersion: 1, workspaceId, operations: bounded } satisfies DeliveryOperationStore);
}

function requestHash(message: string): string {
  return createHash("sha256").update(message, "utf8").digest("hex");
}

function assertControlMessage(input: ControlTransportInput): { chatUrl: string; requestPayloadHash: string } {
  const chatUrl = canonicalChatTargetUrl(input.chatUrl);
  if (!chatUrl) throw new Error("CHATGPT_CHAT_URL_INVALID");
  if (Buffer.byteLength(input.message, "utf8") > MAX_CONTROL_MESSAGE_BYTES) throw new Error("CONTROL_MESSAGE_TOO_LARGE");
  const lines = input.message.split(/\r?\n/);
  const identities = [
    `MISSION_ID: ${input.taskId}`,
    `ROUND: ${input.round}`,
    `CONTROL_ID: ${input.controlId}`,
  ];
  if (identities.some((identity) => lines.filter((line) => line === identity).length !== 1)) {
    throw new Error("CONTROL_MESSAGE_IDENTITY_MISMATCH");
  }
  if (!Number.isSafeInteger(input.round) || input.round < 0) throw new Error("CONTROL_ROUND_INVALID");
  return { chatUrl, requestPayloadHash: requestHash(input.message) };
}

function expectedFromCheckpoint(workspaceId: string, session: SavedSession): BrowserReceiptExpected {
  const checkpoint = session.checkpoint;
  if (!checkpoint?.taskId || !checkpoint.controlId || !checkpoint.chatUrl) {
    throw new Error("PROTOCOL_CHECKPOINT_IDENTITY_REQUIRED");
  }
  return {
    workspaceId,
    taskId: checkpoint.taskId,
    round: checkpoint.iteration,
    controlId: checkpoint.controlId,
    chatUrl: checkpoint.chatUrl,
  };
}

function assistantLocator(page: CdpUiPage) {
  const modern = page.locator("div[data-chatgpt-selection-message-id]");
  const legacy = page.locator('[data-message-author-role="assistant"]');
  return { modern, legacy };
}

function exactLine(text: string, label: string, value: string | number): boolean {
  return text.split(/\r?\n/).filter((line) => line === `${label}: ${value}`).length === 1;
}

function hasSingleStateLine(text: string): boolean {
  return text.split(/\r?\n/).filter((line) => /^STATE: [A-Z_]+$/.test(line)).length === 1;
}

async function matchingAssistantText(target: SelectedChatTarget, expected: BrowserReceiptExpected): Promise<string | null> {
  const { modern, legacy } = assistantLocator(target.page);
  const messages = (await modern.count().catch(() => 0)) > 0 ? modern : legacy;
  const count = await messages.count().catch(() => 0);
  for (let i = Math.max(0, count - 20); i < count; i++) {
    const text = (await messages.nth(i).innerText({ timeout: 2_000 }).catch(() => "")).trim();
    if (
      exactLine(text, "MISSION_ID", expected.taskId) &&
      exactLine(text, "ROUND", expected.round) &&
      exactLine(text, "CONTROL_ID", expected.controlId) &&
      hasSingleStateLine(text)
    ) {
      return text;
    }
  }
  return null;
}

async function matchingUserRequest(target: SelectedChatTarget, expected: BrowserReceiptExpected): Promise<boolean> {
  const messages = target.page.locator('[data-message-author-role="user"]');
  const count = await messages.count().catch(() => 0);
  for (let i = Math.max(0, count - 20); i < count; i++) {
    const text = (await messages.nth(i).innerText({ timeout: 2_000 }).catch(() => "")).trim();
    if (
      exactLine(text, "MISSION_ID", expected.taskId) &&
      exactLine(text, "ROUND", expected.round) &&
      exactLine(text, "CONTROL_ID", expected.controlId)
    ) return true;
  }
  return false;
}

async function controlOccurrences(target: SelectedChatTarget, controlId: string): Promise<number> {
  return target.page.getByText(controlId, { exact: false }).count().catch(() => 0);
}

async function findComposer(page: CdpUiPage, wait: ControlTransportDependencies["wait"], timeoutMs: number): Promise<ReturnType<CdpUiPage["locator"]> | null> {
  const selectors = [
    page.locator("#prompt-textarea"),
    page.locator('[contenteditable="true"][data-testid="prompt-textarea"]'),
    page.locator('div[contenteditable="true"][role="textbox"]'),
  ];
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const candidate of selectors) {
      if ((await candidate.count().catch(() => 0)) && await candidate.first().isVisible().catch(() => false)) {
        return candidate.first();
      }
    }
    await wait(page, 250);
  }
  return null;
}

function boundedResponse(text: string): string {
  let bounded = Buffer.from(text, "utf8").subarray(0, MAX_BROWSER_RESPONSE_TEXT_BYTES).toString("utf8");
  while (Buffer.byteLength(bounded, "utf8") > MAX_BROWSER_RESPONSE_TEXT_BYTES) bounded = bounded.slice(0, -1);
  return bounded;
}

function receiptFromResponse(
  expected: BrowserReceiptExpected,
  operation: DeliveryOperation,
  responseText: string,
  responseTimestamp: string
): BrowserReceipt {
  const responseControlId = responseText.split(/\r?\n/).find((line) => line.startsWith("CONTROL_ID: "))?.slice("CONTROL_ID: ".length);
  if (
    responseControlId !== expected.controlId ||
    !exactLine(responseText, "MISSION_ID", expected.taskId) ||
    !exactLine(responseText, "ROUND", expected.round)
  ) throw new Error("CONTROL_RESPONSE_IDENTITY_MISMATCH");
  const response = boundedResponse(responseText);
  return {
    schemaVersion: 1,
    workspaceId: expected.workspaceId,
    taskId: expected.taskId,
    round: expected.round,
    controlId: expected.controlId,
    chatUrl: canonicalChatTargetUrl(expected.chatUrl)!,
    requestState: "sent",
    requestTimestamp: operation.requestTimestamp,
    requestPayloadHash: operation.requestPayloadHash,
    responseState: "received",
    responseTimestamp,
    responseControlId,
    responsePayloadHash: requestHash(response),
    validationStatus: "matched",
    responseText: response,
  };
}

function receiptSummary(receipt: BrowserReceipt): ControlTransportResult["receipt"] {
  const { responseText, ...safe } = receipt;
  return { ...safe, responseTextPresent: Boolean(responseText) };
}

async function waitForAssistant(
  target: SelectedChatTarget,
  expected: BrowserReceiptExpected,
  dependencies: ControlTransportDependencies
): Promise<{ responseText: string; occurrences: number }> {
  const deadline = dependencies.now() + dependencies.waitTimeoutMs;
  let previousText = "";
  let stableAt = 0;
  while (dependencies.now() <= deadline) {
    const responseText = await matchingAssistantText(target, expected);
    const occurrences = await controlOccurrences(target, expected.controlId);
    const requestVisible = await matchingUserRequest(target, expected);
    const busy = await target.page.locator(
      'button[data-testid="stop-button"],button[aria-label*="Stop"],button[aria-label*="停止"]'
    ).count().catch(() => 0);
    if (requestVisible && responseText && occurrences >= 2 && busy === 0) {
      if (responseText === previousText) {
        if (!stableAt) stableAt = dependencies.now();
        if (dependencies.now() - stableAt >= CONTROL_STABLE_MS) return { responseText, occurrences };
      } else {
        previousText = responseText;
        stableAt = 0;
      }
    } else {
      previousText = responseText ?? "";
      stableAt = 0;
    }
    await dependencies.wait(target.page, CONTROL_POLL_INTERVAL_MS);
  }
    const responseText = await matchingAssistantText(target, expected);
    const occurrences = await controlOccurrences(target, expected.controlId);
    const requestVisible = await matchingUserRequest(target, expected);
    if (occurrences > 0 && !requestVisible) throw new Error("CONTROL_REQUEST_IDENTITY_MISMATCH");
  if (responseText && occurrences < 2) throw new Error("CONTROL_REQUEST_NOT_CONFIRMED_IN_VISIBLE_CHAT");
  throw new Error("CONTROL_RESPONSE_TIMEOUT");
}

function gateAndPersist(
  workspaceId: string,
  session: SavedSession,
  receipt: BrowserReceipt,
  dependencies: ControlTransportDependencies,
  now: number,
  recovered: boolean
): ControlTransportResult {
  const stored = dependencies.storeReceipt(receipt, now);
  const advanced = advanceExecutedSent(session, workspaceId, { kind: "browser-receipt" }, {
    getTransport: dependencies.getTransport,
    getReceipt: dependencies.getReceipt,
  }, now);
  dependencies.writeSession(workspaceId, advanced);
  const operations = readOperations(workspaceId);
  const key = operationKey({ taskId: stored.taskId, round: stored.round, controlId: stored.controlId });
  const index = operations.findIndex((entry) => operationKey(entry) === key);
  if (index >= 0) {
    operations[index] = { ...operations[index]!, status: "completed", completedAt: new Date(now).toISOString() };
    writeOperations(workspaceId, operations);
  }
  return { status: "EXECUTED_SENT", recovered, receipt: receiptSummary(stored) };
}

function upsertOperation(workspaceId: string, operation: DeliveryOperation): void {
  const operations = readOperations(workspaceId);
  const key = operationKey(operation);
  const existingIndex = operations.findIndex((entry) => operationKey(entry) === key);
  if (existingIndex >= 0) {
    const current = operations[existingIndex]!;
    if (
      current.requestPayloadHash !== operation.requestPayloadHash ||
      current.chatUrl !== operation.chatUrl
    ) {
      throw new Error("CONTROL_DELIVERY_REPLAY_CONFLICT");
    }
    operations[existingIndex] = { ...current, ...operation };
  } else {
    operations.push(operation);
  }
  writeOperations(workspaceId, operations);
}

export async function resumeLocalControl(
  workspaceId: string,
  message: string | undefined,
  overrides: Partial<ControlTransportDependencies> = {}
): Promise<ControlTransportResult | { status: "LEGACY" | "NO_PENDING_CONTROL" }> {
  const dependencies = { ...defaults, ...overrides };
  const mode = dependencies.getTransport(workspaceId);
  if (mode === "legacy") return { status: "LEGACY" };
  const session = dependencies.readSession(workspaceId);
  if (!session?.checkpoint) return { status: "NO_PENDING_CONTROL" };
  if (session.checkpoint.protocolState !== "EXECUTED_LOCAL" && session.checkpoint.protocolState !== "EXECUTED_SENT") {
    return { status: "NO_PENDING_CONTROL" };
  }
  const expected = expectedFromCheckpoint(workspaceId, session);
  const now = dependencies.now();
  const existingReceipt = dependencies.getReceipt(expected, now);
  if (existingReceipt) {
    if (session.checkpoint.protocolState === "EXECUTED_SENT") {
      return { status: "EXECUTED_SENT", recovered: true, receipt: receiptSummary(existingReceipt) };
    }
    const advanced = advanceExecutedSent(session, workspaceId, { kind: "browser-receipt" }, {
      getTransport: dependencies.getTransport,
      getReceipt: dependencies.getReceipt,
    }, now);
    dependencies.writeSession(workspaceId, advanced);
    return { status: "EXECUTED_SENT", recovered: true, receipt: receiptSummary(existingReceipt) };
  }
  if (session.checkpoint.protocolState === "EXECUTED_SENT") throw new Error("SENT_CHECKPOINT_RECEIPT_MISSING");
  if (!message) throw new Error("CONTROL_MESSAGE_REQUIRED");
  return deliverLocalControl({ ...expected, message }, dependencies);
}

export async function deliverLocalControl(
  input: ControlTransportInput,
  overrides: Partial<ControlTransportDependencies> = {}
): Promise<ControlTransportResult> {
  const dependencies = { ...defaults, ...overrides };
  if (dependencies.getTransport(input.workspaceId) !== "local-cdp") throw new Error("LOCAL_CDP_NOT_OPTED_IN");
  const { chatUrl, requestPayloadHash } = assertControlMessage(input);
  const session = dependencies.readSession(input.workspaceId);
  if (!session?.checkpoint) throw new Error("PROTOCOL_CHECKPOINT_REQUIRED");
  const expected = expectedFromCheckpoint(input.workspaceId, session);
  if (
    expected.taskId !== input.taskId ||
    expected.round !== input.round ||
    expected.controlId !== input.controlId ||
    canonicalChatTargetUrl(expected.chatUrl) !== chatUrl
  ) {
    throw new Error("CONTROL_CHECKPOINT_IDENTITY_MISMATCH");
  }
  if (session.checkpoint.protocolState === "EXECUTED_SENT") {
    const existing = dependencies.getReceipt(expected, dependencies.now());
    if (!existing) throw new Error("SENT_CHECKPOINT_RECEIPT_MISSING");
    return { status: "EXECUTED_SENT", recovered: true, receipt: receiptSummary(existing) };
  }
  if (session.checkpoint.protocolState !== "EXECUTED_LOCAL") throw new Error("PROTOCOL_LOCAL_STATE_REQUIRED");

  const now = dependencies.now();
  const existingReceipt = dependencies.getReceipt(expected, now);
  if (existingReceipt) {
    const advanced = advanceExecutedSent(session, input.workspaceId, { kind: "browser-receipt" }, {
      getTransport: dependencies.getTransport,
      getReceipt: dependencies.getReceipt,
    }, now);
    dependencies.writeSession(input.workspaceId, advanced);
    return { status: "EXECUTED_SENT", recovered: true, receipt: receiptSummary(existingReceipt) };
  }

  const key = { taskId: input.taskId, round: input.round, controlId: input.controlId };
  const previousOperation = readOperations(input.workspaceId).find((entry) => operationKey(entry) === operationKey(key));
  if (previousOperation && (previousOperation.requestPayloadHash !== requestPayloadHash || previousOperation.chatUrl !== chatUrl)) {
    throw new Error("CONTROL_DELIVERY_REPLAY_CONFLICT");
  }
  const config = dependencies.getConfig();
  if (!config) throw new Error("SHARED_RUNTIME_NOT_CONFIGURED");
  const browser = await dependencies.attach(config.cdpEndpoint);
  try {
    const target = await browser.openOrSelectChatPage(chatUrl);
    if (canonicalChatTargetUrl(target.url) !== chatUrl) throw new Error("CHATGPT_TARGET_IDENTITY_MISMATCH");

    const priorResponse = await matchingAssistantText(target, expected);
    const priorOccurrences = await controlOccurrences(target, input.controlId);
    const priorRequestVisible = await matchingUserRequest(target, expected);
    if (priorOccurrences > 0 && !priorRequestVisible) throw new Error("CONTROL_REQUEST_IDENTITY_MISMATCH");
    if (priorResponse && priorOccurrences >= 2) {
      if (!previousOperation) throw new Error("DELIVERY_INTENT_MISSING");
      const receipt = receiptFromResponse(expected, previousOperation, priorResponse, new Date(dependencies.now()).toISOString());
      return gateAndPersist(input.workspaceId, session, receipt, dependencies, dependencies.now(), true);
    }
    if (priorOccurrences > 2) throw new Error("CONTROL_HISTORY_AMBIGUOUS");
    if (priorOccurrences > 0) {
      if (!previousOperation) throw new Error("DELIVERY_INTENT_MISSING");
      const operation = previousOperation;
      upsertOperation(input.workspaceId, { ...operation, status: "send-attempted", sendAttemptedAt: operation.sendAttemptedAt ?? new Date(now).toISOString() });
      const response = await waitForAssistant(target, expected, dependencies);
      const receipt = receiptFromResponse(expected, operation, response.responseText, new Date(dependencies.now()).toISOString());
      return gateAndPersist(input.workspaceId, session, receipt, dependencies, dependencies.now(), true);
    }
    if (priorOccurrences !== 0) throw new Error("CONTROL_HISTORY_AMBIGUOUS");

    const operation: DeliveryOperation = previousOperation ?? {
      ...key,
      workspaceId: input.workspaceId,
      chatUrl,
      requestTimestamp: new Date(now).toISOString(),
      requestPayloadHash,
      status: "prepared",
    };
    const composer = await findComposer(target.page, dependencies.wait, Math.min(60_000, dependencies.waitTimeoutMs));
    if (!composer) throw new Error("CHAT_COMPOSER_NOT_READY");
    const send = target.page.locator('button[data-testid="send-button"]');
    if (!(await send.count().catch(() => 0)) || !(await send.first().isVisible().catch(() => false))) throw new Error("CHAT_SEND_CONTROL_NOT_FOUND");
    if (!(await send.first().isEnabled().catch(() => false))) throw new Error("CHAT_SEND_CONTROL_NOT_READY");
    upsertOperation(input.workspaceId, { ...operation, status: "send-attempted", sendAttemptedAt: new Date(dependencies.now()).toISOString() });
    await composer.fill(input.message, { timeout: 15_000 });
    await send.first().click({ timeout: 15_000 });
    const response = await waitForAssistant(target, expected, dependencies);
    const receipt = receiptFromResponse(expected, operation, response.responseText, new Date(dependencies.now()).toISOString());
    return gateAndPersist(input.workspaceId, session, receipt, dependencies, dependencies.now(), false);
  } finally {
    await browser.disconnect().catch(() => {});
  }
}

export function deliveryReceiptStatus(workspaceId: string, expected?: BrowserReceiptExpected): {
  count: number;
  latest: { taskId: string; round: number; controlId: string; chatUrl: string; responseTimestamp: string } | null;
  expectedMatched: boolean | null;
} {
  const receipts = listBrowserReceipts(workspaceId);
  const latest = receipts.at(-1);
  return {
    count: receipts.length,
    latest: latest ? {
      taskId: latest.taskId,
      round: latest.round,
      controlId: latest.controlId,
      chatUrl: latest.chatUrl,
      responseTimestamp: latest.responseTimestamp,
    } : null,
    expectedMatched: expected ? Boolean(getBrowserReceipt(expected)) : null,
  };
}
