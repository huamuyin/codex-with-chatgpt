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
