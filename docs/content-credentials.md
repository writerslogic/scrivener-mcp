# Content Credentials

The public `scrivener-mcp` server can inspect local C2PA capabilities, sign an existing asset to a
new output, and validate embedded or detached credentials. It uses the official
[C2PA Rust SDK](https://github.com/contentauth/c2pa-rs/tree/c2pa-v0.91.7), compiled to a local
WebAssembly engine. Builder, Reader and crJSON share that engine; the administrator's private key
stays in Node's standard signing APIs. The source archive, lockfile and a small, hash-checked
trust-purpose compatibility patch are shipped with the [binding](../native/c2pa-binding/README.md).
These operations work without an open Scrivener project.

Version **0.14.0 is a local, unreleased feature version**. At preparation time the published npm
release remains 0.12.0; installing that release does not provide these new tools. No C2PA
application, legal agreement, certificate purchase or publication has been submitted for this work.
Conformance is **not assessed**, no assurance level has been awarded, and no attestation methods are
implemented. A credential signature does not establish human authorship, originality or the truth of
an asset's contents.

The [application readiness assessment](conformance/readiness.md) records implemented controls,
passing local evidence and external assessment gates. The prepared
[security architecture](conformance/GPSA-scrivener-mcp.md) describes the current implementation.
Passing the format roundtrips below does not constitute program approval; **hold the application**
until the readiness acceptance conditions are satisfied.

## Tools and workflow

| Tool                           | Inputs                                                                                                                                                 | Result                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `c2pa_capabilities`            | Empty object.                                                                                                                                          | Actual SDK availability/version, declared formats and modes, compressed-manifest flags, signing-configuration presence, limits and unassessed conformance status. |
| `sign_content_credentials`     | Absolute `assetPath`; different `outputPath`; optional `mimeType`, `mode`, `title`, `sourceManifestPath`, `preserveInvalidSource` and `includeReport`. | Output, asset/sidecar source revisions, SDK version, validation and source validation. `sidecar` produces a `.c2pa` file.                                         |
| `validate_content_credentials` | Absolute `assetPath`; optional `mimeType`, detached `manifestPath`, `includeReport` and `includeCrjson`.                                               | Integrity, signer trust, source disclosures, revisions and optional genuine SDK crJSON.                                                                           |

Paths are limited to 4,096 characters and titles to 500. MIME type can be inferred from a recognized
extension. Keys, certificates, passwords, trust configuration and remote URLs are not accepted as
tool arguments. `includeReport` defaults to `false`; set it to `true` only when the full SDK report
is needed. Normalized evidence remains available without the potentially large raw report.

For a manuscript, first open the project and resolve export preflight findings. Use
`export_manuscript` for a preset, or `export_project` for another supported exporter. The export
step requires an open project; the credential steps do not. For example, after the chosen
format/mode has passed the native compatibility gate on the target platform:

Export a PDF with `export_project`:

```json
{
	"format": "pdf",
	"outputPath": "/absolute/path/manuscript.pdf"
}
```

`export_manuscript` also produces preset DOCX/EPUB files, for example
`{"action":"export","preset":"beta-reader","outputPath":"/absolute/path/beta.docx"}`. Embedded
credentials for both presets pass the installed-package MCP checks; archive preparation and
existing-credential limits are described below. `export_project` Markdown, HTML and JSON modes
return inline content; signing requires a saved file.

Create a new embedded PDF with `sign_content_credentials`:

```json
{
	"assetPath": "/absolute/path/manuscript.pdf",
	"outputPath": "/absolute/path/manuscript-signed.pdf",
	"mode": "embedded",
	"title": "Manuscript review draft"
}
```

Check that signed file with `validate_content_credentials`:

```json
{
	"assetPath": "/absolute/path/manuscript-signed.pdf"
}
```

For an evidence-backed detached format, select `sidecar`, choose a new `.c2pa` output, then validate
the original asset with that sidecar supplied as `manifestPath`. Detached MP3, FLAC, PDF and the
prepared Office/ODF/EPUB profiles are explicitly disabled because this SDK rewrites their bytes; use
their verified embedded mode instead. `sourceRevision` is the SHA-256 of the input to each
operation: detached signing/validation use the original asset, while embedded validation reads the
newly signed file.

Signing preserves the input bytes and publishes output exclusively: an existing destination is
rejected rather than overwritten. Concurrent creation of the same destination is also rejected.
Detected source changes during processing cause failure. Source assets and supplied sidecars must be
regular local files, not symbolic-link entries, UNC network locations or device namespaces.
Credential output inside a `.scriv` project must be under `.scrivener-mcp/exports`; native
manuscript files are not credential destinations. Choose a new output for a deliberate new signing
operation rather than blindly replaying a completed write.

## Administrator configuration and offline trust

Provision signing material in the server process environment through an administrator-controlled
secret mechanism. Do not put secrets in MCP requests, client conversations, logs, issue reports,
committed files or shell history.

| Environment variable                    | Purpose                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| `SCRIVENER_C2PA_CERT_PATH`              | Absolute path to the signing certificate/chain in PEM form.                                 |
| `SCRIVENER_C2PA_KEY_PATH`               | Absolute path to an **encrypted PKCS#8 PEM** private key. Unencrypted keys are rejected.    |
| `SCRIVENER_C2PA_KEY_PASSWORD`           | Private-key password, supplied as a secret. Configure all three signing variables together. |
| `SCRIVENER_C2PA_TRUST_ANCHORS_PATH`     | Optional absolute path to local PEM trust anchors used for validation.                      |
| `SCRIVENER_C2PA_TSA_TRUST_ANCHORS_PATH` | Separate local PEM trust list for timestamp authorities.                                    |

Validation does not require signing credentials. The SDK's online OCSP and remote-manifest fetching
are disabled, and this integration makes no TSA requests. Local-root validation is a statement about
the configured trust policy, not a claim of fresh online revocation information, public trust-list
membership or C2PA approval. The C2PA engine ships with the package; no C2PA native binary is
downloaded at installation. Official PEM lists may include `Subject` lines and comments; each list
is limited to 2 MiB and 256 certificates. Signing and timestamp roots remain distinct purposes.

Signing keys must use encrypted PKCS#8 with PBES2, AES-256-CBC and PBKDF2-HMAC-SHA256,
600,000–2,000,000 iterations, 16–64 byte salt and a password of at least 16 bytes. Use a randomly
generated secret from a protected secret store; length alone does not establish entropy. POSIX keys
must belong to the launching user with no group/other access. Windows ACL checks allow only the
current account, SYSTEM and Administrators; new private staging directories receive restricted ACLs.
Unsupported profiles and excessive permissions fail before signing. Local administrator compromise
and guaranteed erasure of JavaScript strings remain outside these software controls.

The administrator CLI exposes the same validator with separate lists and a supplied RFC 3339 time:

```sh
scrivener-c2pa validate --asset /absolute/asset.png --trust-list /absolute/signing.pem --tsa-trust-list /absolute/tsa.pem --time 2026-10-30T00:00:00Z --out /absolute/new-report.json
scrivener-c2pa keygen --out /absolute/private/new-key.pem
scrivener-c2pa inspect-key --key /absolute/private/new-key.pem
scrivener-c2pa reencrypt-key --key /absolute/private/old-key.pem --out /absolute/private/new-key.pem
```

Passwords come from `SCRIVENER_C2PA_KEY_PASSWORD`; migration additionally uses
`SCRIVENER_C2PA_OLD_KEY_PASSWORD`. They are never command-line arguments. Re-encryption imports a
bounded legacy PBES2/AES256 key and preserves its public identity. It does not renew a certificate.
Outputs are new files; key commands reject manuscript destinations, including symlink aliases. MCP
callers cannot override the administrator's trust lists or assessment clock.

To preserve detached source provenance, pass `sourceManifestPath` when signing the original asset.
Its revision is checked alongside the asset. Conflicting embedded history is rejected. Invalid
source credentials are rejected by default. Explicit `preserveInvalidSource: true` retains them as
an ingredient and signs a failure disclosure; later validation exposes `sourceValidationCodes` even
without raw reports. A valid new signature does not repair the source history.

| State       | Interpretation                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| `valid`     | Integrity and signer trust passed under the reported policy.                                                   |
| `untrusted` | Integrity can be valid while signer trust is not established, including absent or mismatched configured roots. |
| `invalid`   | Credential integrity/binding validation failed; inspect the normalized SDK codes.                              |
| `unsigned`  | No applicable credential was found; integrity/trust may be `not-evaluated`.                                    |

Always read `integrity`, `trust`, `trustPolicy` and `validationCodes` alongside `state`. A
self-signed development certificate is not publicly trusted. Signing does not automatically assert a
human author, add WritersProof attestations or classify optional AI-assisted work as human-created.
Official trust-list refresh procedures and formal security review remain preparation work before
program claims; local test-root validation does not establish either process.

## Coverage and evidence

The format catalog is a declared envelope of 86 MIME types, **not a list of passed native tests**.
Embedded and detached coverage are separate. Experimental entries, untested formats and unsupported
embedded modes must not become intake claims. Aliases/extensions are not additional independently
tested formats. A generic whole-file detached hash binds bytes; it does not validate the internal
structure of DOCX, EPUB, a 3D model or another file format.

The macOS arm64 / Node 24.22.1 run passes **48 original synthetic fixtures covering 48 MIME types**:
25 embedded and 37 detached roundtrips. The reproducible
[native evidence snapshot](compatibility/c2pa-0.14.0-macos-arm64.json) records exact mode coverage
and the fixture-index digest. CI retains the same report for every Linux, macOS and Windows runtime
job. Untested formats remain outside the demonstrated subset.

Unsigned DOCX, XLSX, PPTX, EPUB, ODT, ODS, ODP and ODG inputs are copied to bounded STORE ZIPs
before embedding. Every original document part remains byte-identical, except container metadata
that must describe the added credential. The credential records the original source hash and the
repackaging action; the original file never changes. The service rejects unsafe or duplicate entry
names, inconsistent directories, corruption, excessive entry counts and excessive expansion.
Existing deflated credentials remain unreadable by this SDK and fail closed; preparation must not
strip or replace them. Prepared output validation does not imply successful validation of an
unreadable original. Signed EPUBs also pass EPUBCheck 5.4.0 with Unicode, notes and empty content.

Compressed-manifest **validation has passed** a real PNG `c2cm`/`brob` fixture with trusted
validation and unchanged source bytes. Capabilities now report `generation: false` and
`validation: true`; compressed-manifest generation is not implemented.

Use `c2pa_capabilities` for the running installation and
[`scripts/check-c2pa-compatibility.mjs`](../scripts/check-c2pa-compatibility.mjs) for actual native
evidence. From a built checkout with its pinned dependencies installed, collect a JSON report with:

```sh
node scripts/check-c2pa-compatibility.mjs --output artifacts/c2pa-compatibility.json
```

Retain the report's SDK version, Node version, OS/architecture, fixture-index digest, per-format
results and failures. An intake selection needs a successful overall gate and evidence for that
specific format, operation and storage mode, including validation/tamper checks. One platform's
report does not establish coverage on every platform. Use the retained CI artifacts to assess each
platform; the table below limits selections to the demonstrated format/mode subset.

Compatibility fixtures use disposable, randomly generated development certificates and encrypted
keys. Never commit private fixture keys, use a test CA for production, or treat its trust result as
public certification. Local fixture signing does not require paid provider API calls.

The stable Node requirement is `^22.23.4 || ^24.22.1 || >=26.12.1`, with N-API 10 or newer. The
[binding build prerequisites](../native/c2pa-binding/README.md) explain the patched TLS floors used
by the binary installer and JavaScript fetch paths. Acceptance of a later stable major does not
substitute for platform compatibility evidence. Service limits are **128 MiB source assets**, **8
MiB detached manifests/reports**, a **30-second native-operation timeout**, and **two concurrent
operations**. Busy operations are rejected for a later explicit retry. Native parsing/signing runs
in isolated child processes; failures do not authorize overwriting an existing output.

## Intake preparation: the 30 questions

The rows follow the supplied questionnaire order. This is preparation, not a submitted application
or a grant of status. Reconcile final answers with the current program form and passing evidence.
Request **both Generator Product and Validator Product** roles for the implemented functions; the
program handles a separate legal agreement process for each requested role. See the
[C2PA Conformance Program](https://github.com/c2pa-org/conformance-public/blob/main/docs/v0.2/C2PA%20Conformance%20Program.md).

| #   | Intake question                                   | Requested target or intended answer                                                                                                          | Evidence, limitations or granted status                                                                                                                                                |
| --- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Compressed manifests                              | Validation: supported by the demonstrated fixture. Generation: not implemented.                                                              | Real `c2cm`/`brob` PNG validation passed with trusted status and unchanged source; no generation claim.                                                                                |
| 2   | Product type                                      | Request both Generator Product and Validator Product.                                                                                        | Functions are implemented locally; neither role has been approved. Each role has its own agreement process.                                                                            |
| 3   | Web address                                       | https://writerslogic.com/scrivener-mcp/                                                                                                      | Source: https://github.com/writerslogic/scrivener-mcp.                                                                                                                                 |
| 4   | Implementation class                              | Edge Class.                                                                                                                                  | Assets, claims and signatures are processed on the local endpoint; no formal classification granted.                                                                                   |
| 5   | Category                                          | None of the above, as selected for this public server integration; confirm classification with the administrator.                            | Ask the program to confirm any non-generative classification.                                                                                                                          |
| 6   | Common name (CN)                                  | `scrivener-mcp`                                                                                                                              | Confirmed product identity; certificate issuance is separate.                                                                                                                          |
| 7   | Organization (O)                                  | WritersLogic, Inc.                                                                                                                           | Confirmed legal organization.                                                                                                                                                          |
| 8   | Country (C)                                       | US                                                                                                                                           | Confirmed legal country.                                                                                                                                                               |
| 9   | Organizational unit (OU)                          | Leave blank.                                                                                                                                 | No OU supplied.                                                                                                                                                                        |
| 10  | Minimum software version                          | 0.14.0, intended first feature version.                                                                                                      | Full feature version is local prerelease work, not assessed or published; npm remains 0.12.0. Node runtime floors are documented separately above.                                     |
| 11  | Max Assurance Level                               | Target AL1 evaluation.                                                                                                                       | No AL awarded: current `maxAssuranceLevel` is null and conformance is `not-assessed`.                                                                                                  |
| 12  | Attestation methods                               | None implemented.                                                                                                                            | Empty methods list; no borrowed WritersProof/App Attest evidence.                                                                                                                      |
| 13  | Generate images                                   | Yes, attach credentials to existing images.                                                                                                  | Nine of the supplied image MIME options pass embedded and detached roundtrips.                                                                                                         |
| 14  | Image generation MIME types                       | `image/jpeg`, `image/png`, `image/svg+xml`, `image/gif`, `image/tiff`, `image/webp`, `image/heic`, `image/heif`, `image/avif`.               | Embedded and detached. Leave JXL, DNG, sequences and generic TIFF/RIFF categories unselected without further evidence.                                                                 |
| 15  | Video generation MIME types                       | `video/x-msvideo`, `video/mp4`, `video/quicktime`.                                                                                           | Embedded and detached completed files. Generic BMFF/RIFF and streaming profiles are not demonstrated.                                                                                  |
| 16  | Audio generation MIME types                       | `audio/flac`, `audio/mpeg`, `audio/wav`, `audio/mp4`, `audio/aac`.                                                                           | FLAC/MP3: embedded only; WAV/MP4: both; AAC: detached only. No MPA or generic RIFF claim.                                                                                              |
| 17  | Document generation MIME types                    | PDF, EPUB, DOCX, XLSX, PPTX, PPSX, ODT, ODS, ODP, ODG.                                                                                       | All embedded except PPSX, which uses a detached sidecar. Office/ODF/EPUB preparation is disclosed above. Full MIME values appear in the evidence report. No OXPS or generic ZIP claim. |
| 18  | Text generation MIME types                        | `text/html`, `text/csv`, `text/tab-separated-values`, `text/plain`, `text/markdown`, `application/xml`, `text/xml`, `application/xhtml+xml`. | Detached only; `text/xml` is a tested input alias normalized to `application/xml`. Whole-file binding does not validate text meaning or schema.                                        |
| 19  | Generate OTF fonts                                | Leave `font/otf` unselected.                                                                                                                 | OTF has no redistributable passing fixture. Separate TTF/WOFF detached tests pass but are not the supplied OTF checkbox.                                                               |
| 20  | ML-model generation types                         | None of the named ML-model types are claimed.                                                                                                | The tested GLTF/GLB/OBJ/STL assets are 3D models, not machine-learning models. Explicit generic-file sidecars do not establish named ML coverage.                                      |
| 21  | Validate images                                   | Select the same nine MIME types in row 14.                                                                                                   | Each has actual embedded/detached validation evidence; compressed-manifest PNG validation also passes.                                                                                 |
| 22  | Validate videos                                   | `video/x-msvideo`, `video/mp4`, `video/quicktime`.                                                                                           | Embedded/detached completed-file validation; no generic BMFF/RIFF, live or per-segment claim.                                                                                          |
| 23  | Validate audio                                    | `audio/flac`, `audio/mpeg`, `audio/wav`, `audio/mp4`, `audio/aac`.                                                                           | Same mode restrictions as row 16, verified independently after signing.                                                                                                                |
| 24  | Validate documents                                | PDF, EPUB, DOCX, XLSX, PPTX, PPSX, ODT, ODS, ODP, ODG.                                                                                       | Same modes as row 17; prepared archive parts remain intact. Unreadable pre-existing DEFLATE credentials fail closed rather than becoming valid through repackaging.                    |
| 25  | Validate text                                     | Select the types in row 18.                                                                                                                  | Detached binding/signature verification and altered-asset rejection pass; this does not check a text schema or factual correctness.                                                    |
| 26  | Validate fonts                                    | Leave `font/otf` unselected.                                                                                                                 | Only `font/ttf` and `font/woff` detached credentials have passing fixture evidence.                                                                                                    |
| 27  | Validate ML models                                | None of the named ML-model types are claimed.                                                                                                | No ML-specific fixture or native model interpretation is implemented.                                                                                                                  |
| 28  | Live streams                                      | Not implemented/exposed by these tools.                                                                                                      | No live-stream generation or validation claim.                                                                                                                                         |
| 29  | fMP4 per segment / verifiable segment information | Not implemented/exposed by these tools.                                                                                                      | Ordinary MP4 file results do not establish per-segment generation, validation or verifiable-segment-information support.                                                               |
| 30  | CMAF per segment / verifiable segment information | Not implemented/exposed by these tools.                                                                                                      | No CMAF segment-generation, validation or verifiable-segment-information claim.                                                                                                        |

The [program overview](https://c2pa.org/conformance/),
[Generator Product Security Requirements](https://github.com/c2pa-org/conformance-public/blob/main/docs/v0.2/C2PA%20Generator%20Product%20Security%20Requirements.md)
and
[Certificate Policy](https://github.com/c2pa-org/conformance-public/blob/main/docs/v0.2/C2PA%20Certificate%20Policy.md)
govern assessment and certificate eligibility. AL1 and Edge targets do not bypass that review.
Before submission, resolve the [readiness findings](conformance/readiness.md), regenerate the
source-matched evidence, confirm contacts and product-category interpretation, and have the
applicant review the applicable role agreements.
