import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getStateDir, writeSecureJson } from "../config/paths.js";

export const MAX_BROWSER_RECEIPTS_PER_WORKSPACE = 100;
export const MAX_BROWSER_RECEIPT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_BROWSER_RECEIPT_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const MAX_BROWSER_RESPONSE_TEXT_LENGTH = 16_384;
const MAX_RECEIPT_STORE_BYTES = MAX_BROWSER_RECEIPTS_PER_WORKSPACE * (MAX_BROWSER_RESPONSE_TEXT_LENGTH + 2048);

export interface BrowserReceipt {
  schemaVersion: 1;
  workspaceId: string;
  taskId: string;
  round: number;
  controlId: string;
  chatUrl: string;
  requestState: "sent";
  requestTimestamp: string;
  requestPayloadHash: string;
  responseState: "received";
  responseTimestamp: string;
  responseControlId: string;
  responsePayloadHash: string;
  validationStatus: "matched";
  responseText?: string;
}

export interface BrowserReceiptExpected {
  workspaceId: string;
  taskId: string;
  round: number;
  controlId: string;
  chatUrl: string;
}

interface ReceiptStore {
  schemaVersion: 1;
  workspaceId: string;
  receipts: BrowserReceipt[];
}

const RECEIPT_FIELDS = new Set([
  "schemaVersion",
  "workspaceId",
  "taskId",
  "round",
  "controlId",
  "chatUrl",
  "requestState",
  "requestTimestamp",
  "requestPayloadHash",
  "responseState",
  "responseTimestamp",
  "responseControlId",
  "responsePayloadHash",
  "validationStatus",
  "responseText",
]);

function receiptStoreFile(workspaceId: string): string {
  validateToken(workspaceId, "workspace", 160);
  return path.join(getStateDir(), "receipts", `${workspaceId}.json`);
}

function validateToken(value: unknown, label: string, maxLength: number): asserts value is string {
  if (typeof value !== "string" || value.trim().length < 1 || value.length > maxLength) {
    throw new Error(`RECEIPT_${label.toUpperCase()}_INVALID`);
  }
}

function validateTimestamp(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(code);
  try {
    if (new Date(value).toISOString() !== value) throw new Error(code);
  } catch {
    throw new Error(code);
  }
}

export function canonicalChatIdentity(chatUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(chatUrl);
  } catch {
    throw new Error("RECEIPT_CHAT_URL_INVALID");
  }
  if (
    parsed.protocol !== "https:" ||
    (parsed.hostname !== "chatgpt.com" && parsed.hostname !== "www.chatgpt.com") ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== "443")
  ) {
    throw new Error("RECEIPT_CHAT_URL_INVALID");
  }
  const match = parsed.pathname.match(/^\/c\/([A-Za-z0-9-]{1,160})\/?$/);
  if (!match) throw new Error("RECEIPT_CHAT_URL_INVALID");
  return `https://chatgpt.com/c/${match[1]}`;
}

function logicalKey(receipt: BrowserReceipt): string {
  return [receipt.workspaceId, receipt.taskId, receipt.round, receipt.controlId].join("\u001f");
}

function fingerprint(receipt: BrowserReceipt): string {
  return createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
}

function normalizeReceipt(
  value: unknown,
  expected: BrowserReceiptExpected,
  now: number,
  checkAge: boolean
): BrowserReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RECEIPT_SCHEMA_INVALID");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !RECEIPT_FIELDS.has(key))) throw new Error("RECEIPT_FIELD_NOT_ALLOWED");
  if (raw.schemaVersion !== 1) throw new Error("RECEIPT_SCHEMA_INVALID");

  validateToken(raw.workspaceId, "workspace", 160);
  if (raw.workspaceId !== expected.workspaceId) throw new Error("RECEIPT_WORKSPACE_MISMATCH");
  validateToken(raw.taskId, "task", 160);
  if (raw.taskId !== expected.taskId) throw new Error("RECEIPT_TASK_MISMATCH");
  if (!Number.isSafeInteger(raw.round) || (raw.round as number) < 0 || (raw.round as number) > 1_000_000) {
    throw new Error("RECEIPT_ROUND_INVALID");
  }
  if (raw.round !== expected.round) throw new Error("RECEIPT_ROUND_MISMATCH");
  validateToken(raw.controlId, "control_id", 160);
  if (!/^[A-Za-z0-9._:-]+$/.test(raw.controlId)) throw new Error("RECEIPT_CONTROL_ID_INVALID");
  if (raw.controlId !== expected.controlId || raw.responseControlId !== expected.controlId) {
    throw new Error("RECEIPT_CONTROL_ID_MISMATCH");
  }
  const chatUrl = canonicalChatIdentity(String(raw.chatUrl ?? ""));
  if (chatUrl !== canonicalChatIdentity(expected.chatUrl)) throw new Error("RECEIPT_CHAT_MISMATCH");
  if (raw.requestState !== "sent" || raw.responseState !== "received") throw new Error("RECEIPT_STATE_INVALID");
  if (raw.validationStatus !== "matched") throw new Error("RECEIPT_VALIDATION_INVALID");

  validateTimestamp(raw.requestTimestamp, "RECEIPT_REQUEST_TIMESTAMP_REQUIRED");
  validateTimestamp(raw.responseTimestamp, "RECEIPT_RESPONSE_TIMESTAMP_REQUIRED");
  const requestAt = Date.parse(raw.requestTimestamp);
  const responseAt = Date.parse(raw.responseTimestamp);
  if (responseAt < requestAt) throw new Error("RECEIPT_RESPONSE_BEFORE_REQUEST");
  if (requestAt > now + MAX_BROWSER_RECEIPT_FUTURE_SKEW_MS || responseAt > now + MAX_BROWSER_RECEIPT_FUTURE_SKEW_MS) {
    throw new Error("RECEIPT_TIMESTAMP_IN_FUTURE");
  }
  if (checkAge && now - requestAt > MAX_BROWSER_RECEIPT_AGE_MS) throw new Error("RECEIPT_EXPIRED");

  for (const field of ["requestPayloadHash", "responsePayloadHash"] as const) {
    if (typeof raw[field] !== "string" || !/^[a-f0-9]{64}$/.test(raw[field] as string)) {
      throw new Error("RECEIPT_PAYLOAD_HASH_INVALID");
    }
  }
  if (raw.responseText !== undefined && typeof raw.responseText !== "string") throw new Error("RECEIPT_RESPONSE_TEXT_INVALID");
  if (typeof raw.responseText === "string" && raw.responseText.length > MAX_BROWSER_RESPONSE_TEXT_LENGTH) {
    throw new Error("RECEIPT_RESPONSE_TEXT_TOO_LONG");
  }
  if (
    typeof raw.responseText === "string" &&
    createHash("sha256").update(raw.responseText).digest("hex") !== raw.responsePayloadHash
  ) {
    throw new Error("RECEIPT_RESPONSE_HASH_MISMATCH");
  }

  return {
    schemaVersion: 1,
    workspaceId: raw.workspaceId,
    taskId: raw.taskId,
    round: raw.round as number,
    controlId: raw.controlId,
    chatUrl,
    requestState: "sent",
    requestTimestamp: raw.requestTimestamp,
    requestPayloadHash: raw.requestPayloadHash as string,
    responseState: "received",
    responseTimestamp: raw.responseTimestamp,
    responseControlId: raw.responseControlId as string,
    responsePayloadHash: raw.responsePayloadHash as string,
    validationStatus: "matched",
    ...(typeof raw.responseText === "string" ? { responseText: raw.responseText } : {}),
  };
}

export function validateBrowserReceipt(
  receipt: unknown,
  expected: BrowserReceiptExpected,
  now = Date.now()
): BrowserReceipt {
  if (!Number.isFinite(now)) throw new Error("RECEIPT_VALIDATION_CLOCK_INVALID");
  return normalizeReceipt(receipt, expected, now, true);
}

function expectedFrom(receipt: BrowserReceipt): BrowserReceiptExpected {
  return {
    workspaceId: receipt.workspaceId,
    taskId: receipt.taskId,
    round: receipt.round,
    controlId: receipt.controlId,
    chatUrl: receipt.chatUrl,
  };
}

function readStore(workspaceId: string, now: number): ReceiptStore {
  const file = receiptStoreFile(workspaceId);
  if (!fs.existsSync(file)) return { schemaVersion: 1, workspaceId, receipts: [] };
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_RECEIPT_STORE_BYTES) throw new Error("RECEIPT_STORE_INVALID");
    const store = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (store.schemaVersion !== 1 || store.workspaceId !== workspaceId || !Array.isArray(store.receipts)) {
      throw new Error("RECEIPT_STORE_INVALID");
    }
    if (store.receipts.length > MAX_BROWSER_RECEIPTS_PER_WORKSPACE) throw new Error("RECEIPT_STORE_INVALID");
    const receipts = store.receipts.map((item) => {
      const raw = item as Record<string, unknown>;
      const selfExpected: BrowserReceiptExpected = {
        workspaceId,
        taskId: String(raw.taskId ?? ""),
        round: Number(raw.round),
        controlId: String(raw.controlId ?? ""),
        chatUrl: String(raw.chatUrl ?? ""),
      };
      const normalized = normalizeReceipt(item, selfExpected, now, false);
      if (normalized.workspaceId !== workspaceId) throw new Error("RECEIPT_WORKSPACE_MISMATCH");
      return normalized;
    });
    return { schemaVersion: 1, workspaceId, receipts };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("RECEIPT_")) throw error;
    throw new Error("RECEIPT_STORE_INVALID");
  }
}

export function listBrowserReceipts(workspaceId: string, now = Date.now()): BrowserReceipt[] {
  const store = readStore(workspaceId, now);
  const cutoff = now - MAX_BROWSER_RECEIPT_AGE_MS;
  return store.receipts.filter((receipt) => Date.parse(receipt.requestTimestamp) >= cutoff);
}

export function getBrowserReceipt(expected: BrowserReceiptExpected, now = Date.now()): BrowserReceipt | null {
  const receipts = listBrowserReceipts(expected.workspaceId, now);
  const key = [expected.workspaceId, expected.taskId, expected.round, expected.controlId].join("\u001f");
  const found = receipts.find((receipt) => logicalKey(receipt) === key);
  return found ? validateBrowserReceipt(found, expected, now) : null;
}

export function storeBrowserReceipt(receipt: BrowserReceipt, now = Date.now()): BrowserReceipt {
  const normalized = validateBrowserReceipt(receipt, expectedFrom(receipt), now);
  const current = readStore(normalized.workspaceId, now).receipts;
  const cutoff = now - MAX_BROWSER_RECEIPT_AGE_MS;
  const retained = current.filter((entry) => Date.parse(entry.requestTimestamp) >= cutoff);
  const key = logicalKey(normalized);
  const existing = retained.find((entry) => logicalKey(entry) === key);
  if (existing) {
    if (fingerprint(existing) !== fingerprint(normalized)) throw new Error("RECEIPT_REPLAY_CONFLICT");
    return existing;
  }
  retained.push(normalized);
  retained.sort((a, b) => Date.parse(a.requestTimestamp) - Date.parse(b.requestTimestamp) || logicalKey(a).localeCompare(logicalKey(b)));
  const bounded = retained.slice(-MAX_BROWSER_RECEIPTS_PER_WORKSPACE);
  writeSecureJson(receiptStoreFile(normalized.workspaceId), {
    schemaVersion: 1,
    workspaceId: normalized.workspaceId,
    receipts: bounded,
  } satisfies ReceiptStore);
  return normalized;
}
