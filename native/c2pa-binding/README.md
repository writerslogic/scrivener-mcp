# Local C2PA engine

This small adapter exposes the official `c2pa` Rust SDK's Builder, Reader and crJSON operations to
the existing isolated credentials worker. Signing uses Node's standard cryptographic APIs through a
bounded callback; private keys never enter WebAssembly. Trust configuration, errors, file staging,
permissions and publication remain in the existing credentials service. No network fetch features
are enabled in the SDK.

The source-built engine targets `wasm32-unknown-unknown` and runs on every supported Node platform.
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

`Cargo.lock` pins the dependency graph. The shipped C2PA and `static-regular-grammar` source archives
are verified against their digests. `sdk-patches.json` records exact before/after hashes for the
patch that restricts signing and timestamp trust to their respective anchor purposes.
`grammar-patches.json` replaces the unmaintained `proc-macro-error` emitter with the grammar crate's
existing `syn::Error`, preserving diagnostic messages and source spans. The build extracts and
patches fresh ignored source trees; it does not alter the Cargo registry cache. Use
`node scripts/build-c2pa-binding.mjs --prepare-only` before inspecting or updating the Cargo graph.
The build uses
`--locked`, remaps local paths, and caps linear memory at 1 GiB. `assets/c2pa-binding/build.json`
records source and generated artifact digests; ordinary builds and installed-package checks verify
them. Rebuilding requires the compiler, while using the packaged engine does not. Generated
JavaScript declarations and the build manifest are tracked; WebAssembly is generated locally or
passed between CI jobs as a verified artifact and included in published packages. Do not commit it. Two simultaneous
worker operations remain the service limit.

The committed byte-for-byte reference is built on Ubuntu 24.04 (x86_64), with Rust toolchain
`1.96.0` and wasm-pack `0.14.0`. Local source builds on other hosts generate their own manifest
and may differ in bytes despite matching source inputs and compiler versions. Use the pinned
Linux environment when comparing against the committed reference.

CI rebuilds from a clean checkout and requires the generated manifest and reviewable files to match their committed references.
It retains the compiler/Cargo metadata, source and artifact manifests, generated files and diff. A
mismatch fails release verification and triggers a second clean build for diagnostic comparison.

The adapter is AGPL-3.0-only under the repository license. The C2PA SDK and its dependencies retain
their own licenses, reproduced in [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt). The
supply-chain inventory scans the full conservative lock graph as well as npm and the executing Node
runtime; it does not infer a linked dependency list from opaque binary bytes.

Conformance and assurance remain unassessed. See
[Content Credentials](../../docs/content-credentials.md) for capabilities and verification limits.
