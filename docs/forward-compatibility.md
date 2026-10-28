# Compatibility and upgrade policy

Compatibility is maintained through real protocol tests, explicit state contracts, and tested
runtime upgrades. New versions are promoted after verification.

## Runtime and dependency changes

The package engine requirement, setup runtime floor and CI minimum must agree. After building,
`node scripts/check-runtime-policy.mjs` checks that agreement, the running stable Node version and
coverage of Linux, macOS and Windows. Setup rejects malformed, prerelease and inconsistent runtime
versions, compares every version component, and prefers a private runtime before the newest
available stable fallback. A usable running runtime remains preferred.

The Node 22.13.0 floor describes API compatibility. New bundles download the latest patch of the
tested Node 24 line from an immutable version URL and verify its official SHA-256. Downloads use
finite timeouts and temporary files; incomplete or corrupt cache entries are replaced. This follows
[Node's maintained release lines](https://nodejs.org/en/about/previous-releases) and
[security release guidance](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases).
Existing system runtimes are not upgraded silently.

CI retains the six macOS/Linux/Windows minimum/Node 24 jobs and adds Linux latest Node 22 and Node
26 coverage. The same matrix runs weekly. The stable `Release verification` check fails if any
matrix job fails, is cancelled or is skipped; branch protection can depend on this name as runtime
versions change. Keep strict updates, all supported platforms and the full release gate when
updating the matrix. Configure the stable check as required after its first successful run.

Dependabot still groups minor/patch changes. Major upgrades are now surfaced individually for
review. They do not merge automatically. Preserve the dependency security overrides and installed
consumer audit when evaluating upgrades; see `vendor/deepmerge/README.md` for the temporary patch.

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
