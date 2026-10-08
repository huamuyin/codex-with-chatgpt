# C2C V2 extension control protocol — binding diagnostic proposal 0.8.1

This is an offline source candidate. It has not been loaded into the real bridge or browser.
Scope remains the ordinary subscription ChatGPT tab, localhost bridge and extension.

## Component identity and readiness

Protocol version: 2. Bridge, background, content, helpers and manifest version: 0.8.1.
Build ID: c2c-v2-binding-diagnostic-1.

At module startup the bridge freezes its version, protocol, build ID, PID, start timestamp
and startup_source_sha256. BridgeState adds bridge_session_id. Health/bootstrap/welcome return
that frozen identity. Health never rehashes a subsequently edited disk source.
The hash describes the startup disk-source snapshot, not remote attestation.
Health never exposes the control token. Bootstrap remains extension-origin gated.

The background verifies bootstrap/welcome identity, its own version, the manifest and helpers.
Content PING reports its own version/build and exact URL, after checking contract/locator versions.
Old string-only PING is rejected. Background/content/manifest versions and builds are separately
reported to the bridge. Any mismatch makes tab/content readiness false.
A websocket connection alone does not establish readiness.

## Normal sending: POST /review

Host is restricted to 127.0.0.1:18796; websocket origin is restricted to the fixed extension.
Payload: task_id, iteration, repo, pr, branch, exact commit, evidence_path, instruction,
control_token, optional conversation_url and bounded wait_seconds.

Without request_id, this is a new send. Both a live compatible extension and a ready tab are
required, even if conversation_url is supplied. A supplied URL must equal the bound URL.
With request_id, this endpoint only polls the original request/terminal record.

For NEW protocol-2 requests only, bridge creates ID/nonce once and adds REQUEST_ID to the message.
It never reads HEAD to choose an expected commit. It saves the original schema, task, iteration,
nonce, requested commit, full message, fingerprint, fingerprint schema and native target tab ID.
Original terminal records are never evicted; capacity 64 blocks new sends instead.

Fingerprint algorithm stays unchanged: SHA256 of deterministic JSON of task_id, iteration, repo,
pr, branch, commit, evidence_path, instruction and ORIGINAL conversation_url
(fingerprint schema v1-conversation-url). A later discovered binding is separate evidence.
It never replaces the fingerprint. Recovery callers must preserve the original review payload.

For a new request sent from the root page, the first matched user turn may provide review_bound
on the SAME tab and a verified /c/ URL. This binding is pinned once and cannot be overwritten.
Missing binding evidence blocks recovery; caller metadata cannot fill missing evidence.

Extension saves new originals under its separate protocol-2 session key. Result acknowledgement
does not delete original identities or nonce history. Reconnect is resume-only.
Status messages never enqueue another review. The active page is not used to replace a target.
No tab is automatically created or reloaded. A missing pinned target remains missing.

## Original recovery: POST /recover

Recovery is isolated from sending. It never calls send_request_once, dispatchRequest or runReview;
never allocates a request ID/nonce; never requeues a review; never edits the composer or clicks Send;
never creates, navigates or reloads a tab. It scans the existing exact pinned conversation.
It DOES record a separate recovery attempt/result, so it is not a strict read-only diagnostic GET.

Submit the IDENTICAL original review payload/request_id plus expected_reply.
Bridge trusts only the pre-existing saved original. Unknown IDs, legacy schemas, missing trusted
nonce/commit/iteration/message/fingerprint/tab/URL evidence, or changed payloads are rejected.
No submitted nonce or new URL is adopted. No old record is upgraded or migrated.

Limited recovery whitelist: failed/outgoing_turn_not_confirmed and failed/chat_tab_unavailable,
only with complete trusted protocol-2 evidence. Other statuses/errors are rejected.
This protocol change neither modifies historical failures nor relaxes identity requirements.

Extension independently requires its pre-existing protocol-2 original. Missing evidence,
wrong request ID/nonce/iteration/commit/full message, wrong native tab ID, different URL,
multiple exact-URL tabs or incompatible components fail closed.
Recovery never injects or upgrades a missing content script; missing content is rejected.

Recovery wire includes the saved request ID, task, iteration, nonce, commit, native tab ID,
exact conversation URL and original full message. attempt is a counter, not a replacement identity.
The user DOM message must uniquely contain all saved markers and match the whole original message.
The following assistant cannot occur beyond another user or unknown semantic turn.

Five flags:
- original_user_turn_found: unique full saved user identity/message found.
- original_nonce_found: that user matches the saved original nonce.
- original_commit_found: that user matches the saved exact expected commit.
- subsequent_assistant_turn_found: assistant before the next user/unknown semantic turn.
- assistant_reply_exact: raw-exact-v1 comparison below.

Completion additionally requires positive evidence: complete message status or a visible response Copy
action within the assistant turn; visible generating/busy evidence defeats completion.
Content requires four identical completed samples at 500 ms intervals. Missing completion or unstable
generation fails after 30 seconds. These DOM assumptions are mock-tested only, not live UI acceptance.

raw-exact-v1: actual and expected must be strings, expected nonempty, and actual exactly equal.
No trimming, CR removal, Unicode normalization, case conversion or whitespace folding for replies.
The shared test vectors are used by both Python and Node.
User marker/full-message location may normalize NFC/whitespace; reply matching does not.

Content captures extraction URL and verifies it throughout sampling. Worker verifies extraction URL,
sender URL, current tab URL, saved URL and native tab ID; it does not substitute a new URL.
Bridge repeats exact saved identity/URL/tab, five flags, generation completion and raw comparison.

The original completed/failed record is immutable. recovery_attempts holds separate results.
POST /recover waits/polls/caches its same attempt; POST /review still returns the original failure.
A failed recovery attempt is cached too. No automatic fresh attempt, force reset or retry API is added.
Recovery acknowledgements cannot clear normal-send state.

## Historical records and persistence

State stays in bridge memory / Chrome session storage. No persistence or old-record migration is added.
Real old smoke records are not imported, reconstructed from HEAD or assigned protocol-2 evidence.
After restart, unknown IDs still fail closed; clearing history cannot make recovery permissible.
If old smoke evidence is insufficient, a separately reviewed evidence preservation/import design
would be required. This revision deliberately does not implement one.

This revision authorizes no runtime restart/reload, real request, Round 4, commit, push or promotion.

## Offline verification

Python uses in-memory sessions/HTTP handler mocks, with no HTTP server. Node uses VM sandboxes,
fake Chrome APIs, synthetic DOM and fake clocks. Recovery send/navigation/reload/create spies throw.
Run the complete bridge Python suite and every tests/*.test.cjs, syntax checks and manifest checks.
Store outputs and compilation bytecode only under an explicit project_data_root evidence directory.

## Revision 3: unverified historical inspection

Current proposed component version 0.8.1, build c2c-v2-binding-diagnostic-1; recovery schema remains 2.
CLI defaults to --mode inspection-only. In that mode both send and recovery return
inspection_mode_locked before any allocation or original-state action. Normal mode is explicit.

POST /inspect is an authenticated diagnostic observation, not recovery or authority import.
It accepts original review reference fields, existing request_id, exact conversation_url,
explicit target_tab_id and expected_reply. Unknown IDs are allowed as diagnostic hints only.
Missing URL/tab or concurrent normal/recovery/inspection operations are rejected.
No request ID/nonce is generated. Existing original/failed records and nonce history remain unchanged.
A separate bounded in-memory observation slot is used and times out without requeueing.

The worker queries exact historical tab ID and URL without changing its normal target,
choosing an active page, navigating, injecting, reloading or writing Chrome session storage.
It requires matching loaded content identity on that exact tab. Wrong IDs, duplicate URL tabs,
loading/missing tabs, old content or mismatched extraction URL fail closed.

Content finds legacy candidates using task/iteration/commit plus the whole saved message template,
substituting the DISCOVERED nonce into that template for location only. Up to four candidates
are returned; more is an error. Reply observations remain separate from completion/recovery proof.
Bridge independently checks returned metadata, template and content version.

Every result is forced to authoritative=false, original_nonce_verified=false and
recovered_original=false, including when a component supplied a conflicting true flag.
Observed candidates are not added to originals or completed, and cannot unlock POST /recover.
The controller may save an observation artifact under project_data_root; no historical
import, persistence, fingerprint rewrite or recovery acceptance is implemented here.


## Normal response proof (revision 3)

Normal content also requires a unique whole original user message, native tab binding and exact
conversation URL throughout extraction. Root-to-conversation binding is allowed once only for
a new request on that same tab. The assistant must precede the next user/unknown turn and have
positive completion evidence plus four identical samples. Raw reply text is never trimmed or
CR/Unicode-normalized. Normal content, worker and bridge all require raw-exact-v1 metadata,
generation-complete=true, current matching component identity and exact tab/URL. Worker and
bridge reject incomplete, stale-component or wrong-session responses instead of accepting
identity markers alone. This is transport proof; a later controller must still substantively
validate the Chat's nonce/commit and structured PLAN/REVIEW before executing instructions.

## Isolated inspection preparation (component 0.7.0)

Build c2c-v2-isolated-inspection-1 fixes the candidate endpoint to 127.0.0.1:18796.
The historical running bridge on 18795 is not stopped, replaced or reset by this source change.
The candidate bridge publishes its frozen startup host/port; background independently derives
HTTP/WebSocket URLs from component identity and refuses a different host/port. CSP only permits
the candidate 18796 transport. Missing/old endpoint metadata cannot report ready.
Default CLI inspection-only mode still rejects real send/recover. A busy port aborts without
terminating any owner process. No request import or persistence is added.

The 0.7.0 candidate was mock-tested and later started in inspection-only mode with explicit
authorization. No candidate extension was loaded and no inspection request was made.
The proposed reload of the existing extension was withdrawn before execution: Chrome clears
storage.session on extension reload. The deployment plan below preserves the old extension.
Loading source components is an explicit deployment action. This protocol does not authorize
injection, reload, stop/start, old-request resend, state edit, Round 4, commit or push.

## Independent observer preparation (component 0.8.0)

Chrome storage.session is cleared when an extension is reloaded, updated or disabled, or the
browser restarts. Therefore reloading the legacy extension cannot preserve its original
request cache. Keep the legacy extension enabled and retain its 18795 bridge process.
Reference: https://developer.chrome.com/docs/extensions/reference/api/storage

An offline build may replace only the copied manifest public key and display name to create
a separate observer extension ID. The canonical source key/default ID stays unchanged.
The bridge accepts an explicit --extension-id consisting of exactly 32 lowercase letters a-p.
That ID is frozen in bridge startup identity; bootstrap/WebSocket Origin must match it.
Background requires bridge identity extension_id to equal its own chrome.runtime.id, in addition
to the exact endpoint, component version, build ID and protocol. An older or different extension
cannot connect to this observer bridge. No old-extension storage is read, exported or migrated.

In inspection-only mode, connect/welcome never select or bind a tab, inject content scripts,
read/replay cached requests, or resume recovery. Both bridge and background reject ordinary
send/recover. Inspection still requires the explicit original native tab ID and exact URL;
it requires an already-loaded matching content script and never installs one implicitly.
Declarative content scripts from a separately installed extension use that extension's isolated
world. Loading the observer is an explicit deployment step requiring authorization. If the
existing original tab lacks its content script, report the mismatch and obtain authorization
before a refresh or explicit script load. Do not navigate or replace the historical tab.

This version adds no persistence, old-record import, request migration or recovery authority.
Observed candidates remain unverified. A missing trusted original nonce/fingerprint still
prevents recovery. Runtime approval for the 0.7.0 bridge does not authorize silently replacing
it or installing a different extension identity; deliver the reviewed build before that step.

## Binding diagnostic proposal (0.8.1, offline only)

Real 0.8.0 inspection failed with inspection_binding_unconfirmed. This proposal preserves that
failure and adds bounded metadata to future failures only: requested native tab ID, exact requested
URL, exact-URL matching tab count, at most four matching native IDs/loading states, and a reason
for absence, duplication, historical ID mismatch or an incomplete page. No unrelated URL, title,
active-tab flag, transcript or cache data is exported. No target is selected, rebound, injected,
refreshed or navigated. Diagnostics remain authoritative=false and cannot unlock recovery.
Bridge independently validates scope, counts, unique IDs, types and the reason before exposing
the diagnostic; malformed or cross-URL metadata fails closed. Original request identity stays fixed.

Inspection user-message normalization now uses the actual whitespace regex \\s+ instead of matching
a literal backslash followed by s. NFC and whitespace folding apply only to the original user
control message; assistant replies still use raw-exact-v1 and positive completion requirements.

This candidate exists only in an external proposal directory. Canonical repository source and
running 0.8.0 bridge/extension stay unchanged until deployment approval. No persistence, old-record
migration, send/recover, Round 4, commit or push is introduced.
