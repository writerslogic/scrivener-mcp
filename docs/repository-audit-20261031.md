# Repository audit verification — 31 October 2026

All nine P0/P1/P2 remediation criteria and the tested hard-cancellation contract pass at
`2eb6b9e2c4246767fee53eebeeb058e3ab217a6d`.
[CI 41247863036, attempt 1](https://github.com/writerslogic/scrivener-mcp/actions/runs/41247863036)
completed successfully: eight platform rows, native/runtime security and the aggregate release gate.
This is acceptance of the specified implementation and fixture contracts, with the evidence limits
below.

The tested candidate is on `audit/production-readiness-20261031-befef94e`. This report and the
closing ledger entry are documentation published after that candidate; CI evidence remains bound to
the exact SHA above. No merge or package publication was performed.

## Platform and integration results

| Runner / requested Node | Actual Node | Suites                                  | Tests                               | Installed checks | Evidence                                                                                       |
| ----------------------- | ----------- | --------------------------------------- | ----------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------- |
| ubuntu-latest, 22.23.4  | v22.23.4    | 2 skipped, 155 passed, 155 of 157 total | 12 skipped, 2557 passed, 2569 total | 23               | [Log](https://github.com/writerslogic/scrivener-mcp/actions/runs/41247863036/job/124674949560) |
| ubuntu-latest, 22.x     | v22.23.4    | 2 skipped, 155 passed, 155 of 157 total | 12 skipped, 2557 passed, 2569 total | 23               | [Log](https://github.com/writerslogic/scrivener-mcp/actions/runs/41247863036/job/124674949518) |
| ubuntu-latest, 24.x     | v24.22.2    | 2 skipped, 155 passed, 155 of 157 total | 12 skipped, 2557 passed, 2569 total | 23               | [Log](https://github.com/writerslogic/scrivener-mcp/actions/runs/41247863036/job/124674949547) |
| ubuntu-latest, 26.x     | v26.13.0    | 2 skipped, 155 passed, 155 of 157 total | 12 skipped, 2557 passed, 2569 total | 23               | [Log](https://github.com/writerslogic/scrivener-mcp/actions/runs/41247863036/job/124674949678) |
| macos-latest, 22.23.4   | v22.23.4    | 2 skipped, 155 passed, 155 of 157 total | 12 skipped, 2557 passed, 2569 total | 23               | [Log](https://github.com/writerslogic/scrivener-mcp/actions/runs/41247863036/job/124674949623) |
| macos-latest, 24.x      | v24.22.2    | 2 skipped, 155 passed, 155 of 157 total | 12 skipped, 2557 passed, 2569 total | 23               | [Log](https://github.com/writerslogic/scrivener-mcp/actions/runs/41247863036/job/124674949702) |
| windows-2022, 22.23.4   | v22.23.4    | 3 skipped, 154 passed, 154 of 157 total | 40 skipped, 2533 passed, 2573 total | 22               | [Log](https://github.com/writerslogic/scrivener-mcp/actions/runs/41247863036/job/124674949531) |
| windows-latest, 24.x    | v24.22.2    | 3 skipped, 154 passed, 154 of 157 total | 40 skipped, 2533 passed, 2573 total | 22               | [Log](https://github.com/writerslogic/scrivener-mcp/actions/runs/41247863036/job/124674949586) |

Every row passed type checking, formatting, lint, build, runtime policy, tool registry, generated
annotation drift, output conformance, HMS compatibility, native C2PA compatibility, default tests,
installed-consumer smoke and dependency audit. Skips remain explicit; the Windows installed smoke
omits the POSIX FIFO check. Default tests do not include the separately measured novel workload.

Ubuntu 24 also executed all five Docker checks, all 15 real Redis checks, headless Chromium
dashboard interactions and four EPUBCheck 5.4.0 cases: Unicode/empty exports, each unsigned and
signed. Redis 7.0.15, BullMQ 6.5.1 and ioredis 6.0.0 were exercised. Browser checks cover the Apps
handshake, escaped context, pagination, preview, formatting-loss acknowledgment, apply, undo and
finding review.

The Docker artifact binds successful startup to immutable image
`sha256:69260ae70b9aaa1471513b892b8cf25282045300bd8337e99892f1aba03f46d9`: Linux/x64, Node v26.12.1,
server 0.14.0, non-root UID 1000, all four PID 1 UIDs nonzero, natural EOF exit code 0 and
owned-container cleanup. The configured limits are one CPU, 1.5 GiB memory, zero additional swap,
128 PIDs and no network. These observations verify configuration and lifecycle, not independent
kernel enforcement.

## Remediation acceptance

All linked tests are immutable source at the tested SHA, and their suites passed in the Ubuntu 24
job. `audit-acceptance.json` retains each test's SHA-256 and the exact run/attempt binding.

| Criterion         | Verified outcome                                                                                                                        | Functional evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-1              | Truthful provider fallback preserves local native findings and rejects changed source.                                                  | [document-analysis-fallback.test.ts](https://github.com/writerslogic/scrivener-mcp/blob/2eb6b9e2c4246767fee53eebeeb058e3ab217a6d/tests/unit/handlers/document-analysis-fallback.test.ts), [generate-content.test.ts](https://github.com/writerslogic/scrivener-mcp/blob/2eb6b9e2c4246767fee53eebeeb058e3ab217a6d/tests/unit/handlers/generate-content.test.ts)                                                                                                                                                         |
| P0-2              | Empty, short and failed analysis exposes availability without invented scores; sibling findings survive.                                | [analysis-availability.test.ts](https://github.com/writerslogic/scrivener-mcp/blob/2eb6b9e2c4246767fee53eebeeb058e3ab217a6d/tests/unit/analysis/analysis-availability.test.ts), [advanced-readability.test.ts](https://github.com/writerslogic/scrivener-mcp/blob/2eb6b9e2c4246767fee53eebeeb058e3ab217a6d/tests/unit/analysis/advanced-readability.test.ts)                                                                                                                                                           |
| P1-1              | Common source/configuration/revision envelope and explicit raw/configured policy across public routes.                                  | [analysis-envelope.test.ts](https://github.com/writerslogic/scrivener-mcp/blob/2eb6b9e2c4246767fee53eebeeb058e3ab217a6d/tests/unit/services/analysis-envelope.test.ts), [narrative-analysis.test.ts](https://github.com/writerslogic/scrivener-mcp/blob/2eb6b9e2c4246767fee53eebeeb058e3ab217a6d/tests/unit/services/narrative-analysis.test.ts)                                                                                                                                                                       |
| P1-2              | Lossless immutable report pagination accounts for complete MCP UTF-8 bytes at exact limits; current 45-operation novel workload passes. | [report-transport.test.ts](https://github.com/writerslogic/scrivener-mcp/blob/2eb6b9e2c4246767fee53eebeeb058e3ab217a6d/tests/unit/services/report-transport.test.ts), [narrative-analysis.test.ts](https://github.com/writerslogic/scrivener-mcp/blob/2eb6b9e2c4246767fee53eebeeb058e3ab217a6d/tests/unit/services/narrative-analysis.test.ts)                                                                                                                                                                         |
| P1-3              | Ten generated nested annotation contracts validate positive evidence and malformed nested fields; offline drift gate passes.            | [narrative-schema-generation.test.ts](https://github.com/writerslogic/scrivener-mcp/blob/2eb6b9e2c4246767fee53eebeeb058e3ab217a6d/tests/unit/handlers/narrative-schema-generation.test.ts), [narrative-analysis.test.ts](https://github.com/writerslogic/scrivener-mcp/blob/2eb6b9e2c4246767fee53eebeeb058e3ab217a6d/tests/unit/services/narrative-analysis.test.ts)                                                                                                                                                   |
| P1-4              | All ten native dispatch paths, invalid evidence, admission/array bounds, cancellation and recovery exercised.                           | [narrative-analysis.test.ts](https://github.com/writerslogic/scrivener-mcp/blob/2eb6b9e2c4246767fee53eebeeb058e3ab217a6d/tests/unit/services/narrative-analysis.test.ts), [narrative-worker.test.ts](https://github.com/writerslogic/scrivener-mcp/blob/2eb6b9e2c4246767fee53eebeeb058e3ab217a6d/tests/unit/services/narrative-worker.test.ts), [narrative-context.test.ts](https://github.com/writerslogic/scrivener-mcp/blob/2eb6b9e2c4246767fee53eebeeb058e3ab217a6d/tests/unit/services/narrative-context.test.ts) |
| P1-5              | Finding decisions survive restart and Unicode edits; stale/replaced baselines fail and rechecks use native comparison.                  | [narrative-analysis.test.ts](https://github.com/writerslogic/scrivener-mcp/blob/2eb6b9e2c4246767fee53eebeeb058e3ab217a6d/tests/unit/services/narrative-analysis.test.ts)                                                                                                                                                                                                                                                                                                                                               |
| P1-6              | Signed BCE years and signed/unsigned native boundaries retain separate year/tolerance validation.                                       | [narrative-analysis.test.ts](https://github.com/writerslogic/scrivener-mcp/blob/2eb6b9e2c4246767fee53eebeeb058e3ab217a6d/tests/unit/services/narrative-analysis.test.ts)                                                                                                                                                                                                                                                                                                                                               |
| P2-1              | Shared detector delegates upstream; retained business-word, prose-cue and singleton-canon gaps have comparative fixtures.               | [detector-ownership.test.ts](https://github.com/writerslogic/scrivener-mcp/blob/2eb6b9e2c4246767fee53eebeeb058e3ab217a6d/tests/unit/analysis/detector-ownership.test.ts)                                                                                                                                                                                                                                                                                                                                               |
| Hard cancellation | Blocked native children exit before cancellation/deadline completion, including owner death and server shutdown.                        | [narrative-worker.test.ts](https://github.com/writerslogic/scrivener-mcp/blob/2eb6b9e2c4246767fee53eebeeb058e3ab217a6d/tests/unit/services/narrative-worker.test.ts), [narrative-context.test.ts](https://github.com/writerslogic/scrivener-mcp/blob/2eb6b9e2c4246767fee53eebeeb058e3ab217a6d/tests/unit/services/narrative-context.test.ts), [server-shutdown.test.ts](https://github.com/writerslogic/scrivener-mcp/blob/2eb6b9e2c4246767fee53eebeeb058e3ab217a6d/tests/unit/handlers/server-shutdown.test.ts)       |

The payload budget covers the complete serialized MCP result, including text escaping and structured
content, excluding its outer JSON-RPC frame. Native finding caps remain disclosed; lossless
pagination does not claim the native engine produced findings beyond its configured cap. Signed
years use the established native signed 32-bit range; tolerance is separately unsigned. Retained
detector exceptions are fixture-backed business classification, prose cues and singleton canon
extraction, with source locations/provenance; no universal detector-equivalence claim is made.

Child requests remain capped at 64 MiB, results at 16 MiB and V8 old generation at 384 MiB.
Cancellation/deadline completion waits for actual child exit. The delayed-entry cancellation
regression waits for native entry before aborting; deadline evidence uses the spawned PID directly.
The V8 setting and 16 MiB native cache are distinct from total process/native RSS containment.

## Novel workload and diagnosis

All 45 measured operations passed unchanged budgets: 5,000 ms elapsed, 100 ms server event-loop lag
and 128 MiB sampled server RSS growth. Five cold/warm/one-edit samples per complete pinned novel ran
through the real stdio server with 32,768-byte pages on macOS arm64 / Node 24.22.2. Measurement SHA
was `3ba6846f5f8e627e6105567f21bc1e5b9198629c`; only VEX, documentation and two unit test files
changed afterward. Production source, dependency graph and workload harness are identical to the CI
candidate. Source equivalence is recorded separately from execution at the measured SHA.

| Novel               | Phase          | Elapsed p50 / p95 ms | Lag p50 / p95 ms | Maximum server RSS growth MiB |
| ------------------- | -------------- | -------------------- | ---------------- | ----------------------------- |
| Frankenstein        | cold           | 239.58 / 250.90      | 15.89 / 20.05    | 18.78                         |
| Frankenstein        | warm           | 258.78 / 361.02      | 19.19 / 21.58    | 28.78                         |
| Frankenstein        | one-scene-edit | 262.28 / 280.48      | 18.87 / 19.28    | 14.33                         |
| Pride and Prejudice | cold           | 352.15 / 359.96      | 22.88 / 24.01    | 24.45                         |
| Pride and Prejudice | warm           | 371.17 / 386.91      | 31.53 / 45.28    | 51.89                         |
| Pride and Prejudice | one-scene-edit | 347.73 / 356.09      | 30.59 / 31.14    | 40.83                         |
| Moby Dick           | cold           | 698.50 / 742.00      | 59.60 / 59.74    | 41.14                         |
| Moby Dick           | warm           | 815.13 / 870.95      | 76.87 / 83.67    | 114.64                        |
| Moby Dick           | one-scene-edit | 827.77 / 845.25      | 76.01 / 77.25    | 47.52                         |

Maximum lag was 83.673 ms, elapsed 870.953 ms and server RSS growth 120,209,408 bytes.
Initialization completed within 30 seconds and tools within ten seconds. No concurrent local build,
installation or second suite ran during this complete measurement. With five samples, nearest-rank
p95 is the observed maximum. Cold means fresh project/native caches; setup, project opening and OS
cold disk cache are excluded. Elapsed time includes client reconstruction, local IPC and
instrumentation.

The earlier three Moby Dick lag violations (maximum 552.62 ms), initialization timeouts and empty
profile are preserved. Bounded stage/CPU/GC instrumentation did not reproduce their cause. The
successful Moby profile's longest windows overlapped report serialization/first-page creation and
recorded GC pauses below 5 ms; overlap is not proof of causation for the historical stall. No
speculative production performance change or relaxed threshold was used. Historical intermittent
causes remain unattributed; the current fixture gate passes without establishing universal latency.
Server RSS excludes native children; separately recorded lifetime child peaks are neither
simultaneous total RSS nor a containment bound, and sampling can miss peaks.

## Native and security evidence

Eight native artifacts each passed all 48 redistributable fixture entries with product 0.14.0, SDK
0.91.7 and the candidate fixture-index hash. Linux/Windows use x64; macOS uses arm64. Checks include
signing, tamper rejection, detached source history, output collision protection, encrypted keys,
trust-purpose separation and validation time. Trust uses an ephemeral synthetic test CA, not a
publicly trusted identity. Each artifact retains its 38 unexercised MIME entries and unavailable
JPEG XL/Ogg fixtures; 48 fixture passes do not imply every advertised format was exercised,
embedded, publicly trusted or externally certified.

All five security inventories passed the unchanged applicable-high/critical policy. The verifier
matched 26 source hashes to candidate Git blobs, inventory/SBOM and scanner-output hashes, expected
packages, scanner exit status and the exact candidate VEX hash.

| Inventory        | Medium findings | High / critical | VEX-excluded findings |
| ---------------- | --------------- | --------------- | --------------------- |
| npm-lock         | 1               | 0 / 0           | 5                     |
| c2pa-rust        | 1               | 0 / 0           | 0                     |
| editorial-native | 0               | 0 / 0           | 0                     |
| hms-upstream     | 0               | 0 / 0           | 0                     |
| runtime          | 2               | 0 / 0           | 2                     |

Medium findings remain: uri-js 4.4.1 (CVE-2026-93751), rsa 0.9.10 (CVE-2023-49092), and two runtime
V8 CPE matches (CVE-2011-5037, CVE-2011-3886). Raw excluded matches and applied rules are retained.
EJS 7.0.2/CVE-2023-29827 was reassessed against the export option allowlists, packaged templates and
engine data/options separation, with a real malicious-options export regression; its VEX disposition
is exact-version scoped. This is not a zero-findings claim across all scanners. The repository and
installed-consumer npm audits passed separately.

Conservative Cargo inventories include optional/development/target dependencies. Source-associated
opaque native binaries are not independently rebuilt attestations. Runtime CPE/backport
applicability and source association limits remain in the artifacts; the scan is not an OS audit or
conformance approval.

## Evidence identity and remaining limits

All ten artifact archives were checked against GitHub SHA-256 digests, sizes, run SHA/attempt and
creation time; extraction rejected unsafe paths/symlinks and bounded expansion. Native records,
container identity, security provenance and every required executed step were then verified.

| Artifact                                                                                                                   | ZIP bytes | SHA-256                                                            |
| -------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------ |
| [c2pa-macos-latest-22.23.4](https://github.com/writerslogic/scrivener-mcp/actions/runs/41247863036/artifacts/13060780667)  | 3223      | `231855cc6e289069ec4f6b65ba28aa5c110e0776593744f44f95ff596eeab02b` |
| [c2pa-ubuntu-latest-22.x](https://github.com/writerslogic/scrivener-mcp/actions/runs/41247863036/artifacts/13060680287)    | 3217      | `f78689d9ac3127119cda0c321291ea5e73b53d6158eca90816b02fab2e46cab2` |
| [c2pa-macos-latest-24.x](https://github.com/writerslogic/scrivener-mcp/actions/runs/41247863036/artifacts/13060615775)     | 3221      | `e1d2745589c7466632d200208aac4b480fa9cb04ec5381a6057b1c603a61eb2f` |
| [c2pa-ubuntu-latest-26.x](https://github.com/writerslogic/scrivener-mcp/actions/runs/41247863036/artifacts/13060441313)    | 3221      | `149877be638bd0da0156c78a21b7e3ce8929ff635dc825008ceb2b83f4584bf8` |
| [c2pa-windows-2022-22.23.4](https://github.com/writerslogic/scrivener-mcp/actions/runs/41247863036/artifacts/13060271264)  | 3218      | `7a1213099d70e3b197e7cdb0aaa2854bed331b36a88c7854ac8e1dcea1705562` |
| [c2pa-ubuntu-latest-22.23.4](https://github.com/writerslogic/scrivener-mcp/actions/runs/41247863036/artifacts/13059992237) | 3217      | `dade1627ef9a79a95dea4f9d9b866a0fb9461cdbe958d955432ad9c41f45ce45` |
| [container-linux-amd64](https://github.com/writerslogic/scrivener-mcp/actions/runs/41247863036/artifacts/13059857945)      | 2753      | `dc3e19b05494a122c44297bd4de52a00f6d9a2a0186eb668793acd7f55df1688` |
| [c2pa-ubuntu-latest-24.x](https://github.com/writerslogic/scrivener-mcp/actions/runs/41247863036/artifacts/13059857437)    | 3219      | `8fc63d1f97fe51671f2715a8a81f59544514fc5c187ea5ee8ad11b2ea11242a8` |
| [c2pa-windows-latest-24.x](https://github.com/writerslogic/scrivener-mcp/actions/runs/41247863036/artifacts/13059732974)   | 3219      | `64cc6e268c842c01446eff5478bbec96e0edbe265e3f1ad87c5eae5a1b30b5d8` |
| [c2pa-supply-chain](https://github.com/writerslogic/scrivener-mcp/actions/runs/41247863036/artifacts/13059663523)          | 923055    | `947e392668e970a88ab28d18864422df8e25b679f7f5486e3cd2a46d4a2b2ba9` |

Durable local evidence is under
`logs/production-readiness-remote-ci-20261031/run-41247863036-attempt-1/` in the original checkout:
raw run/jobs/artifacts metadata, full job logs, ZIPs and extracted records, `verification.json`, and
`audit-acceptance.json`. Parent-directory verification scripts reproduce the archive/source checks.
`novels-candidate-3ba6846-{profile,summary}.json` and its log preserve workload measurements; prior
failed runs and profiles remain beside them.

Requested run 41244515251 at 9b1647c failed all eight installed-consumer audits after passing full
tests. Dependency correction run 41246536667 at 3ba6846 exposed the cancellation-fixture race and
new-version EJS applicability review. Both failures remain evidence; the passing result above is the
later exact candidate, not a relabeling or retry of those attempts.

Comparative editorial accuracy, optional model-dependent paths, every third-party MCP host,
independent native RSS containment and external C2PA certification remain unverified. No numeric
quality score or superiority claim is assigned. Local validation used sequential individual suites;
global builds and the full matrix ran only remotely. No paid development API calls were used. The
original dirty main checkout, its unpublished ledger checkpoint and index remain preserved;
`original-checkout-preservation.json` records preservation of 205 reviewed paths, including expected
deletions, plus the original index hash.
