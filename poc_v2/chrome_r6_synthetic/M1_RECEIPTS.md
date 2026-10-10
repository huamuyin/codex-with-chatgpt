# M1 reviewable draft

ReceiptLedger stores synthetic completed-review authority and finite action receipts
in an explicit private directory outside Git. It does not execute instructions.
The caller independently verifies GitHub resource provenance before acceptance.
Only ATTEMPT_ID is excluded from the logical semantic review hash. A failed attempt
can later complete; its original failure events stay in the journal. A canonical
event reserves the action atomically; claiming appends action_started before
yielding its instruction. A crash after that event may leave an unexecuted action
blocked. No second grant or guaranteed power-loss recovery is claimed.

The journal is UTF-8 canonical JSON, hash chained and sealed. Hashes detect damage;
they are not signatures against a local attacker. Interrupted event/head writes
fail closed; they are never silently reset. Failed/blocked action outcomes need
explicit owner policy rather than an automatic second business execution.

The independent draft review required full semantic replay validation. Canonical
events now reconstruct and validate the complete attempt-specific response against
stored authority, require exact schemas and require instruction equality. Duplicate
attempt booleans and invalid receipt contracts are rejected during replay, even
with recomputed hashes and a matching head. The corrected candidate awaits final
independent review. Open non-production obligations include cross-process writer ownership, durable write
crash boundaries, effective path and reparse-point checks, and broader lifecycle
integration. The initial concurrency proof uses a single ledger instance with
multiple threads. It does not attest multiple independent writer processes.
