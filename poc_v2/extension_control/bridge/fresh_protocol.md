# Fresh protocol 3 / 0.9.8 — B2 transition diagnostics

## Authorized failure recovery / ten-turn campaign R1

The accepted 0.9.8/protocol-3/build identity stays unchanged. Host, extension Origin,
ephemeral controller token, exact native tab/URL, immutable request/control/commit/iteration
and positive completed-reply gates are unchanged. No old journal is initialized, rewritten
or migrated. Old smoke recovery remains permanently closed.

`observe_request` requires an explicit known request_id/control_id/attempt_id and exact live
target. It can explicitly re-observe a completed modern request to prove duplicate classification;
it never dispatches a send. The legacy ID cannot be looked up. `reload_tab` reloads only the
verified unique Fresh native tab at its saved URL; ACK means Chrome accepted the reload API,
and readiness after navigation must separately be verified. `reload_content` checks a strictly
advanced content-generation witness after same-version reinjection. Generation is lifecycle
diagnostic data, not a request nonce or durable authority. Replaced content instances retire
their waiters and cannot click or report results/errors afterward.

Authenticated optional `observation` settings are bounded to reply_wait_ms=1000..600000 and
an observation-only controlled locator_miss boolean. They are outside the immutable original
payload and cannot change identity, wire text, completion rules or send authority. The controller
records test settings; actual timeout/failure events remain in the append-only journal. A
controlled miss must be reported as fault injection, not as a natural DOM disappearance.
Normal PING wakeups allow existing observers to recheck the same binding when Chrome delays
timers; four stable reply samples still require at least 500 ms spacing.

`probe_reply_rejection` is an authenticated diagnostic on one explicit known attempt. Content
reads the real matched completed reply, background applies one constrained identity/URL mutation
to a diagnostic copy and uses the same validator as normal results. No probe ever forwards a
result or creates a task, even if a validator defect is detected. Probe ACK carries only field,
rejection code and success/failure; journal/result authority remains unchanged.

All machine reviewer replies must use one fenced json object. `fresh_response.py` accepts only
that exact fence or a recognized rendered JSON/json language label, rejects naked JSON, unknown
wrappers, duplicate keys, nonfinite values, malformed JSON and wrong typed envelope identities.
It does not repair or infer missing content. Malformed variants and original raw replies are
preserved outside Git. Browser lifecycle gates require real Chrome observations; mock results
alone must not be labelled real-browser passes. The ten-turn substantive loop starts only after
all bounded failure gates pass and ends after ten accepted decisions and their finite actions.

## B2 autonomous correction 2

Correction 3 extends the same read-only diagnostics with a bounded list of transcript-node
tags, role/author/aria-label/test-ID attributes, sizes, marker fields and wire equality. Text
samples are included only for nodes containing both the known Fresh request/control IDs;
unrelated nodes expose no text. No HTML, cookies, credentials, browser backend or other tab is read.

Correction 4 follows actual Chrome reporting no matching main/article nodes: the diagnostic-only
walk inspects at most 4000 current-document elements and returns at most 40 identity-bearing nodes.
Text samples require both known IDs and a length <=1600; broad wrapper text is never returned.
The sending/reply locator is unchanged pending this real structural evidence.

Correction 5 adds six ancestor levels with role-heading and action-button metadata for the
identity-bearing nodes. It probes localized semantic turn boundaries and positive completion
controls; the formal result path remains unchanged until these facts are observed.

Correction 6 repairs the authenticated maintenance handoff during a reconnect loop. A token-
authenticated reload_extension command may remain in memory for ten seconds while disconnected;
after exact-Origin/token WebSocket authentication it is delivered for at most 100 ten-millisecond
handoff steps, stopping on ACK, expiry or session replacement. No request/send/retry is queued,
no token is persisted, and content maintenance still requires an exact live target. The one-off
bridge repair preserves 0.9.8 protocol/build compatibility and is identified by its changed startup
source SHA. WebSocket exit now exposes only a safe error class or frame-too-large code.

Correction 7 bounds diagnostics to two identity-bearing message nodes, six ancestor levels,
three truncated control attributes and 12000 serialized characters overall. The actual Chrome
handoff rejected a diagnostic frame with ValueError and the queued authenticated reload succeeded
without user action. Safe frame-parser codes are now exposed; frame/authentication bounds remain
unchanged. No logical request has been recreated or retried during these diagnostic updates.

Correction 8 uses the real Chrome DOM evidence: a bounded main traversal recognizes exact
localized/English H4-H6 role headings with one payload child. Full wire matching is unchanged;
nested unknown containers are removed only if they contain a recognized message. Separate
unknown/user turns remain barriers. Completion requires positive copy controls within one assistant
heading region, no other heading, no streaming/busy signal and four stable text samples.

Explicit token-authenticated observe_attempt selects one saved unfinished Fresh attempt, an exact
unique complete native tab and either its saved URL or same-native-tab pending root transition.
The extension independently verifies the entire saved attempt and current components. The content
observation path can only match already-existing wire messages; it never touches the composer or
creates/retries/sends. Proven full-message association goes through the existing bound/result gates,
appending real thread_bound/result events. It does not recover or import any legacy smoke.

Correction 9 adds the bounded paired user/assistant heading region to completion inspection.
It requires exactly those two ordered role headings, contains the full matched user and selected
first assistant, and an explicit assistant copy control (Copy response/复制/复制回复). A user's
复制消息 control is excluded. Another user/unknown heading cannot authorize completion.
Diagnostics expose copy-control and streaming/status metadata; live Chrome remains the gate.

Live Chrome accepted POST bootstrap and authenticated WebSocket. A single new Fresh attempt
navigated the original native tab from root to a new thread, but no binding/result reached the
controller before its timeout. Explicit retry was rejected before journal write because the
thread was still unbound. Those real events remain unchanged; no second send intent was written.

PING can now report bounded, non-secret role/count/full-wire/completion diagnostics for known
Fresh attempts at their exact native tab. It never sends, binds, accepts or returns raw DOM/reply.
Content-return rejection codes are observable without token/header exposure. Script-only maintenance
can update this Fresh extension's content files at a pending root transition on the same native tab;
this does not authorize a new journal URL. Exact sender URL/reply gates remain in place.

Replay validates each prior attempt against its frozen, explicitly known Fresh version/build pair,
including consistent background/content/manifest components. The live ready gate still requires the
current exact build. This permits a verified Fresh-only patch restart without rewriting history or
migrating authority. Unknown/mixed builds and secret fields fail closed; protocol 3 is unchanged.

## Owner decision

`DUPLICATE_SEND_ALLOWED=true`, `DELIVERY_SEMANTICS=AT_LEAST_ONCE`.
No exactly-once acceptance condition. The legacy original-smoke recovery work is closed.
Its owner-retained historical facts are `SEND_SUCCESS + REAL_REPLY_OBSERVED + RECOVERY_UNPROVEN`.
The legacy ID `4754374f-14dd-4004-bf87-3b87972e17fa` is explicitly excluded from this ledger.
No legacy authority import, migration, backfill, or fabricated nonce/fingerprint is supported.

This candidate is a separate Fresh entrypoint, not an update to the loaded 0.8.1 observer.
The previous 14 source files and their diagnostic/regression behavior remain byte-identical
to this round's baseline. They are historical compatibility sources, not the Fresh sending path.
`fresh_bridge.py`, `fresh_delivery.py`, `fresh_manifest.json` and the `fresh_*.js` files implement Fresh.
No existing runtime, installed extension, real request, branch head, or other project is changed.

## Identity and attempts

One logical request has fixed UUID `request_id` and `control_id`, and an immutable original
payload: task_id, iteration, repo, pr, branch, exact commit, evidence_path, instruction,
and the originally requested conversation URL. The current HEAD is never consulted.
For a newly created Fresh request, the ready tab's actual thread URL is saved separately
from that original payload; an omitted payload URL does not erase an existing thread binding.
Each persisted actual-send intent gets the next integer `attempt_id`, its complete wire message,
native tab ID, observed thread/root URL, component report, and frozen bridge startup identity.
The intent records an attempt that *may* have been sent; it does not prove a click occurred.
`NONCE=control_id` remains only a transcript locator anchor; it is not an exactly-once token.

The wire contains REQUEST_ID, CONTROL_ID and ATTEMPT_ID plus the explicit review evidence fields.
Each actual retry increments attempt_id and retains request_id/control_id. A nonce observed in
a prior attempt for this same request/control no longer prohibits sending the next attempt.
One click per attempt is an implementation detail; another attempt is permitted by owner policy.

## Minimal persistence

The explicit approved data root is `D:\ProjectData\codex-with-chatgpt`.
Future deployed journals belong under `runtime/extension_control_fresh_18797/<namespace>`.
This round creates synthetic journals only inside its evidence directory, never runtime storage.
Initialization is explicit and requires a new directory; existing or damaged journals are never reset.

Events are logical_created, send_attempt, delivery_uncertain, attempt_failed, thread_bound,
result, duplicate_reply. Each event carries request/control identity and exact data.
Logical creation and send_attempt are fsynced and read back before the WebSocket dispatch.
Failures, replies and duplicates are appended; prior bytes remain unchanged.
An event hash chain and atomic sealed head detect damage, truncation including complete-tail deletion,
unexpected schemas, altered wire messages and invalid attempt sequences. A process holds the writer
lock. Partial transactions block further sending and reopening; no automatic repair is attempted.
Hashes are integrity checks, not signatures against an attacker able to rewrite all local files.
The seal may fail closed after a power loss; guaranteed power-loss recovery is not claimed.
Control tokens are ephemeral and excluded from journal/checkpoint/results.

Restart validates and loads saved events without sending, retrying or writing a derived failure.
Unfinished intents stay uncertain/pending and are explicitly retryable under the new owner policy.
The extension's `c2c.fresh.v3.attemptMirror` is expendable and is rebuilt from the authenticated bridge
checkpoint; legacy storage is not read. Reconnect/reload never auto-replays a send or old reply.
No persistent Chrome-installation authority or original-fingerprint migration is required for Fresh.
Concurrent live extension sessions cannot take over an existing bridge connection.

## HTTP / WebSocket

Dedicated prospective endpoint: `127.0.0.1:18797`; no socket is opened by offline tests.
Host/origin/control-token gates apply. Bootstrap and welcome expose frozen version, protocol,
build, PID, source hash, start time, extension ID and bridge session identity.
Background, content, locator, contract, shared identity and manifest versions/builds are checked.
Version is 0.9.8, protocol 3, build `c2c-v2-fresh-paired-turn-completion-1`.
The source hash is a startup disk snapshot, not remote code attestation.

- POST /review without request_id: create a future logical request and attempt 1, requiring ready components.
- POST /review with request_id **and control_id**: poll with the original payload, no send.
- POST /retry with request_id/control_id and the identical original payload: append the next attempt and send.
  Explicit retry is allowed after a timeout, locator failure, uncertain dispatch or restart.
  A completed request returns its existing result and cannot create a new logical task.
- POST /recover: 410 `legacy_recovery_closed`. No legacy DOM recovery path exists in Fresh.
- GET /health: readiness/identity and non-secret boundary diagnostics, no token.
- POST /bootstrap: the Fresh background uses POST so Chrome supplies its actual extension Origin.
  Exact loopback/Host/extension-Origin checks remain. Missing/null/wrong Origin is rejected for both
  GET and POST; no Sec-Fetch-* exception or forged Origin is allowed. Actual Chrome POST acceptance,
  method and origin-match booleans are exposed as non-secret bridge-observed diagnostics.
- POST /maintenance: exact Host plus the same ephemeral controller token and an authenticated Fresh
  WebSocket are required. `reload_extension` updates only this Fresh installation; ACK precedes reload.
  `reload_content` installs only the four declared Fresh files into an exact unique completed setup-root
  tab before a request, or a recorded Fresh thread/native tab. Background repeats these checks and
  excludes the closed legacy-smoke URL. This explicit maintenance path never creates or sends a logical
  request, and records no new authority in its journal. Startup/reconnect still never auto-send.

HTTP waiting timeout is a separate attempt_failed event. It does not prove the message was unsent.
Late replies remain eligible. A disconnected/mixed/ambiguous target is not made ready by retry permission.

## Reply acceptance

The extension requires a unique exact-URL completed target, exact native ID for that attempt,
matching request/control/attempt/task/iteration/repo/branch/commit envelope and compatible components.
Future retries may use a newly reopened native tab for the same uniquely identified thread;
this applies only to Fresh, never to the historical original-smoke binding.
The sending path uses no active-tab fallback, navigation, reload, tab creation or script injection.
Under the owner's B2 autonomous repair envelope, the separate authenticated maintenance path can
reload this Fresh extension or update its own content scripts at the verified Fresh target.
It does not use or modify a legacy extension, another browser origin, or legacy smoke authority.

The content script matches the full user wire message including control/attempt markers and selects
the first assistant following that user; an intervening user or unknown turn stops matching.
Positive generation-completion evidence plus four stable samples is required.
Request/control binding of the assistant comes from this matched user/assistant association and the
validated transport envelope. Arbitrary copied assistant text cannot satisfy it. If a review instruction
requires IDs inside its structured reply body, the downstream review parser must validate that body too.
Raw reply text is preserved without trimming or Unicode conversion.

Any known attempt's legal completed reply can finish the logical request, including an earlier
attempt after a retry started. The first accepted result remains canonical. Further valid replies
append duplicate_reply and never create another logical task. Late errors do not uncomplete a result.
No proof of only one actual send is required. Attempts and errors remain in the audit history.

## Scope / practical limits

This is a single-tab PoC with explicit retry, not an automatic long-running retry scheduler.
The existing shared WebSocket frame bound (256 KiB) applies to checkpoints; this PoC has no
checkpoint pagination or archive compaction. Larger histories must not be treated as validated.
GitHub evidence reading, downstream structured PLAN validation and model selection remain separate
Fresh Smoke acceptance gates. Offline passes do not prove a real send, real reply, Stage B acceptance,
Round 4 eligibility, or deployment readiness.

## Minimum next Fresh Smoke deployment proposal — not performed

1. Main Chat independently reviews this complete source/diff/hash/test evidence and owner policy.
2. After separate deployment/send authorization, assemble only the six Fresh extension source files
   in a new data-root build directory; rename fresh_manifest.json to manifest.json. No key is included:
   install as a separate extension ID and preserve both existing extensions and bridges.
3. Verify 18797 is free at execution time; do not kill an unknown owner. Initialize a new namespace
   with --data-root/--namespace/--extension-id and --initialize-journal, using fresh_bridge.py.
   Retain the old 18795 and inspection-only 18796 runtimes.
4. Open a separate ordinary subscription high-reasoning Chat with the intended model and 极高.
   Verify actual bridge/background/content/manifest versions, exact target and GitHub connector.
5. Only after send permission, create one new synthetic Fresh Smoke logical request with new IDs.
   If it times out, /retry keeps those IDs and increments attempt_id. Prove one canonical completed
   result and duplicate classification if a late reply appears; evidence must show actual behavior.
6. Stop at the Fresh Smoke review gate. No legacy resend/recovery, Round 4, family-fund change,
   commit or push is included in this proposal.
