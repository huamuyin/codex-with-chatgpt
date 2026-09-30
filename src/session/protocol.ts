import {
  getBrowserReceipt,
  validateBrowserReceipt,
  type BrowserReceipt,
  type BrowserReceiptExpected,
} from "./browser-receipt.js";
import { getWorkspaceTransport, type WorkspaceTransportMode } from "./transport.js";
import { mergeSession, type SavedSession, type TaskCheckpoint } from "./state.js";

export type SentEvidence =
  | { kind: "browser-receipt" }
  | { kind: "legacy-ack"; acknowledged: boolean };

export interface ProtocolDependencies {
  getTransport(workspaceId: string): WorkspaceTransportMode;
  getReceipt(expected: BrowserReceiptExpected, now: number): BrowserReceipt | null;
}

const defaultDependencies: ProtocolDependencies = {
  getTransport: (workspaceId) => getWorkspaceTransport(workspaceId).mode,
  getReceipt: (expected, now) => getBrowserReceipt(expected, now),
};

export type ExecutedLocalInput = {
  taskId: string;
  iteration: number;
  chatUrl: string;
  controlId: string;
} & Partial<Pick<TaskCheckpoint, "waitingFor" | "originalGoal" | "completedSubtasks" | "knownIssues" | "nextExpectedStep" | "projectUrl">>;

export function markExecutedLocal(previous: SavedSession | null, input: ExecutedLocalInput): SavedSession {
  if (!Number.isSafeInteger(input.iteration) || input.iteration < 0) throw new Error("PROTOCOL_ITERATION_INVALID");
  if (!input.taskId.trim() || !input.controlId.trim() || !input.chatUrl.trim()) {
    throw new Error("PROTOCOL_CHECKPOINT_IDENTITY_REQUIRED");
  }
  return mergeSession(previous, {
    taskId: input.taskId,
    iteration: input.iteration,
    checkpoint: {
      ...input,
      protocolState: "EXECUTED_LOCAL",
      waitingFor: input.waitingFor ?? "none",
    },
  });
}

function checkpointExpected(previous: SavedSession, workspaceId: string): BrowserReceiptExpected {
  const checkpoint = previous.checkpoint;
  if (!checkpoint?.taskId || !checkpoint.controlId) throw new Error("PROTOCOL_CHECKPOINT_IDENTITY_REQUIRED");
  const chatUrl = checkpoint.chatUrl ?? previous.url;
  if (!chatUrl) throw new Error("PROTOCOL_CHECKPOINT_IDENTITY_REQUIRED");
  return {
    workspaceId,
    taskId: checkpoint.taskId,
    round: checkpoint.iteration,
    controlId: checkpoint.controlId,
    chatUrl,
  };
}

function transition(previous: SavedSession, protocolState: "EXECUTED_SENT"): SavedSession {
  const checkpoint = previous.checkpoint;
  if (!checkpoint) throw new Error("PROTOCOL_CHECKPOINT_REQUIRED");
  return mergeSession(previous, {
    checkpoint: {
      ...checkpoint,
      protocolState,
      waitingFor: "GPT_REVIEW",
    },
  });
}

export function advanceExecutedSent(
  previous: SavedSession,
  workspaceId: string,
  evidence: SentEvidence,
  dependencies: ProtocolDependencies = defaultDependencies,
  now = Date.now()
): SavedSession {
  const mode = dependencies.getTransport(workspaceId);
  const current = previous.checkpoint?.protocolState;

  if (mode === "local-cdp") {
    if (evidence.kind !== "browser-receipt") throw new Error("BROWSER_RECEIPT_REQUIRED");
    if (current !== "EXECUTED_LOCAL" && current !== "EXECUTED_SENT") throw new Error("PROTOCOL_LOCAL_STATE_REQUIRED");
    const expected = checkpointExpected(previous, workspaceId);
    const receipt = dependencies.getReceipt(expected, now);
    if (!receipt) throw new Error("BROWSER_RECEIPT_REQUIRED");
    validateBrowserReceipt(receipt, expected, now);
    if (current === "EXECUTED_SENT") return previous;
    return transition(previous, "EXECUTED_SENT");
  }

  if (evidence.kind !== "legacy-ack" || evidence.acknowledged !== true) throw new Error("LEGACY_ACK_REQUIRED");
  if (current === "EXECUTED_SENT") return previous;
  if (!previous.checkpoint) {
    const taskId = previous.taskId;
    if (!taskId) throw new Error("PROTOCOL_CHECKPOINT_REQUIRED");
    const iteration = previous.iteration ?? 0;
    return mergeSession(previous, {
      checkpoint: {
        taskId,
        iteration,
        protocolState: "EXECUTED_SENT",
        waitingFor: "GPT_REVIEW",
        chatUrl: previous.url,
        projectUrl: previous.projectUrl,
      },
    });
  }
  return transition(previous, "EXECUTED_SENT");
}
