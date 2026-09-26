# Security Model

## Trust boundaries

1. **Workspace root** is the smallest authorization boundary. One bridge serves
   exactly one workspace; every token is bound to `workspace_id`; a token for
   project A returns 403 on project B's bridge.
2. **Workspace content is untrusted.** README, comments, diffs may contain
   prompt injection. Every MCP tool description carries an explicit warning and
   tools never grant capabilities based on file content.
3. **The model never sees long-lived credentials.** Computer Use only ever
   handles the one-time pairing code. Access/refresh tokens travel only inside
   the OAuth redirect/token endpoints between ChatGPT's client and the bridge.

## Threat model → mitigations

| Threat | Mitigation |
| --- | --- |
| MCP URL leaks | URL alone is useless: every `/mcp` request requires a valid bearer token (401 without, 403 wrong workspace) |
| Pairing code brute force | 8 chars from a 31-char CSPRNG alphabet (~40 bits), 5 attempts per session, per-IP rate limit (10/min), 5-minute TTL, one-time use, session destroyed on limit |
| OAuth CSRF | `state` round-tripped verbatim; authorization requests are server-side records keyed by random ids |
| Code interception | PKCE S256 mandatory (plain rejected); authorization codes are one-time, 5-minute TTL, bound to client + redirect URI |
| Token theft | Opaque high-entropy tokens; stored only as SHA-256 hashes; access tokens live 1 h; refresh tokens rotate on every use (replay of the old one fails); revocation endpoint + `c2c unpair` |
| Workspace traversal | `realpath` canonicalization of the deepest existing ancestor; containment check against the canonical root; case-insensitive comparison on macOS/Windows; rejects `..`, absolute escapes, backslash tricks, null bytes |
| Symlink escape | Canonicalization resolves symlinks before the containment check (file and directory symlinks both covered by tests) |
| Sensitive files | Deny-by-default patterns (.env*, keys, SSH, cloud creds, keychains…) enforced at resolve time — reads, listings, and search all pass through the same gate; `git diff` adds pathspec excludes; `.env.example` allowed |
| Oversized file / diff DoS | read_file caps lines and bytes per response; git_diff paginates by byte offset with hard caps; search caps matches and file sizes |
| Tunnel exposure | Bridge binds 127.0.0.1 only (refuses 0.0.0.0); the only public surface is HTTPS via the tunnel, protected by OAuth; `/health` reveals only a salted workspace hash |
| Admin API abuse | Loopback-only + random admin token (0600 runtime file) + requests with proxy headers (`cf-connecting-ip`, `x-forwarded-for`) rejected; unauthenticated probes get 404 |
| Log credential leakage | Logger redacts token prefixes, bearer headers, token-like parameters, and pairing-code-shaped strings before writing |
| Execution output leak | Codex may nominate test/build/lint logs; a local sanitizer redacts tokens, pairing-code-shaped strings and home paths, truncates size, and refuses private-key blocks entirely. Restricted items are listed without a body. ChatGPT still cannot run commands. |
| Checkpoint / resume dump | Session checkpoints store short protocol fields only (capped). Resume uses the existing chat or HANDOFF — no new protocol state, no log paste, no re-pairing. |

## Token & scope design

Read scopes: `workspace.read`, `workspace.search`, `git.read`, `execution.read`,
`offline_access`. Governed mutation scopes are `workspace.write`, `git.write`,
and `git.push`. Tools enforce each scope server-side (`INSUFFICIENT_SCOPE`).
The default connector request is read-only. The authorization page requires an
unchecked-by-default explicit confirmation when a request includes any mutation
scope. Legacy read-only tokens stay read-only; refresh rotation copies existing
scopes and never upgrades them. A separately consented mutation token retains
exactly those scopes on refresh rotation, with no additions. An existing
connector/client registration can request consent again; its
identity and workspace binding do not need to be recreated. Access tokens: 1
hour. Refresh tokens: 30 days, rotated. All tokens bound to `workspace_id` and
`client_id`.

## Storage

State lives under the OS-convention app dir
(`~/Library/Application Support/codex-with-chatgpt` on macOS), directories 0700,
files 0600. Named-hostname preference and tunnel metadata live there too
(`tunnels/<workspaceId>.json`) — never in the project. Only SHA-256 hashes of
tokens are persisted — a stolen state file does not yield usable bearer tokens.

**V1 limitation**: client registrations and token hashes are file-based rather
than OS-keychain-based. Raw tokens are never written anywhere. Keychain
integration is a V2 item.

## Governed mutation boundary (0.2 candidate)

The candidate adds `write_file`, `apply_patch`, structured Git inspection,
branch/worktree creation, explicit-path commits, origin-only fast-forward pushes,
fast-forward-only merges, and `git_remote_refs` for live origin branch reads
without fetch or tracking-ref updates. File replacement requires the exact
previous SHA-256; patches require a SHA-256 preimage (or explicit absence) for
every target; commits require a SHA-256 identity for each and only each committed
path; and worktrees are created as a new branch directly from the exact reviewed
commit SHA. Pushes require the exact local SHA, the exact live remote SHA (or
expected absence), and a descendant/fast-forward proof. They use an internally
generated exact ref lease at the push boundary plus exact live readback. This is
an **EXACT LEASED FAST_FORWARD_PUSH**: the lease closes the expected-ref race but
does not authorize a non-fast-forward update or history rewriting. Callers cannot
supply force, lease, or refspec arguments. It exposes no arbitrary shell, delete, reset,
rebase, history rewrite, branch/worktree deletion, tag mutation, or package
installation tool. Writes require relative paths under the connected workspace
or a worktree created and registered by this bridge session. Central path checks
reject traversal, absolute/drive/UNC paths, Git internals, sensitive paths, and
symlink/junction traversal. File and patch writes use same-directory atomic
replacement; multi-file patches validate every target before writing and use
best-effort internal rollback if an I/O error occurs. Git commits require a
clean index and explicit regular-file paths; each staged index blob is checked
against its authorized SHA-256 immediately before plain `git commit` consumes
that verified index snapshot. A later worktree edit cannot replace the staged
bytes in the commit. Pushes are checked for ancestry and read back from `origin`.

This is a candidate capability, not a claim that deployed instances have these
tools. Deployment requires a later reviewed release and explicit OAuth consent.
