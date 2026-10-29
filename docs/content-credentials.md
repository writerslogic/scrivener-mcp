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

1. Export a beta-reader DOCX with `export_manuscript`:

   ```json
   {
     "action": "export",
     "preset": "beta-reader",
     "outputPath": "/absolute/path/beta.docx"
   }
   ```

   An alternative file-producing call is `export_project` with
   `{"format":"pdf","outputPath":"/absolute/path/manuscript.pdf"}`. Its Markdown, HTML and
   JSON modes return inline content; signing requires an actual saved file.

2. Create a detached credential with `sign_content_credentials`:

   ```json
   {
     "assetPath": "/absolute/path/beta.docx",
     "outputPath": "/absolute/path/beta.docx.c2pa",
     "mode": "sidecar",
     "title": "Manuscript beta draft"
   }
   ```

3. Check that asset/manifest pair with `validate_content_credentials`:

   ```json
   {
     "assetPath": "/absolute/path/beta.docx",
     "manifestPath": "/absolute/path/beta.docx.c2pa"
   }
   ```

For an evidence-backed embedded format, select `embedded`, choose a fresh output path with the
matching asset extension, then validate that signed output without `manifestPath`.
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
human-created.

## Coverage and evidence

The format catalog is a declared envelope of roughly 80 MIME types, **not a list of passed native
tests**. Embedded and detached coverage are separate. Experimental entries, untested formats and
unsupported embedded modes must not become intake claims. Aliases/extensions are not additional
independently tested formats. A generic whole-file detached hash binds bytes; it does not validate
the internal structure of DOCX, EPUB, a 3D model or another file format.

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

## Intake preparation: 30 items

This is a preparation worksheet, not a submitted application or a grant of status. Reconcile it
with the program's current intake form. Request **both Generator Product and Validator Product**
roles for the implemented functions; the program handles a separate legal agreement process for
each requested role. See the
[C2PA Conformance Program](https://github.com/c2pa-org/conformance-public/blob/main/docs/v0.2/C2PA%20Conformance%20Program.md).

| # | Intake topic | Requested target or intended answer | Evidence or granted status |
| --- | --- | --- | --- |
| 1 | Legal entity | WritersLogic, Inc. | Applicant identity confirmed; not program approval. |
| 2 | Country | US | Confirmed legal country. |
| 3 | Product/common name | `scrivener-mcp` | Confirmed product CN; certificate issuance remains separate. |
| 4 | Organizational unit | Leave blank. | No OU supplied; do not invent one. |
| 5 | Applicant contacts and signatory | Supply authorized legal/business and technical/security contacts. | Contact details and signing authority still require applicant confirmation. |
| 6 | Product version | 0.14.0 for the new feature submission target. | Local and unreleased; npm remains 0.12.0 at preparation time. |
| 7 | Product scope | Public local MCP server and its setup tooling. | Private Draftbridge and WritersProof are separate products, not inherited evaluation evidence. |
| 8 | Generator role | Request Generator Product. | Local claim/signature generation implemented; no role approval granted. |
| 9 | Validator role | Request Validator Product as well. | Local reading/validation implemented; no role approval granted. |
| 10 | Product category | Creative application for human-controlled manuscript editing; AI features are optional. | Confirm the program's interpretation before selecting a non-generative category. |
| 11 | Implementation class | Edge Class: asset, claim and signature processing on the local endpoint. | Describes this implementation; formal classification has not been reviewed. |
| 12 | Assurance target | Request evaluation for AL1. | Target only; no assurance level awarded. |
| 13 | Conformance status | Seek assessment after evidence is complete. | `not-assessed`; `maxAssuranceLevel: null`; not listed as conforming. |
| 14 | Attestation methods | None implemented. | Empty methods list; no borrowed WritersProof/App Attest claims. |
| 15 | Application/legal status | Prepare the Generator and Validator role processes. | No application or legal agreement submitted/executed for this work. |
| 16 | Certificates, CA and TSA | Use administrator-provisioned signing credentials; no CA/TSA provider role requested. | No production certificate purchased or enrollment/TSA service implemented. |
| 17 | Image formats | Select only evidenced MIME types and modes. | Catalog entries alone are insufficient; fill from native JSON results. |
| 18 | Video formats | Select only evidenced containers and modes. | Do not extend ordinary-file results to fragmented media; untested/experimental entries excluded. |
| 19 | Audio formats | Select only evidenced MIME types and modes. | A catalog label or extension alias is not a native compatibility result. |
| 20 | Manuscript/document formats | Select only evidenced PDF/DOCX/EPUB/RTF or other document operations. | Distinguish embedded processing from a detached whole-file binding; no blanket document-format claim. |
| 21 | Text and structured data | Select only evidenced types/modes. | Experimental embedded-text support is excluded until demonstrated with the pinned binary. |
| 22 | Fonts, models and archives | Select only evidenced detached/embedded operations. | Generic byte binding does not validate format internals or establish native embedded support. |
| 23 | Embedded generation/validation | Request coverage for each passing asset format. | Record both operation results; no inherited approval from using an SDK. |
| 24 | Detached generation/validation | Request coverage for passing asset plus `.c2pa` pairs. | Preserve and validate the original asset together with its sidecar; report mode explicitly. |
| 25 | Compressed manifests | Claim only demonstrated generation/validation capabilities. | Current capability flags are false for both; no compressed-manifest intake claim. |
| 26 | Signing-key protection | Encrypted PKCS#8, administrator-only configuration and isolated local signing. | Software-key design implemented; hardware-backed key storage/attestation is not claimed. |
| 27 | Signer trust | Local, administrator-configured PEM trust roots. | Offline policy result; no public trust-list admission or fresh revocation guarantee. |
| 28 | Network behavior | Offline credential operations. | No OCSP, remote-manifest or TSA requests; SDK installation is a separate download step. |
| 29 | Runtime and operational scope | Patched stable Node range above; N-API 10+, bounded assets/reports, two operations. | Platform and native-module coverage must be backed by each target's actual report. |
| 30 | Submission evidence and claims | Attach passing native matrix, security architecture and accurate claim descriptions. | Matrix/review still pending; no automatic author, human-origin or official conformance assertion. |

The [program overview](https://c2pa.org/conformance/),
[Generator Product Security Requirements](https://github.com/c2pa-org/conformance-public/blob/main/docs/v0.2/C2PA%20Generator%20Product%20Security%20Requirements.md)
and [Certificate Policy](https://github.com/c2pa-org/conformance-public/blob/main/docs/v0.2/C2PA%20Certificate%20Policy.md)
govern assessment and certificate eligibility. AL1 and Edge targets do not bypass that review.
Before submission, replace pending format selections with evidence-backed results, confirm contacts
and product-category interpretation, and have the applicant review the applicable role agreements.
