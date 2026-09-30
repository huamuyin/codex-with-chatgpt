import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getStateDir } from "../src/config/paths.js";
import {
  getBrowserReceipt,
  listBrowserReceipts,
  MAX_BROWSER_RECEIPTS_PER_WORKSPACE,
  storeBrowserReceipt,
  validateBrowserReceipt,
  type BrowserReceipt,
  type BrowserReceiptExpected,
} from "../src/session/browser-receipt.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const NOW = Date.parse("2026-09-30T00:00:00.000Z");
const EXPECTED: BrowserReceiptExpected = {
  workspaceId: "workspace-a",
  taskId: "MISSION_R1",
  round: 2,
  controlId: "CTRL-R2-A1B2",
  chatUrl: "https://chatgpt.com/c/123e4567-e89b-12d3-a456-426614174000",
};

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function receipt(overrides: Partial<BrowserReceipt> = {}): BrowserReceipt {
  return {
    schemaVersion: 1,
    workspaceId: EXPECTED.workspaceId,
    taskId: EXPECTED.taskId,
    round: EXPECTED.round,
    controlId: EXPECTED.controlId,
    chatUrl: EXPECTED.chatUrl,
    requestState: "sent",
    requestTimestamp: "2026-09-29T23:59:00.000Z",
    requestPayloadHash: hash("request payload"),
    responseState: "received",
    responseTimestamp: "2026-09-29T23:59:10.000Z",
    responseControlId: EXPECTED.controlId,
    responsePayloadHash: hash("STATE: REVIEW\nCONTROL_ID: CTRL-R2-A1B2"),
    validationStatus: "matched",
    responseText: "STATE: REVIEW\nCONTROL_ID: CTRL-R2-A1B2",
    ...overrides,
  };
}

describe("BrowserReceipt", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("accepts a valid receipt and canonicalizes chat URL variations", () => {
    const value = receipt({ chatUrl: `${EXPECTED.chatUrl}/?utm_source=review#message` });
    expect(validateBrowserReceipt(value, EXPECTED, NOW).chatUrl).toBe(EXPECTED.chatUrl);
  });

  it.each([
    [{ requestTimestamp: "" }, "RECEIPT_REQUEST_TIMESTAMP_REQUIRED"],
    [{ responseTimestamp: "" }, "RECEIPT_RESPONSE_TIMESTAMP_REQUIRED"],
    [{ responseControlId: "stale-control" }, "RECEIPT_CONTROL_ID_MISMATCH"],
    [{ responseTimestamp: "2026-09-29T23:58:00.000Z" }, "RECEIPT_RESPONSE_BEFORE_REQUEST"],
    [{ requestTimestamp: "2026-08-01T00:00:00.000Z" }, "RECEIPT_EXPIRED"],
    [{ responseTimestamp: "2026-09-30T00:10:00.000Z" }, "RECEIPT_TIMESTAMP_IN_FUTURE"],
    [{ requestState: "queued" }, "RECEIPT_STATE_INVALID"],
    [{ responseState: "streaming" }, "RECEIPT_STATE_INVALID"],
    [{ validationStatus: "unverified" }, "RECEIPT_VALIDATION_INVALID"],
    [{ responsePayloadHash: "0".repeat(64) }, "RECEIPT_RESPONSE_HASH_MISMATCH"],
    [{ responseText: "x".repeat(17_000) }, "RECEIPT_RESPONSE_TEXT_TOO_LONG"],
    [{ responseText: "😀".repeat(5_000) }, "RECEIPT_RESPONSE_TEXT_TOO_LONG"],
    [{ cookie: "must-not-be-accepted" } as Partial<BrowserReceipt>, "RECEIPT_FIELD_NOT_ALLOWED"],
  ] as Array<[Partial<BrowserReceipt>, string]>)("rejects invalid receipt fields (%s)", (overrides, code) => {
    expect(() => validateBrowserReceipt(receipt(overrides), EXPECTED, NOW)).toThrow(code);
  });

  it.each([
    [{ ...EXPECTED, workspaceId: "workspace-b" }, "RECEIPT_WORKSPACE_MISMATCH"],
    [{ ...EXPECTED, taskId: "OTHER_MISSION" }, "RECEIPT_TASK_MISMATCH"],
    [{ ...EXPECTED, round: 3 }, "RECEIPT_ROUND_MISMATCH"],
    [{ ...EXPECTED, controlId: "OTHER_CONTROL" }, "RECEIPT_CONTROL_ID_MISMATCH"],
    [{ ...EXPECTED, chatUrl: "https://chatgpt.com/c/other" }, "RECEIPT_CHAT_MISMATCH"],
  ] as Array<[BrowserReceiptExpected, string]>)("rejects expected identity mismatch (%s)", (expected, code) => {
    expect(() => validateBrowserReceipt(receipt(), expected, NOW)).toThrow(code);
  });

  it.each(["https://example.com/c/chat", "https://chatgpt.com/auth/login", "http://chatgpt.com/c/chat"])(
    "rejects unsupported chat identity %s",
    (chatUrl) => {
      expect(() => validateBrowserReceipt(receipt({ chatUrl }), EXPECTED, NOW)).toThrow("RECEIPT_CHAT_URL_INVALID");
    }
  );

  it("stores, reads, lists and idempotently replays exact receipts per workspace/task", () => {
    const dir = makeTmpDir("browser-receipt-store");
    dirs.push(dir);
    process.env.C2C_STATE_DIR = dir;
    const first = receipt();
    expect(storeBrowserReceipt(first, NOW)).toEqual(expect.objectContaining({ controlId: EXPECTED.controlId }));
    expect(storeBrowserReceipt(first, NOW)).toEqual(first);
    expect(listBrowserReceipts(EXPECTED.workspaceId, NOW)).toHaveLength(1);
    expect(getBrowserReceipt(EXPECTED, NOW)).toEqual(first);
    expect(getBrowserReceipt({ ...EXPECTED, workspaceId: "workspace-b" }, NOW)).toBeNull();
  });

  it("rejects conflicting replay and cross-workspace persisted substitution", () => {
    const dir = makeTmpDir("browser-receipt-replay");
    dirs.push(dir);
    process.env.C2C_STATE_DIR = dir;
    storeBrowserReceipt(receipt(), NOW);
    expect(() =>
      storeBrowserReceipt(
        receipt({ responseText: "conflicting response", responsePayloadHash: hash("conflicting response") }),
        NOW
      )
    ).toThrow("RECEIPT_REPLAY_CONFLICT");

    const file = path.join(getStateDir(), "receipts", "workspace-a.json");
    const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    persisted.receipts[0].workspaceId = "workspace-b";
    fs.writeFileSync(file, JSON.stringify(persisted));
    expect(() => listBrowserReceipts("workspace-a", NOW)).toThrow("RECEIPT_WORKSPACE_MISMATCH");
    expect(listBrowserReceipts("workspace-b", NOW)).toEqual([]);
  });

  it("fails closed on malformed persisted receipt data", () => {
    const dir = makeTmpDir("browser-receipt-corrupt");
    dirs.push(dir);
    process.env.C2C_STATE_DIR = dir;
    const receiptDir = path.join(getStateDir(), "receipts");
    fs.mkdirSync(receiptDir, { recursive: true });
    fs.writeFileSync(path.join(receiptDir, "workspace-a.json"), "{not-json");
    expect(() => listBrowserReceipts("workspace-a", NOW)).toThrow("RECEIPT_STORE_INVALID");
  });

  it.each(["../other", "../shared-runtime", "../../shared-runtime", "a/b", "a\\b", "C:\\temp\\receipt", "\\\\server\\share"])(
    "rejects unsafe workspace id %s without touching sibling machine state",
    (workspaceId) => {
      const dir = makeTmpDir("browser-receipt-path-guard");
      dirs.push(dir);
      process.env.C2C_STATE_DIR = dir;
      const sibling = path.join(getStateDir(), "shared-runtime.json");
      fs.writeFileSync(sibling, "sentinel");
      expect(() =>
        storeBrowserReceipt(receipt({ workspaceId, taskId: "path-test" }), NOW)
      ).toThrow("RECEIPT_WORKSPACE_INVALID");
      expect(fs.readFileSync(sibling, "utf8")).toBe("sentinel");
      expect(fs.existsSync(path.join(getStateDir(), "receipts", "..", "other.json"))).toBe(false);
    }
  );

  it("keeps multibyte and JSON-escaped bounded text readable after persistence", () => {
    const dir = makeTmpDir("browser-receipt-unicode");
    dirs.push(dir);
    process.env.C2C_STATE_DIR = dir;
    const multibyteText = "é".repeat(6_000);
    const unicodeReceipt = receipt({
      responseText: multibyteText,
      responsePayloadHash: hash(multibyteText),
    });
    storeBrowserReceipt(unicodeReceipt, NOW);
    expect(getBrowserReceipt(EXPECTED, NOW)?.responseText).toBe(multibyteText);

    const escapedText = "\u0000".repeat(2_000);
    const escapedExpected = { ...EXPECTED, round: 3, controlId: "CTRL-ESCAPED" };
    storeBrowserReceipt(
      receipt({
        ...escapedExpected,
        responseControlId: escapedExpected.controlId,
        responseText: escapedText,
        responsePayloadHash: hash(escapedText),
      }),
      NOW
    );
    expect(listBrowserReceipts(EXPECTED.workspaceId, NOW)).toHaveLength(2);
    expect(getBrowserReceipt(escapedExpected, NOW)?.responseText).toBe(escapedText);
  });

  it("enforces per-workspace retention and cannot prune another workspace", () => {
    const dir = makeTmpDir("browser-receipt-retention");
    dirs.push(dir);
    process.env.C2C_STATE_DIR = dir;
    for (let round = 0; round <= MAX_BROWSER_RECEIPTS_PER_WORKSPACE; round++) {
      const nextExpected = { ...EXPECTED, round, controlId: `CTRL-${round}` };
      storeBrowserReceipt(
        receipt({
          round,
          controlId: nextExpected.controlId,
          responseControlId: nextExpected.controlId,
          requestTimestamp: new Date(NOW - 10_000 + round).toISOString(),
          responseTimestamp: new Date(NOW - 5_000 + round).toISOString(),
        }),
        NOW
      );
    }
    storeBrowserReceipt(
      receipt({ workspaceId: "workspace-b", taskId: "B", round: 1, controlId: "CTRL-B", responseControlId: "CTRL-B" }),
      NOW
    );
    expect(listBrowserReceipts("workspace-a", NOW)).toHaveLength(MAX_BROWSER_RECEIPTS_PER_WORKSPACE);
    expect(listBrowserReceipts("workspace-b", NOW)).toHaveLength(1);
  });
});
