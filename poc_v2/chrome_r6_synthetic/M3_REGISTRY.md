# M3 reviewable draft

Two immutable canonical profiles own all synthetic mission records. Initial HEAD
must match the original expected commit; checkpoint progress is audited separately
and never rewrites reply/retry identity. A single OS writer lock protects the
private sealed journal. Restore reconstructs state only and calls no Git, browser
or send operation. Exactly one mission is active; global request/control IDs are
unique. Terminal history remains preserved when switching to the other profile.

Recovery returns a finite decision, not an operation. An exact sanitized Fresh
observation permits observe-only handling; a separately persisted retry permission
can yield one directive after retry_started is durably appended. Actual sends and
observations still pass existing Fresh auth/component/native-target/reply gates.
Completed replies/receipts block retry. Unknown or changed authority safely blocks.

This synthetic draft is not production acceptance. Independent review must inspect
full event/replay schemas, OS locking, path canonicalization, checkpoint lineage,
retry lifetime and actual two-worktree Chrome evidence. Hashes are not signatures;
power-loss repair is not guaranteed. Multi-repository/OS-reboot behavior is unmeasured.

The independent draft review found a retry-slot lifetime defect. An authorization
now occupies the derived retry slot even after it is claimed. It is consumed only
when the claimed next attempt is successfully bound; only a subsequent failure of
that latest bound attempt can authorize another ticket. Every grant/claim/bind
remains in immutable events. Replay enforces the same invariant, including fully
recomputed hash/head tampering. Original request/control/commit identities remain
unchanged through every directive. This correction awaits final independent review.

A further independent review required a total fail-closed recovery input boundary.
Non-dict or malformed identity/snapshot/observation now returns exactly SAFE_BLOCK.
Only a valid string mission_id identifying an active stored mission can attribute
one canonical blocking audit event; unhashable or unattributable input leaves all
journal bytes unchanged. No observer/retry/send action is invoked by this path.

M3 action receipts additionally require action_id to be a lowercase 64-hex SHA-256
string. API and replay use the same bounded invariant before mutation. Invalid
types, length, case and non-hex values fail closed even with recomputed journal
hashes; valid receipt replay remains idempotent. M1 and M2 contracts are unchanged.
