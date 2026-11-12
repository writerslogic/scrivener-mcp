# Performance and retention evidence for 0.14

The measured safety and quota checks pass. The existing latency, event-loop and memory
objectives do not all pass, including at smaller sizes. No throughput improvement,
latency guarantee, p95 estimate or general memory-containment claim follows from this data.

## Measurement identity

Measurements used Node 26.12.1, Darwin 27.0.0 arm64, Apple M4 (10 logical CPUs, 32 GiB RAM),
installed Warm 0.6.4 and no paid provider or downloaded model. All 229 measured production
source hashes match commit `64709ea6682e8149face2c85f849b8cdce96a157`; the original receipts
retain their pre-commit baseline revision and full source manifest. Later snapshot-force
option forwarding affects two source files outside these measured paths. Observer formatting
also followed measurement; recorded harness hashes remain the identities of the executed code.
Final release CI checks the integrated source separately.

[Raw receipts and summaries](benchmarks/scale-0.14/README.md) include failures, individual
samples, corpus/source hashes, process observations and declared budgets. Project fixtures
were disposable original/CC0 prose or the pinned public-domain Gutenberg corpus. No private
manuscript or client configuration was used.

## Passage scale

The direct-service fixture expands the existing CC0 passage corpus to 1,000, 10,000 or 50,000
passages (900 UTF-16 units per passage, 10 per document). The largest source is 45,090,000
UTF-16 units across 5,000 documents. Searches use supplied 30-dimensional story-concept
embeddings and unique markers; this measures scale and exact citations, not ranking quality
or the MCP transport. Each mode/size has five trials and four phases.

Cold means a fresh fixture, SQLite catalog, source cache and engine, not OS-cold disk.
Reopen preserves SQLite and discards source/engine caches. Trials share a Node process
without forced GC. The edit preserves source size and timestamp, and the old marker must
disappear. All 120 completed phases verified exact revision, quote/context offsets and line
coordinates. Both 50,000-passage modes also accepted 49,999 and 50,000, refused 50,001 without
changing the catalog, and recovered after returning within bounds. No new child identities
survived close. These checks do not prove general cancellation containment.

Median phase time in milliseconds (five samples each):

| Mode / passages | Cold | Warm | Same-size edit | Reopen |
| --- | ---: | ---: | ---: | ---: |
| fallback / 1,000 | 293.6 | 40.1 | 44.2 | 177.5 |
| fallback / 10,000 | 2,811.9 | 293.8 | 269.1 | 1,809.3 |
| fallback / 50,000 | 9,228.1 | 4,758.3 | 4,633.2 | 6,208.3 |
| native / 1,000 | 278.4 | 25.8 | 98.4 | 118.9 |
| native / 10,000 | 4,064.5 | 155.9 | 1,653.2 | 1,264.6 |
| native / 50,000 | 16,108.6 | 4,176.2 | 9,780.2 | 4,479.3 |

Budgets remain 5 seconds elapsed, 100 ms event-loop lag, 128 MiB parent RSS growth and 2 GiB
sampled process-tree RSS. Every cohort exceeded at least one budget. At 1,000 passages,
fallback/native had 5/4 event-loop breaches; at 10,000 they had 20/10 lag breaches and 3 RSS-growth
breaches each. At 50,000, fallback had 11 elapsed/20 lag/10 growth/19 tree breaches and native
had 10/20/14/19, across 20 phases each. Maximum observed tree RSS was 3,577,151,488 bytes
fallback and 3,884,924,928 native; maximum lag was 6,614 ms and 5,903 ms respectively. Explicit
source/index caps therefore do not establish memory containment.

Parent RSS includes in-process native allocations; V8 fields and child RSS/CPU are reported
separately. Sampling every 5 ms (parent) / 100 ms (tree) can miss peaks. Process-inventory overhead
is included in elapsed/parent CPU; the ps observer is excluded from tree totals. Closed RSS
without forced GC cannot distinguish retained references from garbage or native caches.
The next performance investigation is allocation/CPU profiling of cold, warm and reopen
paths while preserving same-size/mtime edit detection and exact citations.

Earlier 50,000-passage attempts failed resource observation and remain included. One defect
parsed incomplete metrics from unrelated exiting processes; another reproduced a 2 second
ps timeout losing stdout while the measured event loop stalled. The observer now selects
descendants first and has a 30 second deadline. Missing selected-process data still fails.
Only the affected 50,000 cohorts were repeated; no workload budget changed.

## Mutation history and reserved undo

One 10,000-edit trial covered 32 documents of 16,000 characters, with a native snapshot per
edit. Actual reservations were 937,838,592 bytes/20,000 slots under the 1 GiB/20,000 defaults.
Reopen preserved every saved byte and the earliest receipt; retry added no duplicate.
A new edit at capacity refused without changing saved content or receipt count. The
reserved inverse restored its exact before-image and replay remained idempotent. Reserved
bytes/slots stayed unchanged while receipt entries became 10,001.

Receipt JSON totalled 348,605,004 bytes. Closed project storage was 539,169,081 logical bytes
and 592,683,008 allocated bytes. The policy does not bound snapshots, journal overhead,
WAL, native memory or total project disk; it preserves history rather than silently purging it.
The edit loop took 499.801 seconds, with 203,751,424 bytes sampled parent peak and 116.696 ms
maximum lag (above the 100 ms objective). A concurrent roughly 10 second source-hashing read
was recorded, so this run is quota/recovery evidence, not isolated comparative timing.

## Public stdio novel workload

The earlier unpaced 1 MiB-page workload completed 34 of 45 phases and missed rate/RSS objectives;
[its receipt](benchmarks/scale-0.14/quality-mission-agent-novel-stdio-default.json) remains
separate from the explicitly paced scenario. Pacing waits successful phase calls divided
by 2 calls/second, capped at 20 seconds. Pauses are outside phase times but inside workload
wall times; the final phase has no pause. This is not a throughput fix.

Five cold/warm/edit samples completed for Frankenstein, Pride and Prejudice and Moby-Dick,
conditional on successful startup. Moby completed in the original paced run; the first two
novels timed out during initialize at 30 seconds with empty stderr and no pre-cleanup exit
state recorded. One separate-process retry per missing corpus completed at unchanged
timeouts/budgets. The startup cause remains unknown; retries do not establish reliability.
Add bounded child-entry/import/transport/initialize/exit timestamps before further fresh-process
startup trials.

The 45 completed phases had zero rate retries. Two Moby first-sample phases exceeded 128 MiB
RSS growth (141,721,600 and 170,508,288 bytes); the other completed phases met the existing
objectives. Actual pauses/wall time were 43.528/49.741 seconds for Frankenstein, 64.026/71.789
for Pride and 162.522/188.233 for Moby. Individual phase medians and raw values are in the
[novel summary](benchmarks/scale-0.14/quality-mission-agent-novel-paced-summary.json).
