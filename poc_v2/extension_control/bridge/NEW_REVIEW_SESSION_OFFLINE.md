# R6 new review session entry — offline candidate, not deployed

This is a bounded follow-up to M3. It is not a fourth development Mission.
Base: `27faf1cabddbd2259935517457daecafbbe97e83`.
The original accepted M3 request/Control/Attempt, commit and completed reply remain unchanged.
M1/M2 are not rerun. This candidate has no independent acceptance yet.

## Why an entry is necessary

The accepted Fresh code has no `chrome.tabs.create` call. Its
`prepare_future_thread` requires a completed old request and only opens that old
conversation URL. It cannot establish an independently registered new review.
The present unproven tab must not be substituted for a newly created tab.

## Explicit authority and native creation

After independent review and explicit deployment authorization only, a bridge
can be launched with `--new-review-commit <frozen-40-hex>` and
`--new-review-iteration <positive-integer>` in a newly initialized private
`CHROME_R6_M3_FINAL_<unique-suffix>` namespace. The original R6 namespace cannot
enable this entry. Neither startup nor checkpoint restore creates or sends.

The existing token-authenticated `/maintenance` accepts only
`{"action":"create_review_session","control_token":"<ephemeral>"}`.
It requires an authenticated extension, fresh matching background/manifest
identity, the new setup capability, an empty journal and no active request.
Host/Origin/bootstrap/WebSocket/token authentication remains the existing code.
The token is not in any setup record, mirror or evidence. An extra target URL or
native ID is rejected: the caller cannot supply a page to adopt.

Before dispatch, an exclusive fsynced `review-open-intent.json` records a new
setup ID/nonce, namespace, review commit/iteration, root URL and bridge epoch.
The extension consumes a namespace latch synchronously and saves a session
storage latch before calling `chrome.tabs.create` once with the fixed ordinary
ChatGPT root URL and `active:false`. It never selects the active page, modifies
an old page, navigates it, deletes it or sends a message during setup.

Returned native ID must not be in the pre-creation ChatGPT-tab snapshot. Actual
`tabs.get` plus post-creation `tabs.query` must confirm this new ID and a unique
root candidate. Only literal `loading` or `complete` is accepted, with empty or
exact root pending URL; complete requires committed root URL and no pending URL.
An existing root or a duplicate that appears during creation blocks confirmation.
The created page is left in place on failure; it is not silently recreated.

The bridge verifies the exact grant/nonce/epoch and native proof before writing
the separate exclusive `review-native-binding.json`, linked to the canonical
intent hash. Missing, truncated, altered or conflicting records block reopening.
Exact duplicate ACK is idempotent; changed or late ACK after a resolved command
does not replace authority. Intent-without-binding is consumed and cannot create
again, including after bridge/worker restart. No automatic command retransmit
was added to `maintenance_handoff`.

## Ready, request and reply isolation

The core component version remains 0.9.8/protocol 3. A separate setup capability
`c2c-v2-r6-new-review-session-offline-1` is required on both ends. An old worker
with the same core version cannot create or report scoped readiness without this
capability and the exact new binding proof. Full source/build file hashes are
part of offline evidence; version strings alone are not binary attestation.

A scoped worker only selects the newly created native ID. It rejects historic
checkpoints and out-of-scope requests. The bridge requires exact setup proof,
native ID and the existing content/background/manifest/protocol checks before
ready. A creation ACK is not readiness, logged-in status, model selection,
successful sending or a completed review.

The only new logical review has task `C2C_V2_CHROME_R6_M3`, repository
`huamuyin/codex-with-chatgpt`, branch `codex/c2c-v2-chrome-r6`, and frozen startup
commit/iteration. The existing Fresh mechanism generates new Request/Control
identity and nonce, persists before dispatch, and confirms root-to-real-thread
binding through the newly pinned native tab. Original requests are not imported.
The established semantic reply matching/completion gates remain unchanged.

This bounded review namespace allows one initial send only. `/retry` is rejected
regardless of timeout; identity-preserving `/review` polling sends nothing. It
does not change the existing at-least-once policy for ordinary Fresh namespaces.
An uncertain first send requires observation or a new Main Chat decision, not an
automatic resend or a second logical review. Reopen validates one logical
request/attempt, frozen scope and native ID, and never dispatches.

## Review/deployment gates and limits

Independent Main Chat review of this exact candidate is required **before** any
real component replacement or new-page creation. The offline build is separate
from the installed Fresh directory. It includes both added modules; copying the
old nine-file build list alone is invalid. The manifest, permissions, network
endpoints and legacy recovery policy are unchanged.

After approved setup, the real controller must verify ordinary subscription
Chat mode and intended high reasoning through evidence from its newly owned
page before sending. This offline work neither selects a model nor attests a
real page/login/model. It cannot claim the requested maintenance review happened.
The eventual reviewer must separately read both maintenance commits `b180588...`
and `27faf1c...`, all five files and full differences; the old fix2 PASS cannot
cover them. Any accepted entry candidate must also be included as an exact ref.

The setup files assume private directory ownership, like the existing journal;
hashes are integrity seals, not adversarial signatures. Partial writes and lost
ACKs intentionally fail closed. Full browser/OS restart, model/login expiry,
cross-repository work and long unattended continuity remain unmeasured.

Chrome API reference:
[tabs.create/get/query and native status/pendingUrl](https://developer.chrome.com/docs/extensions/reference/api/tabs).
Only synthetic mocks were used here; no actual navigation or browser calls.
