# Content Credentials

The public `scrivener-mcp` server can inspect local C2PA capabilities, sign an existing asset to a
new output, and validate embedded or detached credentials. It uses the official
[C2PA Rust SDK](https://github.com/contentauth/c2pa-rs/tree/c2pa-v0.91.7), compiled to a local
WebAssembly engine. Builder, Reader and crJSON share that engine; the administrator's private key
stays in Node's standard signing APIs. The source archive, lockfile and a small, hash-checked
trust-purpose compatibility patch are shipped with the [binding](../native/c2pa-binding/README.md).
These operations work without an open Scrivener project.

Conformance is **not assessed**, no assurance level has been awarded, and no attestation methods are
implemented. A credential signature does not establish human authorship, originality or the truth of
an asset's contents.

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
scrivener-c2pa validate --asset /absolute/asset.png --trust-list /absolute/signing.pem --tsa-trust-list /absolute/tsa.pem --time 2026-10-30T00:00:00Z --crjson-version 2.4 --out /absolute/new-assessment.json --native-out /absolute/new-native-evidence.json
scrivener-c2pa keygen --out /absolute/private/new-key.pem
scrivener-c2pa inspect-key --key /absolute/private/new-key.pem
scrivener-c2pa reencrypt-key --key /absolute/private/old-key.pem --out /absolute/private/new-key.pem
```

Passwords come from `SCRIVENER_C2PA_KEY_PASSWORD`; migration additionally uses
`SCRIVENER_C2PA_OLD_KEY_PASSWORD`. They are never command-line arguments. Re-encryption imports a
bounded legacy PBES2/AES256 key and preserves its public identity. It does not renew a certificate.
Outputs are new files; key commands reject manuscript destinations, including symlink aliases. MCP
callers cannot override the administrator's trust lists or assessment clock.

Default validation output preserves native SDK crJSON. The explicit `--crjson-version 2.4` export
validates against the pinned, unmodified [official 2.4 schema](../assets/c2pa-crjson-2.4/README.md)
and requires both output paths. SDK 0.91.7 includes `isUpdateManifest` and `isCompressedManifest`,
which that schema forbids. The assessment projection omits those two fields and identifies Scrivener
MCP as its JSON generator. The native evidence file retains the complete inspection, including the
flags, original SDK generator, validation failures, source revision and assessment time, and records
the exact assessment bytes' SHA-256 and length. Schema validity does not change the asset's
cryptographic status or establish formal conformance.

The assessment is capped at 8 MiB; the complete native evidence file at 16 MiB + 256 KiB, including
its trailing newline. Unsupported versions, incompatible structures and excess size fail explicitly.
The native evidence file is published first. If the assessment write fails, the error identifies the
retained evidence; inspect both destinations and retry with two new paths. Existing files are never
overwritten, and a successful command requires both writes.

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
embedded modes are not verified capabilities. Aliases/extensions are not additional independently
tested formats. A generic whole-file detached hash binds bytes; it does not validate the internal
structure of DOCX, EPUB, a 3D model or another file format.

The compatibility suite covers **48 original synthetic fixtures across 48 MIME types**, with
embedded and detached cases tested separately. The matching
[CI run](https://github.com/writerslogic/scrivener-mcp/actions/workflows/ci.yml) retains a report
for every Linux, macOS and Windows runtime job. Check its commit, overall result, fixture-index
digest and per-format results; the catalog alone does not establish passing coverage.

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
results and failures. A coverage claim needs a successful overall gate and evidence for that
specific format, operation and storage mode, including validation/tamper checks. One platform's
report does not establish coverage on every platform. Use the retained CI artifacts to assess each
platform.

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


Local validation reports `trustSnapshot`: policy version 1 and the SHA-256 of the exact SDK
settings, including the separate canonical signer/TSA trust anchors. Freshness is `unknown`;
revocation uses offline evidence only. These fields do not claim official-list membership.

To adopt an official list, an administrator must obtain the signer and TSA lists from their
respective [official C2PA sources](https://opensource.contentauthenticity.org/docs/conformance/trust-lists/),
verify source provenance, and retain the upstream revision, retrieval time and file digest with
the deployment configuration. Review changed anchors before atomically replacing the configured
local files; keep the previous version for rollback. The server validates bounded PEM inputs and
never downloads updates, falls back to public Web PKI roots, or treats list retrieval time as a
fresh revocation check. Formal conformance remains unassessed. Generator metadata declares
C2PA 2.4.0; current C2PA 2.5 is not claimed merely because it is published.


`sign_content_credentials.reviewedPublication` links a completed `beta-reader-draft` workflow to its exact export SHA-256, saved source revisions and committed review application IDs. Apply reviewed changes first, then start the export workflow; every scoped document needs one application whose committed revision matches the exported revision. Supply `workflowId`, `reviewApplicationIds`, and optionally `machineAssistance: "declared-assistance"` (default `"unknown"`). Local analysis is disclosed separately; absence of recorded AI use never establishes human authorship.

This mode requires the export as `assetPath`, embedded credentials, and a distinct safe `.docx` filename directly in the open project's `.scrivener-mcp/exports` directory. The existing publication journal retains prepared signed bytes for recovery and exact replay; an interrupted prepared artifact describes the approved snapshot at preparation, not a later manuscript revision. Stale revisions, uncommitted reviews and altered exports are rejected. The signed custom assertion `com.writerslogic.publication` contains only identifiers, hashes and assistance declarations. Review text, titles, author identity, file paths and credentials remain private unless separately included in the asset or explicit signing title. Signing uses the existing credential history and trust rules; it establishes neither factual truth, copyright ownership nor human authorship.
