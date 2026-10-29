# Compatibility and upgrade policy

Compatibility is maintained through real protocol tests, explicit state contracts, and tested
runtime upgrades. New versions are promoted after verification.

## Runtime and dependency changes

The package engine requirement, setup runtime floor and CI minimum must agree. After building,
`node scripts/check-runtime-policy.mjs` checks that agreement, the running stable Node version,
Node-API capability, bootstrap floors and coverage of Linux, macOS and Windows. Setup rejects
malformed, prerelease and inconsistent runtime versions, compares every version component, and
prefers a private runtime before the newest available stable fallback. A usable running runtime
remains preferred.

The supported range is **`^22.23.4 || ^24.22.1 || >=26.12.1`**. The pinned CAI native SDK's binary
installer and JavaScript fetch paths use Node's TLS stack independently of the Rust SDK, so the
[official patched release floors](https://opensource.contentauthenticity.org/docs/node-landing/)
apply even though credential operations disable remote fetching. Node 23/25 and lower patches on
22/24/26 are excluded. Later stable majors are permitted by the range; actual native/platform
compatibility still needs evidence. Upgrade an older installation to Node 24.22.1 or a newer Node 24
patch.

SQLite 13 additionally requires Node-API 10. Its earlier ABI-only floor of 22.14.0/23.6.0 is not the
current security policy. The SQLite native binding ships with the package and is verified through an
actual in-memory query under the bundled Node, rather than downloaded through a private
install-script path. Existing SQLite databases retain their schema; checked-in v12 fixtures verify
normal closure, interrupted WAL recovery and Unicode state. See the
[Node-API version matrix](https://nodejs.org/download/release/v22.23.0/docs/api/n-api.html#node-api-version-matrix)
and [SQLite driver release](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0).

New bundles download the latest patch of the tested Node 24 line from an immutable version URL and
verify its official SHA-256. Downloads use finite timeouts and temporary files; incomplete or
corrupt cache entries are replaced. This follows
[Node's maintained release lines](https://nodejs.org/en/about/previous-releases) and
[security release guidance](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases).
Existing system runtimes are not upgraded silently.

CI retains the six macOS/Linux/Windows minimum/Node 24 jobs and adds Linux latest Node 22 and Node
26 coverage. The same matrix runs weekly. The stable `Release verification` check fails if any
matrix job fails, is cancelled or is skipped; branch protection can depend on this name as runtime
versions change. Keep strict updates, all supported platforms and the full release gate when
updating the matrix. The stable check is required on main.

Dependabot still groups minor/patch changes. Major upgrades are now surfaced individually for
review. They do not merge automatically. Preserve the dependency security overrides and installed
consumer audit when evaluating upgrades; see `vendor/deepmerge/README.md` for the temporary patch.

Anthropic SDK 1 uses API version `2026-10-21` and bearer authentication. Claude requests omit
removed sampling controls; `ChatOptions.temperature` still applies to OpenAI, OpenRouter and MCP
sampling. Custom gateways must accept the current provider headers. Provider requests have a
60-second default deadline, including response bodies; `AIClientOptions.timeoutMs` accepts integer
values from 1 through 120,000 milliseconds. SDK retries are disabled, so ambiguous connection/body
timeouts propagate without automatic replay. Explicit account/service errors retain the existing
cross-provider fallback. The deadline applies separately to each provider request.

Offline tests exercise the real SDK implementations with local response fixtures. Live suites
additionally require `SCRIVENER_RUN_LIVE_AI_TESTS=1` and credentials; do not enable them without
separate authorization for paid validation. Ordinary development and CI do not call paid providers.

`node scripts/check-redis-backend.mjs` starts its own password-protected Redis instance and tests
the real queue/cache driver, retries, events, active-removal rejection and cleanup. Redis must be
installed locally; the verifier does not use an existing instance. Add
`--legacy-root /absolute/checkout-with-bullmq5` to verify ordinary v5 job-state transfer with the
actual old producer. Legacy repeatable-job metadata needs the upstream v5 migration before v6; this
server does not create repeatable jobs. Linux Node 24 CI runs the current-backend check.

Local-only demo and diagnostic sessions skip automatic Redis discovery and use embedded queues, so
they do not consume queued work from another installation.

The `credentials` skill exposes `c2pa_capabilities`, `sign_content_credentials` and
`validate_content_credentials` on demand without an open project. Native signing and validation are
isolated and offline; their reports distinguish integrity from administrator-configured signer
trust. Compressed-manifest validation is implemented; generation is not. PDF, MP3, FLAC, DOCX and
EPUB use embedded mode with the pinned SDK, with their detached sidecars explicitly unsupported.
Unsigned DEFLATE DOCX/EPUB archives are prepared as separate STORE copies that preserve entry
payloads and record the original SHA-256 assertion; the original is unchanged and unreadable
existing credentials fail closed.

The format catalog is a declared envelope, not a passing native matrix. Preserve per-format/mode
evidence from `scripts/check-c2pa-compatibility.mjs` and rerun it after SDK/native-binary changes.
These local results do not award C2PA conformance, an assurance level or human-authorship status.
See [Content Credentials](content-credentials.md) for setup, export integration and trust limits.

## MCP protocol contract

Setup and extension verification use the installed
[MCP SDK client and stdio transport](https://ts.sdk.modelcontextprotocol.io/client), including SDK
protocol negotiation and result validation. There is no separate production JSON-RPC parser in these
entry points. Tests cover current and supported older protocol negotiation, invalid results, RPC
errors, fragmentation, pagination, cancellation and stubborn children.

A diagnostic accepts at most 64 pages, 10,000 unique tools, a 1 MiB protocol frame and
1,024-character cursors. Empty listings and duplicate tools/cursors fail. The operation deadline is
1–120,000 ms; SDK child cleanup may add up to five seconds. Stderr is bounded and redacted; partial
retained lines are withheld. Diagnostics disable provider discovery and remote model calls. Server
stdin closure runs the same resource shutdown used by termination signals.

For an SDK major migration, verify tool names and output schemas, negotiated Apps/text behavior,
setup reports, installed-package startup and the native-bundle checks before promotion. A passing
compile alone does not establish protocol compatibility.

## Persistent state and desktop integration

HMS uses the published 0.6.4 document contracts and validates native/fallback behavior through
`node scripts/check-hms-compatibility.mjs`; no separate native-package checkout is required. The
gate tests an unrelated launch directory, process restart, metadata and UTF-8 ranges, supplied
embedding vectors, replacement/deletion and cross-process ownership. The package's feature-gated
`LocalEmbedder` declaration does not establish that a published binary implements it; Scrivener does
not call it or install Transformers. A future concept-vocabulary change must update the embedding
revision, passage index version and cache path together. Preserve existing caches until their owners
stop; `flush()` does not release the native lock.

Editorial database schema changes must retain legacy records, reject unsupported future schemas, and
pass recovery/restart fixtures. Proposal revisions and source provenance remain explicit;
configuration or SDK upgrades must not bypass manuscript conflict checks.

Draftbridge remains in its private repository. Its CI builds the public server and exercises the
actual setup helper through the desktop runner in a disposable home, including cancellation of the
helper's MCP child. Schema version one accepts additive fields; unsupported versions fail clearly.
Bundling uses the npm file manifest so dashboard/sample assets and required vendor files accompany
the server. Third-party license notices are retained. No real client configuration or manuscript is
needed by these checks.

See [the implementation ledger](implementation-status.md) for measured results and
[the compatibility matrix](SCRIVENER_COMPATIBILITY.md) for native-application and host limits.
