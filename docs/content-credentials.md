# Content Credentials

The public `scrivener-mcp` server can inspect local C2PA capabilities, sign an existing asset to a
new output, and validate embedded or detached credentials. It uses the official
[`@contentauth/c2pa-node` SDK](https://opensource.contentauthenticity.org/docs/node-landing/).
These operations work without an open Scrivener project.

Version **0.14.0 is a local, unreleased feature version**. At preparation time the published npm
release remains 0.12.0; installing that release does not provide these new tools. No C2PA
application, legal agreement, certificate purchase or publication has been submitted for this work.
Conformance is **not assessed**, no assurance level has been awarded, and no attestation methods
are implemented. A credential signature does not establish human authorship, originality or the
truth of an asset's contents.

## Tools and workflow

| Tool | Inputs | Result |
| --- | --- | --- |
| `c2pa_capabilities` | Empty object. | Actual SDK availability/version, declared formats and modes, compressed-manifest flags, signing-configuration presence, limits and unassessed conformance status. |
| `sign_content_credentials` | Absolute `assetPath`; explicit, different `outputPath`; optional `mimeType`, `mode`, `title` and `includeReport`. | New output path/byte count, source revision, SDK version and normalized validation. `mode` defaults to `embedded`; `sidecar` produces a `.c2pa` file. |
| `validate_content_credentials` | Absolute `assetPath`; optional `mimeType`, detached `manifestPath` and `includeReport`. | Normalized state, separate integrity/trust results, policy, SDK validation codes, source revision and SDK version. |

Paths are limited to 4,096 characters and titles to 500. MIME type can be inferred from a recognized
extension. Keys, certificates, passwords, trust configuration and remote URLs are not accepted as
tool arguments. `includeReport` defaults to `false`; set it to `true` only when the full SDK report
is needed. Normalized evidence remains available without the potentially large raw report.

For a manuscript, first open the project and resolve export preflight findings. Use
`export_manuscript` for a preset, or `export_project` for another supported exporter. The export
step requires an open project; the credential steps do not. For example, after the chosen
format/mode has passed the native compatibility gate on the target platform:

1. Export a PDF with `export_project`:

   ```json
   {
     "format": "pdf",
     "outputPath": "/absolute/path/manuscript.pdf"
   }
   ```

   `export_manuscript` also produces preset DOCX/EPUB files, for example
   `{"action":"export","preset":"beta-reader","outputPath":"/absolute/path/beta.docx"}`.
   Credential support for their ZIP containers remains subject to the limitations below.
   `export_project` Markdown, HTML and JSON modes return inline content; signing requires a saved file.

2. Create a new embedded PDF with `sign_content_credentials`:

   ```json
   {
     "assetPath": "/absolute/path/manuscript.pdf",
     "outputPath": "/absolute/path/manuscript-signed.pdf",
     "mode": "embedded",
     "title": "Manuscript review draft"
   }
   ```

3. Check that signed file with `validate_content_credentials`:

   ```json
   {
     "assetPath": "/absolute/path/manuscript-signed.pdf"
   }
   ```

For an evidence-backed detached format, select `sidecar`, choose a new `.c2pa` output, then
validate the original asset with that sidecar supplied as `manifestPath`. Detached MP3, FLAC and
PDF currently have known failures and must not be substituted into that workflow.
`sourceRevision` is the SHA-256 of the input to each operation: detached signing/validation use
the original asset, while embedded validation reads the newly signed file.

Signing preserves the input bytes and publishes output exclusively: an existing destination is
rejected rather than overwritten. Concurrent creation of the same destination is also rejected.
Detected source changes during processing cause failure. Source assets and supplied sidecars must
be regular files, not symbolic-link entries. Credential output inside a `.scriv` project must be
under `.scrivener-mcp/exports`; native
manuscript files are not credential destinations. Choose a new output for a deliberate new signing
operation rather than blindly replaying a completed write.

## Administrator configuration and offline trust

Provision signing material in the server process environment through an administrator-controlled
secret mechanism. Do not put secrets in MCP requests, client conversations, logs, issue reports,
committed files or shell history.

| Environment variable | Purpose |
| --- | --- |
| `SCRIVENER_C2PA_CERT_PATH` | Absolute path to the signing certificate/chain in PEM form. |
| `SCRIVENER_C2PA_KEY_PATH` | Absolute path to an **encrypted PKCS#8 PEM** private key. Unencrypted keys are rejected. |
| `SCRIVENER_C2PA_KEY_PASSWORD` | Private-key password, supplied as a secret. Configure all three signing variables together. |
| `SCRIVENER_C2PA_TRUST_ANCHORS_PATH` | Optional absolute path to local PEM trust anchors used for validation. |

Validation does not require signing credentials. The SDK's online OCSP and remote-manifest
fetching are disabled, and this integration makes no TSA requests. Local-root validation is a
statement about the configured trust policy, not a claim of fresh online revocation information,
public trust-list membership or C2PA approval. Installation may download official native SDK
binaries; that is separate from offline credential operations.

| State | Interpretation |
| --- | --- |
| `valid` | Integrity and signer trust passed under the reported policy. |
| `untrusted` | Integrity can be valid while signer trust is not established, including absent or mismatched configured roots. |
| `invalid` | Credential integrity/binding validation failed; inspect the normalized SDK codes. |
| `unsigned` | No applicable credential was found; integrity/trust may be `not-evaluated`. |

Always read `integrity`, `trust`, `trustPolicy` and `validationCodes` alongside `state`. A
self-signed development certificate is not publicly trusted. Signing does not automatically
assert a human author, add WritersProof attestations or classify optional AI-assisted work as
human-created. Official trust-list refresh procedures and formal security review remain preparation
work before program claims; local test-root validation does not establish either process.

## Coverage and evidence

The format catalog is a declared envelope of roughly 80 MIME types, **not a list of passed native
tests**. Embedded and detached coverage are separate. Experimental entries, untested formats and
unsupported embedded modes must not become intake claims. Aliases/extensions are not additional
independently tested formats. A generic whole-file detached hash binds bytes; it does not validate
the internal structure of DOCX, EPUB, a 3D model or another file format.

The current partial native run covers **32 fixtures: 27 passing and five with known mode
failures**. This is not a passing final matrix. Detached MP3, FLAC and PDF report rewritten-hash
mismatches; embedded PDF has verified `trust: trusted` evidence. Prefer the embedded MP3/FLAC paths
only where their per-format evidence passes. Stock SDK handling of deflated DOCX/EPUB ZIP files is
currently unsupported.

DOCX/EPUB preparation is being implemented and is not yet an intake claim. The planned path copies
an unsigned ZIP to a new STORE archive while preserving entries and asserting the original source
hash. The original never changes. Existing credentials that cannot be read must fail closed rather
than be stripped or silently regenerated. Require a passing end-to-end matrix before claiming this
prepared-output path or replacing the original ZIP's validation result with it.

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
report does not establish coverage on every platform. Native format testing is in progress;
this document deliberately does not prefill every MIME answer as supported.

Compatibility fixtures use disposable, randomly generated development certificates and encrypted
keys. Never commit private fixture keys, use a test CA for production, or treat its trust result as
public certification. Local fixture signing does not require paid provider API calls.

The stable Node requirement is `^22.23.4 || ^24.22.1 || >=26.12.1`, with N-API 10 or newer.
The [official SDK prerequisites](https://opensource.contentauthenticity.org/docs/node-landing/)
explain the patched TLS floors used by the binary installer and JavaScript fetch paths. Acceptance
of a later stable major does not substitute for platform compatibility evidence.
Service limits are **128 MiB source assets**, **8 MiB detached manifests/reports**, a **30-second
native-operation timeout**, and **two concurrent operations**. Busy operations are rejected for a
later explicit retry. Native parsing/signing runs in isolated child processes; failures do not
authorize overwriting an existing output.

## Intake preparation: the 30 questions

The rows follow the supplied questionnaire order. This is preparation, not a submitted application
or a grant of status. Reconcile final answers with the current program form and passing evidence.
Request **both Generator Product and Validator Product**
roles for the implemented functions; the program handles a separate legal agreement process for
each requested role. See the
[C2PA Conformance Program](https://github.com/c2pa-org/conformance-public/blob/main/docs/v0.2/C2PA%20Conformance%20Program.md).

| # | Intake question | Requested target or intended answer | Evidence, limitations or granted status |
| --- | --- | --- | --- |
| 1 | Compressed manifests | Validation: supported by the demonstrated fixture. Generation: not implemented. | Real `c2cm`/`brob` PNG validation passed with trusted status and unchanged source; no generation claim. |
| 2 | Product type | Request both Generator Product and Validator Product. | Functions are implemented locally; neither role has been approved. Each role has its own agreement process. |
| 3 | Web address | Public repository: https://github.com/writerslogic/scrivener-mcp. | Confirm the preferred submission URL before filing. |
| 4 | Implementation class | Edge Class. | Assets, claims and signatures are processed on the local endpoint; no formal classification granted. |
| 5 | Category | Creative application for human-controlled manuscript editing; AI features optional. | Ask the program to confirm any non-generative classification. |
| 6 | Common name (CN) | `scrivener-mcp` | Confirmed product identity; certificate issuance is separate. |
| 7 | Organization (O) | WritersLogic, Inc. | Confirmed legal organization. |
| 8 | Country (C) | US | Confirmed legal country. |
| 9 | Organizational unit (OU) | Leave blank. | No OU supplied. |
| 10 | Minimum software version | 0.14.0, intended first feature version. | Full feature version is local prerelease work, not assessed or published; npm remains 0.12.0. Node runtime floors are documented separately above. |
| 11 | Max Assurance Level | Target AL1 evaluation. | No AL awarded: current `maxAssuranceLevel` is null and conformance is `not-assessed`. |
| 12 | Attestation methods | None implemented. | Empty methods list; no borrowed WritersProof/App Attest evidence. |
| 13 | Generate images | Request only the evidenced image-generation subset. | Final Yes/No selection must follow passing generation results; catalog membership alone is insufficient. |
| 14 | Image generation MIME types | Populate a separate generation list from the final native matrix. | Record each MIME and embedded/detached mode; exclude experimental, untested or failing entries. |
| 15 | Video generation MIME types | Populate from passing ordinary-file generation results. | Do not infer live, fragmented or per-segment support from a completed-file container test. |
| 16 | Audio generation MIME types | Select passing MIME/mode pairs; prefer embedded MP3/FLAC where evidenced. | Detached `audio/mpeg` MP3 and `audio/flac` currently have rewritten-hash mismatches; do not claim those modes. |
| 17 | Document generation MIME types | Embedded `application/pdf` has trusted evidence; other selections await the final matrix. | Detached PDF currently fails. DOCX/EPUB STORE preparation is in progress, not yet a claim; stock deflated ZIP handling is unsupported. |
| 18 | Text generation MIME types | Select only independently evidenced text MIME/mode pairs. | Generic detached byte binding is distinct from text-format parsing; experimental embedded-text entries are not claimed. |
| 19 | Generate OTF fonts | Decide from OTF generation evidence and declare its mode. | No unqualified Yes from a font catalog entry or generic byte binding. |
| 20 | ML-model generation types | Select only model types with passing generation evidence. | A whole-file hash does not validate model internals, training provenance or native embedded support. |
| 21 | Validate images | Populate an image-validation list from passing validation/tamper results. | Keep this list separate from image generation; compressed PNG validation evidence is recorded above. |
| 22 | Validate videos | Select only evidenced completed-file video validation modes. | Live streams, fragmented media and segment information are separate questions below. |
| 23 | Validate audio | Select only passing audio validation modes. | Preserve the MP3/FLAC detached failure exclusions; generation success alone is not validation evidence. |
| 24 | Validate documents | Embedded PDF has trusted evidence; other MIME/mode selections require final results. | Detached PDF fails currently. Do not report validation of an unreadable original DOCX/EPUB as success for a prepared copy. |
| 25 | Validate text | Populate only from passing text validation and altered-asset checks. | Distinguish detached whole-file binding from internal text-format validation. |
| 26 | Validate fonts | Select only evidenced font MIME/mode pairs. | No blanket font validation or format-internals claim. |
| 27 | Validate ML models | Select only evidenced model MIME/mode pairs. | Hash binding is not model-structure validation or a claim about model training. |
| 28 | Live streams | Not implemented/exposed by these tools. | No live-stream generation or validation claim. |
| 29 | fMP4 per segment / verifiable segment information | Not implemented/exposed by these tools. | Ordinary MP4 file results do not establish per-segment generation, validation or verifiable-segment-information support. |
| 30 | CMAF per segment / verifiable segment information | Not implemented/exposed by these tools. | No CMAF segment-generation, validation or verifiable-segment-information claim. |

The [program overview](https://c2pa.org/conformance/),
[Generator Product Security Requirements](https://github.com/c2pa-org/conformance-public/blob/main/docs/v0.2/C2PA%20Generator%20Product%20Security%20Requirements.md)
and [Certificate Policy](https://github.com/c2pa-org/conformance-public/blob/main/docs/v0.2/C2PA%20Certificate%20Policy.md)
govern assessment and certificate eligibility. AL1 and Edge targets do not bypass that review.
Before submission, replace pending format selections with evidence-backed results, confirm contacts
and product-category interpretation, and have the applicant review the applicable role agreements.
