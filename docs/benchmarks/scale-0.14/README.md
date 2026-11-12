# Scale measurement receipts

These are immutable copies of the measured data described in
[Performance and retention evidence](../../performance-0.14.md). Filenames retain the
original runner labels; a name ending in `final` does not mean that run passed.

- [Passage summary](quality-mission-agent-passage-summary.json) identifies the six complete
  cohorts by filename and SHA-256, with five samples per phase, medians and failed budgets.
  The complete 50,000-passage cohorts use the `observer30s` filenames. Earlier `final` and
  `corrected` attempts retain the instrument failures.
- [Mutation receipt](quality-mission-agent-mutation-10000-candidate.json) retains all
  10,000 edit observations, quota reservations, saved-byte/replay/undo checks and disk use.
  [Concurrent activity](quality-mission-agent-final-run-concurrency.json) limits timing claims.
- [Paced novel summary](quality-mission-agent-novel-paced-summary.json) links its three inputs
  by SHA-256 and retains the initial startup failures. The [unpaced run](quality-mission-agent-novel-stdio-default.json)
  is a separate failed workload, not replaced by paced results.
- [Source manifest](quality-mission-agent-passage-source-manifest.json), individual report
  manifests, runner command records and [observer reproduction](quality-mission-agent-process-observer-timeout-reproduction.json)
  identify the inputs and instrumentation changes. Local logs remain retained separately;
  the JSON reports contain no novel bodies, private manuscripts or credentials.

Reproduce from a supported runtime with installed dependencies, paused competing builds
and disposable fixtures. The passage and mutation scripts create their own projects and
refuse an existing output file. Repeat passage measurements for `1000`, `10000`, `50000`
and both `fallback` and already-installed `native` engines. Budget failures produce a
nonzero exit status and remain in the report.

```sh
node --import tsx scripts/benchmark-passage-scale.ts --passages 1000 --samples 5 --engine fallback --output logs/passage-fallback-1000.json
node --import tsx scripts/benchmark-mutation-history.ts --edits 10000 --documents 32 --characters 16000 --output logs/mutation-10000.json
```

The novel corpus directory must contain files matching
[`narrative-novels.json`](../../../tests/fixtures/narrative-novels.json), including its
hashes and licensed source provenance. Set the actual directory below; use a fresh output
path and an isolated environment without provider credentials.

```sh
SCRIVENER_NOVEL_CORPUS=/path/to/pinned-novels \
SCRIVENER_NOVEL_SAMPLES=5 SCRIVENER_NOVEL_PAGE_BYTES=1048576 \
SCRIVENER_NOVEL_PACED=1 SCRIVENER_NOVEL_RETRY_RATE_LIMITS=1 \
SCRIVENER_NOVEL_STDIO_REPORT="$PWD/logs/novels-paced.json" \
npm test -- --config jest.narrative-performance.config.js --runInBand --testMatch '**/integration/narrative-novels-stdio.test.ts'
```

Five samples do not establish tail percentiles, general startup reliability, editorial
accuracy or memory containment. No paid provider or model download was used in these runs.
