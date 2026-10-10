# M2 reviewable draft

The standalone reader accepts bytes with explicit positive limits. LF terminates
each record, and only a CR immediately before LF is delimiter syntax. Limits count
payload bytes after optional delimiter CR removal; raw total includes all supplied
bytes and delimiters. Every supplied chunk is hashed in full before parsing, so
failure metadata covers even the unprocessed tail of that failing chunk.

Strict UTF-8/JSON decoding rejects duplicate keys, nonfinite floats including
overflow, lone surrogates and non-object records. Unicode is not normalized.
Accepted records remain internal until successful finalize. Frozen output uses
read-only mappings and tuples for recursively immutable JSON object/array views.
Failure freezes bounded metadata and prevents successful partial output or further
input mutation. No raw artifacts, credentials, browser or API access are involved.

This draft is not acceptance. Independent review must check pending CR boundary
and allocation behavior, failure precedence, sticky metadata, adversarial chunk
partitions, deep immutability and syntax/depth limits. Hashes are not signatures.
