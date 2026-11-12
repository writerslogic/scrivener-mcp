# Editorial quality corpus, version 2

Six fixed literary excerpts from three public-domain novels, with original CC0 test mutations and
explicit expected labels. The publisher catalogues for
[Frankenstein](https://www.gutenberg.org/ebooks/84),
[Pride and Prejudice](https://www.gutenberg.org/ebooks/1342), and
[Moby Dick](https://www.gutenberg.org/ebooks/2701) identify the works as public domain in the USA.
Distributor terms are retained in GUTENBERG-LICENSE.txt. Full-source hashes match the existing
narrative-novels.json catalogue; excerpt hashes and exact extraction offsets are in excerpts.json.
No private manuscript or paid model is used.

`npm run benchmark:editorial -- --baseline docs/benchmarks/editorial-quality-baseline.json --output logs/editorial-quality.json`
runs after `npm run build`, offline. The corpus, labels, runner version, implementation commit,
runtime, individual predictions and aggregate counts are included or fingerprinted in the report.
Repeating the run uses the same inputs; timestamps, temporary paths and elapsed time are not scoring
inputs.

Natural excerpts are annotated only for explicit eye/hair color and birth-year contradictions, not
for all possible literary problems. Mutations are original test material appended to each excerpt,
not defects attributed to the original authors. Positive labels mean a candidate conflict deserves
review, not confirmed canon. The challenge split includes alternate attribute syntax and
coreference; the extractor supports alternate attribute syntax and bounded adjacent-sentence
coreference. Unsupported references remain unclassified, and any missed labeled conflicts count as
false negatives in overall recall. Do not describe the suite as a representative or independently
human-validated quality estimate.

The runner also checks source quotation validity, author-recorded dependency impacts, real RTF
formatting preservation, selective revision decisions, stale-write rejection, and byte-exact undo.
These are integrity checks, reported separately from editorial detection accuracy. Human preference
and editorial usefulness are explicitly unmeasured: no preference score can be inferred from passing
tests. A future preference study needs consented manuscripts, blinded alternatives, multiple
independent readers and retained individual judgments.

For changes to labels: document the textual reason in cases.json, review without consulting
predictions, and increment the corpus version in the runner. Do not lower thresholds or remove
challenge cases to make a change pass. This small public development set is not a hidden test set.

All original annotations and injected test sentences in cases.json are dedicated to the public
domain under CC0 1.0: https://creativecommons.org/publicdomain/zero/1.0/ . Literary excerpts retain
their provenance above.

The [checked-in baseline](../../../docs/benchmarks/editorial-quality-baseline.json) records 54
cases: 10 true positives, 14 false negatives, no false positives, and 30 true negatives.
Explicit-pattern recall is 10/12; challenge recall is 0/12. Two explicit cases are suppressed by
nearby quoted context. The regression floor is 0.8 recall on the explicit split with zero false
positives on natural and negative splits; challenge failures remain reported, not waived from
overall recall (10/24). Nine separate integrity tasks pass. These measurements describe only this
corpus and implementation fingerprint.

## Follow-up comparison

The original report is preserved unchanged. Version 1 inputs are archived in `cases-v1.json`;
version 2 retains every original case and adds long quoted speech, negated claims, conditional
claims, different people, ambiguous pronouns and inverted hair-attribute syntax. The
[current report](../../../docs/benchmarks/editorial-quality-current.json) includes 90 cases, with 30
true positives, no false negatives, no false positives and 60 true negatives. On the original 54
matched cases alone, recall rises from 10/24 (41.7%) to 24/24 (100%); expanded-corpus recall is
30/30 (100%). These are development-set measurements, not independent evidence of general narrative
understanding.

`--baseline` checks that excerpts, original inputs and annotations have not changed before
calculating paired results; later schema-2 reports also compare per-case input fingerprints. It
reports added cases separately, so expanding the corpus cannot silently improve the original-case
score. The six previously missed pronoun cases now resolve the named subject of the immediately
preceding standalone action sentence. Both sentences are retained as source evidence. Supported
actions include approaching, arriving, entering, departing, smiling, nodding, pausing, waiting,
standing, sitting and stepping forward/back/aside. Singular `Her`/`His` attributes and `She`/`He`
birth-year statements are supported; this is a conservative grammar, not general coreference.
Multiple subjects, objects, intervening sentences, paragraph breaks and unsupported wording remain
unresolved. No gender is inferred from a name, and candidates still require author review. Quote
tracking spans long and continued dialogue, while paragraph boundaries prevent an unrelated
preceding quotation from suppressing later narration. Paragraphs with uncertainty, negation or
question cues remain conservative candidates.

## Verification

On macOS arm64 with Node 24.22.1, the final complete coverage run passed 3,044 tests with 12 skipped
using `npm run test:coverage -- --runInBand`; coverage thresholds passed. Default parallel execution
encountered the previously observed protocol-discovery and shutdown timeouts and was stopped.
Sequential execution passed with the original timeout limits; this does not establish that parallel
timing sensitivity is fixed.

Build, lint and touched-file formatting checks passed. Tests cover frozen-input and baseline
validation, injected missing findings, fabricated quotations, wrong-owner findings, source offsets,
initialed and Unicode names, uncertainty, line/paragraph boundaries, intentional changes, and
candidate counts at 255, 256 and 257. The original 90-case benchmark still passes with 30 true
positives, no false positives or false negatives, and all nine integrity checks passing. CI rejects
any worsened matched-case TP/FP/FN count on either corpus.

## Frozen scenario evaluation

`evaluation-v1.json` contains 36 new, original CC0 scenarios, with labels and written rationales
fixed before running predictions; `evaluation-v1.sha256` freezes the exact bytes. These are
agent-authored synthetic examples, **not independently human-validated manuscript annotations**. The
same agent authored both splits and implemented the fixes, so the reserved split is not blind to the
implementer. It is a small transfer check, not an unbiased estimate of real-world accuracy. The
original 90-case benchmark and its labels remain unchanged.

The 24 development scenarios cover dialogue, multiple characters, confirmed and uncertain aliases,
flashbacks, immutable birth dates, intentional changes, Unicode names, paraphrases, and ambiguous
references. Twelve additional scenarios were reserved from prediction-driven tuning until after
production changes and focused tests passed. Their first result is preserved in
[the holdout report](../../../docs/benchmarks/editorial-evaluation-holdout.json). Once evaluated,
they become regression cases; future tuning requires a newly authored, independently reviewed set
for a fresh held-out claim. Labels are never revised merely to agree with predictions.

After building, reproduce the paired development comparison:

```sh
npm run evaluate:editorial -- --baseline docs/benchmarks/editorial-evaluation-baseline.json --output logs/editorial-development.json
```

Reproduce all 36 cases and enforce the recorded per-case regression floor:

```sh
npm run evaluate:editorial -- --split all --baseline docs/benchmarks/editorial-evaluation-current.json --output logs/editorial-evaluation.json
```

The runner defaults to `development`; `--split holdout` selects only the reserved cases. Each case
gets an isolated store. Author-recorded aliases receive a generated source sentence of the form
“Leila is also known as Lark.” and the requested confirmation status; identity is not guessed from
names. A true positive must match the annotated subject, attribute and both source regions;
unrelated findings cannot fill a missing correct finding. Every emitted quotation is verified
against the exact document revision. False positives, false negatives, category counts, per-case
fingerprints, implementation hashes and source evidence are retained. Changed corpora, labels, case
selections, duplicate baseline IDs and invalid counts reject comparison. Any per-case regression
fails the CI step even if aggregate accuracy improves. The same existing Linux job runs both suites
offline, with no additional workflow, paid API or model calls.

| Evaluation                                     | True positives | False positives | False negatives | True negatives | Recall |
| ---------------------------------------------- | -------------: | --------------: | --------------: | -------------: | -----: |
| Development before fixes                       |              6 |               2 |               5 |             11 |  54.5% |
| Development after first tuning                 |             10 |               0 |               1 |             13 |  90.9% |
| Reserved split, first evaluation               |              5 |               0 |               1 |              6 |  83.3% |
| All scenarios before object-rule extension     |             15 |               0 |               2 |             19 |  88.2% |
| Former reserved split after object-rule tuning |              6 |               0 |               0 |              6 |   100% |
| All cases after object-rule tuning             |             17 |               0 |               0 |             19 |   100% |

The first evaluation missed a named subject acting on an inanimate object before a possessive
pronoun. That result remains preserved. After the user authorized further improvement, both misses
were addressed; the final 36-case result is 17 true positives, zero false positives or false
negatives, and 19 true negatives. The former reserved split is now **6/6 post-tuning regression
coverage**, not an untouched generalization score. No labels or scenarios changed. Compare the
[pre-coreference report](../../../docs/benchmarks/editorial-evaluation-before-coreference.json) with
the [current report](../../../docs/benchmarks/editorial-evaluation-current.json). Explicitly
ambiguous negatives follow an abstention policy, not a claim that their implied stories are
necessarily consistent. Precision is 100% **on this small set only**. The six positive reserved
cases cannot establish general narrative reliability. A subsequent compatibility check restored
support for initialed names without allowing names to span sentence boundaries; rescoring left these
totals unchanged. The first reserved-split report is preserved separately from the final
implementation report.

Independent validation remains outstanding. `evaluation-review-template.json` supplies texts and
author-recorded aliases without reference labels or predictions, with blank judgment/evidence
fields. A human reviewer should receive that template alone, independently record expected
subject/attribute/evidence pairs or abstention with reasons, and retain their original judgments. A
second reviewer should adjudicate disagreements before running the detector. Any revised labels
belong to a new version; preserve these reports. Real manuscript evaluation additionally needs
consent and source provenance. No independent review, human preference study or unseen real
manuscript test is claimed here.

## General object-reference rule

The extension uses the existing Compromise tagger to recognize a single named subject followed by
one finite verb and a simple determiner/modifier/noun object. The subsequent singular possessive or
birth-year sentence must be adjacent in the same paragraph. Both sentences remain cited evidence;
uncertainty, quotations, story-time annotations and author-declared exceptions retain their normal
behavior. The rule does not name any benchmark character, verb or object.

Object classification comes from [Princeton WordNet 3.1](https://wordnet.princeton.edu/), generated
from the [official archive](https://wordnetcode.princeton.edu/wn3.1.dict.tar.gz) with SHA-256
`3f7d8be8ef6ecc7167d39b10d66954ec734280b5bdcd57f7d9eafe429d11c22a`. Every recorded noun sense must
exclude living entities, agents, collectives and bodily/person depictions. The generator also
excludes self-moving automata. Unknown words abstain. Material nouns may modify an object, but that
does not relax the head noun's checks. The generated vocabulary has 29,030 nonpersonal forms and
14,180 ambiguous forms; plural normalization is accepted only when it reaches a known nonpersonal
noun. The original license is included in the generated source and compiled distribution.

To reproduce the vocabulary after downloading that archive:

```sh
node scripts/generate-continuity-nouns.mjs --archive /path/to/wn3.1.dict.tar.gz --check
```

The checked-in generated module ships with the package. Runtime analysis and CI need no download,
new npm dependency, model inference or paid service. Parser input is capped at 160 characters and
eight terms; each document permits at most 256 object-reference attempts, including rejected
attempts. Repeated predicates reuse a per-document classification cache.

Regression tests vary names, verbs, materials, objects, number and source offsets. Counterexamples
include people, animals, dolls, statues, portraits, robots, unknown nouns, additional clauses and
paragraph changes. These are development tests, not another held-out set. Dictionary coverage and
fictional personification still limit the method: for example, “wooden cabinet” deliberately
abstains because _cabinet_ also names a governing group. Such abstention can miss real conflicts; we
do not infer that an unresolved reference is consistent. This extension reduces reliance on
sentence-specific patterns, but its perfect score on these small reused cases is not evidence of
perfect coreference on unfamiliar manuscripts.
