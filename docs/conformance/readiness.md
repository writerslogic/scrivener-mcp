# C2PA application readiness

The six preparation findings now have implemented controls and passing local evidence. **Formal
conformance and assurance remain unassessed.** The administrator must assess this exact candidate;
this report is not a Notice of Conformance or permission to claim AL1.

Candidate: **scrivener-mcp 0.14.0**, with the source-built **c2pa-rs 0.91.7** engine and the
hash-checked trust-purpose compatibility patch described in
[the binding](../../native/c2pa-binding/README.md). The source parent is
`9b673e010a7e3250b0e7ad9b2b75fdb37346cda7`; the final candidate revision and source/artifact hashes
are recorded in the private evidence packet. Local measurements use macOS arm64 / Node **24.22.2**.

The assessment baseline is program **0.2**, specification **2.4**, reference commit
`f58b10a3a0e7aea834436728ca18c4ea4ed57fb5`. Controlling references are the
[security requirements](https://github.com/c2pa-org/conformance-public/blob/f58b10a3a0e7aea834436728ca18c4ea4ed57fb5/docs/v0.2/C2PA%20Generator%20Product%20Security%20Requirements.md),
[additional requirements](https://github.com/c2pa-org/conformance-public/blob/f58b10a3a0e7aea834436728ca18c4ea4ed57fb5/docs/v0.2/Additional%20Conformance%20Requirements%20Against%20the%20Content%20Credentials%20Specification.md)
and
[official rubric](https://github.com/c2pa-org/conformance-public/blob/f58b10a3a0e7aea834436728ca18c4ea4ed57fb5/asset-rubrics/asset-rubric-conformance0.2-spec2.4.yml).

## Acceptance evidence

| ID      | Implemented behavior                                                                                                                                                                                                                                      | Measured evidence / remaining boundary                                                                                                                                                                                                                                                                                                                                                                             |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C2PA-01 | Generated claims identify specification 2.4.                                                                                                                                                                                                              | All 41 product crJSON reports pass `mandatory_spec_version`. Prior source claims remain intact.                                                                                                                                                                                                                                                                                                                    |
| C2PA-02 | New actions are created assertions, with `allActionsIncluded: true`; SDK-generated opened actions retain parent linkage. Repackaging is disclosed.                                                                                                        | All 31 official rubric traits pass on each of 41 reports, including inception-action position and both completeness traits. The compatibility gate prevents attribution regressions.                                                                                                                                                                                                                               |
| C2PA-03 | `scrivener-c2pa validate` invokes the product validator with independent signing/TSA lists and an RFC 3339 clock, emitting actual SDK crJSON. MCP callers cannot override trust/time.                                                                     | Cross-role signing and timestamp tests reject the wrong trust purpose; before-validity and expiry tests fail correctly; four reference assets validate expired signers using trusted timestamps. Product CLI and service crJSON agree. Full official-schema validation has the external limit below.                                                                                                               |
| C2PA-04 | Detached source manifests are revision-checked, ingested and linked as parents. Invalid sources require explicit opt-in, retain their history and receive a signed disclosure visible in later summaries.                                                 | 35 selected MIME choices have signed-source ingestion, output validation and passing rubric reports, including eight archive profiles. All six supplied library inputs are exercised: five valid; one PNG has an invalid historical certificate. Default rejection and explicit preservation are demonstrated. All 48 redistributable format fixtures pass their applicable modes, tamper and preservation checks. |
| C2PA-05 | Five inventories cover npm, the conservative C2PA lock graph, source-associated editorial native dependencies, upstream HMS platform SBOMs and the actual runtime. NVD-aware release checks reject applicable high/critical findings and stale databases. | Verified Syft 1.55.0 / Grype 0.121.0 scans pass with explicit, reviewed VEX statements. Raw findings, exceptions, database/tool identities and hashes are retained. `npm audit` reports zero; registry verification covers 239 signatures and 33 attestations. Source association is not an independent binary-rebuild attestation or an OS vulnerability audit.                                                   |
| C2PA-06 | Strong encrypted-key profile, owner/ACL checks, private staging, safe key generation and identity-preserving migration. No key/password parameters on MCP tools.                                                                                          | Local encrypted-key, boundary, access, migration and signing checks pass. Windows ACL enforcement is implemented and has real compatibility CI checks; final-candidate results must be attached; per-installation production provisioning still requires operator review. No hardware key-isolation claim.                                                                                                         |

The complete local gate passes formatting, zero-warning lint, types/build, registry/output/HMS
checks, **1,628 tests** across 118 suites (nine existing opt-in tests skipped), npm audit and **23
fresh installation/MCP smoke checks**. Fresh installation and tests use isolated configuration
directories and synthetic manuscripts. They do not modify the developer's real client configuration
or books. Windows/Linux results must be attached from the CI run for the final candidate;
configuration is not execution evidence.

## Evidence packet and reproduction

The new private packet is `build/c2pa-remediation-20261030/packet/`. It contains:

- The GPSA, private applicant annex and candidate intake information.
- Original CC0 inputs, signed ingredients, all 35 selected format outputs and required sidecars.
- The six administrator-provided ingredients and actual input/output validation evidence.
- Product crJSON, the pinned official evaluator/rubric and 41 passing evaluations.
- Key-profile/rotation evidence, five dependency inventories, raw security reports and explicit VEX.
- Source/runtime/artifact identities, command records and payload checksums.

Run the public compatibility gate after building:

```sh
node scripts/check-c2pa-compatibility.mjs --output /absolute/new-compatibility.json
```

The [administrator CLI](../content-credentials.md#administrator-configuration-and-offline-trust)
provides repeatable assessment and key operations. Generate security evidence with verified tools:

```sh
node scripts/create-c2pa-inventory.mjs --syft /absolute/syft --output /absolute/new-inventory
node scripts/check-c2pa-supply-chain.mjs --grype /absolute/grype --manifest /absolute/new-inventory/input-manifest.json --output /absolute/new-security --vex /absolute/scrivener-mcp/assets/c2pa-supply-chain/vex.openvex.json
```

Refresh the Grype database before scanning; scans do not update it implicitly. The reviewed VEX
covers the fixed Node-bundled Brotli issue, one historical V8 false positive, development-only
URI/glob dependencies and the unreachable EJS template-control path. Runtime security floors and the
development-only dependency scope are checked by the producer. Other high/critical findings remain
release blockers, including unfixed ones. Do not use a different VEX without review.

The original failing baseline remains unchanged:
`build/c2pa-preflight-20261029/GPSA-scrivener-mcp-0.14.0-readiness.zip`, SHA-256
`eb5d24338fd54182c311f02881f8d036913374481bbe79bfd66b0a837abe226c`. It has 253 files and failed
three traits per assessed report; it is not the passing candidate packet. The supplied library ZIP
SHA-256 is `9b57c36115601df0d2488697e0c506729d3fb5302c7dbf982f371bb88672efe0`. No redistribution
license is inferred for that media, so it remains private. Disposable signing keys are deleted.
Public test certificates are untrusted and short-lived; reports identify the supplied assessment
time. Regenerate samples when testing current-time validity after their expiry.

## External assessment and deployment gates

1. **Official schema:** the published
   [2.4 crJSON specification, section 5](https://spec.c2pa.org/specifications/specifications/2.4/crJSON/crjson-format.html#_full_schema)
   contains an unresolved include instead of the full schema. The published 2.4 branch
   `c7e55d5a3c1e758eeabad058e501fadbb8cfe777` and pinned conformance repository do not supply that
   file. Actual SDK serialization and the official rubric are verified; full official-schema
   validation is not claimed. Request the administrator's authoritative schema and validation
   corpus.
2. **Exact release/platform evidence:** attach the final candidate CI matrix and retained C2PA/SCA
   artifacts. Production account permissions, secret provisioning, certificate custody, revocation
   and rotation procedures require a deployment-specific review; tests do not certify arbitrary
   hosts.
3. **Applicant review:** confirm the private legal/contact annex, product URL, minimum version,
   requested roles and agreements. The user selected Edge, None of the above and an AL1 target;
   product-category and eligibility interpretation belongs with the administrator. Generator
   validation and a separately listed Validator are distinct assessment roles.
4. **Program decision:** assessment, approval, Notice of Conformance, CA enrollment/issuance and
   public listing remain external. Existing WritersProof/Holographic Memory records do not transfer
   by assumption. Keep `conformance.status: not-assessed`, `maxAssuranceLevel: null` and no claimed
   attestation methods until the actual award supports a change.

No application, email, external upload, purchase, npm release or deployment is performed by this
work. Compressed-manifest generation remains unsupported; local compressed PNG validation passes. No
live stream, fMP4/CMAF segment, font or ML-model conformance claim is added.
