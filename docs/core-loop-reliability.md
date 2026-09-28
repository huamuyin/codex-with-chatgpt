# Core loop reliability and image evidence

The MCP endpoint is stateless: each POST creates its own server/transport. Tool
schemas are supplied by `tools/list`. All 21 release 0.2.0 tools are registered
independently of token scopes; handlers enforce scopes when called. A read-only
token does not reduce the registry to nine tools. Reauthorizing is required only
when deliberately granting additional scopes, not to read the registry.

A new MCP connection negotiates the current deployed registry. An existing
ChatGPT conversation can retain a previously injected tool surface. The bridge
does not control that conversation manifest or provide a cache-bypass endpoint.
Compare fresh `tools/list` responses before attributing an old visible manifest
to deployment, permissions, or the client. No client cache internals are assumed.
The launcher refuses a built version that differs from `package.json`; matching
versions alone do not prove source/build identity. Deploy from a validated build.

## Named tunnel health

Process presence, registered connections, and public application reachability
are separate facts. Connection termination clears its registration; concurrent
starts share one pending operation. Doctor accepts public health only with exact
service, status, and workspace identity, including after a repair attempt. It
does not interpret a cached URL as recovery. Protocol selection is deployment
specific (`C2C_TUNNEL_PROTOCOL`); no global HTTP/2 default is imposed.

## Execution evidence transactions

Output readers and writers share a bounded cross-process transaction lock.
Bodies are immutable; index publication uses an atomic same-directory rename.
Retention runs after publication while holding the same lock. New bodies carry
SHA-256 integrity metadata; legacy bodies are checked against recorded size.
Malformed indexes fail closed instead of becoming empty stores. Missing or
changed bodies produce explicit tool errors instead of silent empty output.

A lock left by a crashed writer fails closed (`OUTPUT_STORE_BUSY` after three
seconds). An operator must confirm that no writer remains before recovering it;
the bridge never guesses from lock age. A filesystem failure may leave an
unreferenced blob, but cannot make a partial record readable. Older publisher
binaries must not write concurrently with this transaction-aware release.

## Explicit image publication

The local `record` CLI accepts `--image-file`, `--image-root`, and `--command`
together. The root is explicit publisher authorization; remote callers cannot
supply a path or URL. Only PNG/JPEG regular files within that root are accepted.
Sensitive paths, symlinks/junctions, hardlinks, network paths and URLs are denied.
Input/output are limited to 4 MiB and dimensions to 4096 by 4096. Bounded decoding
and re-encoding strip metadata. The sanitized snapshot is stored with the output.

`execution_output` keeps its existing ID-based input schema. `read` returns
sanitized text/metadata plus a standard MCP `image` content block when explicitly
published. Metadata contains MIME type, dimensions, byte count and SHA-256; it
does not contain local paths. `execution.read` is required. Later edits to the
source file do not change a published image. This is not a generic media server.

## Acceptance boundaries

Unit tests are separate from actual public connector acceptance. A synthetic
three-round internal Chat review loop and a fresh visual question must be recorded
as end-to-end evidence. Image delivery is proven by actual visual answers against
ground truth withheld from the reviewer, not by a path or textual description.
No real project drawings are needed for this validation.
