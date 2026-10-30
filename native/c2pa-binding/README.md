# Local C2PA engine

This small adapter exposes the official `c2pa` Rust SDK's Builder, Reader and crJSON operations to
the existing isolated credentials worker. Signing uses Node's standard cryptographic APIs through a
bounded callback; private keys never enter WebAssembly. Trust configuration, errors, file staging,
permissions and publication remain in the existing credentials service. No network fetch features
are enabled in the SDK.

The checked-in engine targets `wasm32-unknown-unknown` and runs on every supported Node platform.
Rebuild with Rust **1.96.0**, wasm-pack **0.14.0** and the project's supported Node runtime:

```sh
rustup target add wasm32-unknown-unknown
npm run build:c2pa
npm run build
```

`Cargo.lock` pins the dependency graph. The shipped upstream source archive is verified against its
digest; `sdk-patches.json` records exact before/after hashes for the small patch that restricts
signing and timestamp trust to their respective anchor purposes. The build extracts and patches a
fresh ignored SDK source tree; it does not alter the Cargo registry cache. The build uses
`--locked`, remaps local paths, and caps linear memory at 1 GiB. `assets/c2pa-binding/build.json`
records source and generated artifact digests; ordinary builds and installed-package checks verify
them. Rebuilding requires the compiler, while using the packaged engine does not. Generated
JavaScript and WebAssembly must be committed together with the build manifest. Two simultaneous
worker operations remain the service limit.

The adapter is AGPL-3.0-only under the repository license. The C2PA SDK and its dependencies retain
their own licenses, reproduced in [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt). The
supply-chain inventory scans the full conservative lock graph as well as npm and the executing Node
runtime; it does not infer a linked dependency list from opaque binary bytes.

Conformance and assurance remain unassessed. See
[application readiness](../../docs/conformance/readiness.md) for evidence and external gates.
