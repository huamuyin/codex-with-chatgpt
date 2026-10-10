# Chrome R6 isolated development missions

This synthetic project contains no product or financial data. Three independent
development missions exercise the Chrome control loop: exact GitHub PLAN,
reviewable draft implementation, independent review and correction, final review.
The reviewer chooses the actual finite plan and reviews immutable commits.

## M1: Canonical review action receipts

Build a small Python ledger that binds mission/workspace/request/control/commit
and records a canonical completed review plus its finite Codex action receipt.
Duplicate and late reviews must never schedule a second business action.
Conflicting identity or changed canonical reply must fail closed. Preserve failed
attempt events; timeout must not erase a later valid completed review. Export and
restore deterministic state. Output directories must be explicit and outside Git.
Tests use only synthetic identities and a caller-provided private test directory.

## M2: Bounded incremental structured reply reader

Build a strict UTF-8 incremental JSONL reader for synthetic large framed review
artifacts. Handle chunk boundaries through multibyte characters and CRLF without
semantic rewriting; bound individual record bytes and total record count.
Reject unfinished final records, invalid UTF-8, duplicate keys, nonfinite numbers
and lone Unicode surrogates. Preserve raw input hashes on failure. Include long
Chinese/emoji input, empty input, truncation and excessive-size tests. No API.

## M3: Workspace and lifecycle recovery authority

Build a small profile/mission registry for two explicitly authorized synthetic Git
workspaces of this repository. Bind canonical workspace path, remote, branch,
mission ID, original expected commit and request/control identity. Deny unknown or
changed bindings, duplicate targets and cross-profile replies. Derive a finite
recovery decision (observe existing attempt, explicit retry or safe block) after
process/page lifecycle failure. Restore must never send implicitly. Preserve audit
history and completed action receipts. Use mocks plus the owned Chrome boundary.

## Development protocol

Initial implementations are explicitly reviewable drafts with documented deferred
conformance coverage, never represented as accepted production code. Every actual
defect or missing required contract discovered by the reviewer must be corrected
and reviewed again. No verdict is predetermined. PLAN and reviews must independently
read the exact supplied GitHub refs through the official connector. Source files,
tests and sanitized authority are in Git; runtime, raw replies and evidence remain
under the registered private data root. No Edge, family-fund, main merge or installer.
