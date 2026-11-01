# Local C2PA engine

This small adapter exposes the official `c2pa` Rust SDK's Builder, Reader and crJSON operations to
the existing isolated credentials worker. Signing uses Node's standard cryptographic APIs through a
bounded callback; private keys never enter WebAssembly. Trust configuration, errors, file staging,
permissions and publication remain in the existing credentials service. No network fetch features
are enabled in the SDK.

The checked-in engine targets `wasm32-unknown-unknown` and runs on every supported Node platform.
The reference build uses **Ubuntu 24.04 x64**, Rust/Cargo **1.96.0**, wasm-pack **0.14.0** and the
project's supported Node runtime. `Cargo.lock` selects wasm-bindgen **0.2.129**; the Linux release
tool records revision `165586f85` in the WASM producers section. Use the reference environment for
byte-identical release assets; matching bytes across other build hosts are unverified.

```sh
export RUSTUP_TOOLCHAIN=1.96.0
rustup toolchain install 1.96.0 --profile minimal --target wasm32-unknown-unknown
cargo install wasm-pack --version 0.14.0 --locked
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

CI rebuilds from a clean checkout and requires every generated file to match the committed assets.
It retains the compiler/Cargo metadata, source and artifact manifests, generated files and diff. A
mismatch fails release verification and triggers a second clean build for diagnostic comparison.

The adapter is AGPL-3.0-only under the repository license. The C2PA SDK and its dependencies retain
their own licenses, reproduced in [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt). The
supply-chain inventory scans the full conservative lock graph as well as npm and the executing Node
runtime; it does not infer a linked dependency list from opaque binary bytes.

Conformance and assurance remain unassessed. See
[Content Credentials](../../docs/content-credentials.md) for capabilities and verification limits.
