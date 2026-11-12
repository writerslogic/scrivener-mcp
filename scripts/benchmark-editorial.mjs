import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PersistentStore } from '../dist/services/editorial/persistent-store.js';
import { SeriesBible } from '../dist/services/editorial/series-bible.js';
import { ContinuityService } from '../dist/services/editorial/continuity-service.js';
import { evaluateChangeImpact } from '../dist/services/editorial/change-impact.js';
import { sourcePassage, verifyPassage } from '../dist/services/editorial/provenance.js';
import { DocumentManager } from '../dist/services/document-manager.js';
import { ProjectWriter } from '../dist/services/project-writer.js';
import { ReviewService } from '../dist/services/editorial/review-service.js';
import { RTFHandler } from '../dist/services/parsers/rtf-handler.js';

const { values: args } = parseArgs({
	options: { output: { type: 'string' }, baseline: { type: 'string' } },
	strict: true,
});
if (args.output && args.baseline && resolve(args.output) === resolve(args.baseline))
	throw new Error('Comparison output must not overwrite its baseline');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const repository = fileURLToPath(new URL('../', import.meta.url));
const fixtures = new URL('../tests/fixtures/editorial-quality/', import.meta.url);
const excerptBytes = await readFile(new URL('excerpts.json', fixtures));
const caseBytes = await readFile(new URL('cases.json', fixtures));
const excerpts = JSON.parse(excerptBytes);
const cases = JSON.parse(caseBytes);
const projectId = '11111111-1111-4111-8111-111111111111';
const id = (index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
const doc = (text, order, metadata = {}) => ({
	projectId,
	documentId: id(order),
	title: `Benchmark scene ${order}`,
	path: `Draft/${order}`,
	revision: hash(text),
	text,
	order,
	metadata,
});
const root = await mkdtemp(join(tmpdir(), 'editorial-quality-'));
const predictions = [],
	integrity = [];
let evidenceChecked = 0;
try {
	for (const excerpt of excerpts) {
		assert.equal(hash(excerpt.text), excerpt.sha256, `Corpus changed: ${excerpt.id}`);
		for (const scenario of [
			{
				id: 'natural',
				split: 'natural',
				expectedConflicts: excerpt.annotation.expectedConflicts,
			},
			...cases,
		]) {
			const key = `${excerpt.id}/${scenario.id}`;
			const directory = join(root, key);
			const store = new PersistentStore(join(directory, 'editorial.sqlite'));
			try {
				// Original prose stays unchanged. Mutations are separate scene-end paragraphs.
				const documents =
					scenario.id === 'natural'
						? [doc(excerpt.text, 0)]
						: [
								doc(`${excerpt.text}\n\n${scenario.left}`, 0),
								doc(
									`${excerpt.text}\n\n${scenario.right}`,
									1,
									scenario.rightMetadata
								),
							];
				const source = {
					projectId,
					projectPath: directory,
					list: async () => documents,
					read: async (documentId) => {
						const found = documents.find((item) => item.documentId === documentId);
						assert(found);
						return found;
					},
				};
				const bible = new SeriesBible(source, store);
				const report = await new ContinuityService(source, store, bible).analyze();
				for (const finding of report.issues)
					for (const passage of finding.evidence) {
						verifyPassage(await source.read(passage.documentId), passage);
						evidenceChecked++;
					}
				// Match the annotated conflict by both source excerpts, not just a count.
				const matched = scenario.expectedConflicts
					? report.issues.filter(
							(item) =>
								item.evidence.some(
									(p) => p.documentId === id(0) && scenario.left.includes(p.quote)
								) &&
								item.evidence.some(
									(p) =>
										p.documentId === id(1) && scenario.right.includes(p.quote)
								)
						)
					: [];
				const tp = Math.min(scenario.expectedConflicts, matched.length);
				predictions.push({
					id: key,
					inputSha256: hash(
						JSON.stringify({
							documents: documents.map(({ text, metadata }) => ({ text, metadata })),
							expected: scenario.expectedConflicts,
						})
					),
					split: scenario.split,
					expected: scenario.expectedConflicts,
					actual: report.issues.length,
					tp,
					fp: report.issues.length - tp,
					fn: scenario.expectedConflicts - tp,
					findings: report.issues.map((item) => ({
						description: item.description,
						confidence: item.confidence,
						evidence: item.evidence.map((p) => ({
							documentId: p.documentId,
							start: p.start,
							end: p.end,
							quote: p.quote,
							revision: p.revision,
						})),
					})),
				});
			} finally {
				store.close();
			}
		}
		const documents = [
			doc(excerpt.text, 0),
			doc('The consequence follows the prerequisite.', 1),
		];
		const dependency = {
			id: hash(excerpt.id),
			kind: 'causal',
			explanation: 'Annotated benchmark prerequisite',
			prerequisite: sourcePassage(documents[0], 0, 30),
			dependent: sourcePassage(documents[1], 0, 30),
		};
		const request = { documentId: id(0), expectedRevision: documents[0].revision };
		const removed = evaluateChangeImpact(documents, [], [], [dependency], {
			...request,
			kind: 'remove',
		});
		assert.deepEqual(
			removed.impacts.map((item) => item.kind),
			['dependency']
		);
		const moved = evaluateChangeImpact(documents, [], [], [dependency], {
			...request,
			kind: 'move',
			beforeDocumentId: null,
		});
		assert.deepEqual(
			moved.impacts.map((item) => item.kind),
			['order']
		);
		const unchanged = evaluateChangeImpact(documents, [], [], [dependency], {
			...request,
			kind: 'replace',
			replacementText: excerpt.text,
		});
		assert.equal(unchanged.total, 0);
		integrity.push({ id: `${excerpt.id}/impact`, removal: true, move: true, unchanged: true });
	}
	for (const excerpt of excerpts.filter((item) => item.id.endsWith('-1'))) {
		const directory = join(root, `revision-${excerpt.id}`);
		const file = join(directory, 'Files', 'Data', id(0), 'content.rtf');
		await mkdir(dirname(file), { recursive: true });
		const rtf = new RTFHandler();
		const opening = excerpt.text.match(/[A-Za-z]+/)[0];
		const bold = `{\\b ${opening}}`;
		const raw = rtf.convertToRTF(excerpt.text).replace(opening, bold);
		await writeFile(file, raw);
		await writeFile(join(directory, 'Files', 'Data', 'docs.checksum'), '');
		const documents = new DocumentManager(directory);
		const writer = new ProjectWriter(
			directory,
			documents,
			undefined,
			() => {},
			async () => ({ document: null, path: [], metadata: {}, location: 'unknown' }),
			false
		);
		const store = new PersistentStore(join(directory, '.scrivener-mcp', 'editorial.sqlite'));
		try {
			const reviews = new ReviewService(documents, writer, store);
			const before = await documents.readDocument(id(0));
			const proposal = await reviews.propose({
				documentId: id(0),
				expectedRevision: hash(raw),
				category: 'clarity',
				rationale: 'Controlled integrity task, not a literary recommendation',
				edits: [
					{ start: before.length, end: before.length, text: '\nAn annotated coda.' },
					{ start: before.length - 1, end: before.length, text: '!' },
				],
			});
			const preview = await reviews.preview(proposal.id, [proposal.edits[0].id]);
			assert.equal(await readFile(file, 'utf8'), raw);
			assert.deepEqual(preview.fidelity.atRisk, []);
			await reviews.reject(proposal.id, [proposal.edits[1].id]);
			const application = await reviews.apply(proposal.id, {
				editIds: [proposal.edits[0].id],
				force: true,
			});
			assert((await readFile(file, 'utf8')).includes(bold));
			assert.equal(await documents.readDocument(id(0)), `${before}\nAn annotated coda.`);
			assert.deepEqual(reviews.inbox({ status: 'all' }).totals, {
				proposals: 1,
				accepted: 1,
				rejected: 1,
				pending: 0,
			});
			await assert.rejects(
				reviews.propose({
					documentId: id(0),
					expectedRevision: hash(raw),
					edits: [{ start: 0, end: 1, text: 'X' }],
				}),
				/revision|changed|stale/i
			);
			await reviews.undo(application.id, { force: true });
			assert.equal(await readFile(file, 'utf8'), raw);
			integrity.push({
				id: `${excerpt.id}/revision`,
				previewUnchanged: true,
				formattingPreserved: true,
				selectiveDecision: true,
				staleRejected: true,
				exactUndo: true,
			});
		} finally {
			await documents.close();
			store.close();
		}
	}
	const summarize = (rows) => {
		const counts = rows.reduce(
			(acc, row) => ({
				tp: acc.tp + row.tp,
				fp: acc.fp + row.fp,
				fn: acc.fn + row.fn,
				tn: acc.tn + Number(!row.expected && !row.actual),
			}),
			{ tp: 0, fp: 0, fn: 0, tn: 0 }
		);
		return {
			...counts,
			cases: rows.length,
			precision: counts.tp + counts.fp ? counts.tp / (counts.tp + counts.fp) : null,
			recall: counts.tp + counts.fn ? counts.tp / (counts.tp + counts.fn) : null,
			falsePositiveCaseRate: rows.filter((row) => !row.expected).length
				? rows.filter((row) => !row.expected && row.actual).length /
					rows.filter((row) => !row.expected).length
				: null,
		};
	};
	const splits = Object.fromEntries(
		['natural', 'explicit', 'negative', 'challenge'].map((split) => [
			split,
			summarize(predictions.filter((row) => row.split === split)),
		])
	);
	const thresholds = {
		naturalFalsePositives: 0,
		negativeFalsePositives: 0,
		explicitMinimumRecall: 0.8,
	};
	let passed =
		splits.natural.fp === 0 &&
		splits.negative.fp === 0 &&
		splits.explicit.recall >= thresholds.explicitMinimumRecall;
	const report = {
		schemaVersion: 2,
		corpusVersion: 2,
		implementation: {
			commit: execFileSync('git', ['rev-parse', 'HEAD'], {
				cwd: repository,
				encoding: 'utf8',
			}).trim(),
			workingTreeDirty: !!execFileSync('git', ['status', '--porcelain'], {
				cwd: repository,
				encoding: 'utf8',
			}).trim(),
			builtModules: Object.fromEntries(
				await Promise.all(
					[
						'editorial/continuity-service',
						'editorial/object-coreference',
						'editorial/continuity-nouns',
						'editorial/change-impact',
						'editorial/review-service',
						'editorial/persistent-store',
						'editorial/series-bible',
						'parsers/rtf-handler',
						'project-writer',
						'document-manager',
					].map(async (name) => [
						name,
						hash(
							await readFile(new URL(`../dist/services/${name}.js`, import.meta.url))
						),
					])
				)
			),
			runnerSha256: hash(await readFile(fileURLToPath(import.meta.url))),
			node: process.version,
			platform: `${process.platform}-${process.arch}`,
		},
		corpus: {
			excerptsSha256: hash(excerptBytes),
			casesSha256: hash(caseBytes),
			excerpts: excerpts.length,
			books: new Set(excerpts.map((item) => item.book)).size,
			provenance: excerpts.map(({ text: _text, ...item }) => item),
		},
		overall: summarize(predictions),
		splits,
		evidenceChecked,
		integrity,
		humanPreference: { status: 'unmeasured', judgments: 0 },
		thresholds,
		passed,
		limitations:
			'Small public development corpus; annotations are not independently human validated. Natural prose and injected mutations are reported separately. Challenge misses count toward overall recall. Integrity checks are not editorial preference judgments. No network or model calls.',
		predictions,
	};

	if (args.baseline) {
		const baseline = JSON.parse(await readFile(resolve(args.baseline), 'utf8'));
		assert([1, 2].includes(baseline.schemaVersion), 'Unsupported baseline schema');
		assert(
			Array.isArray(baseline.predictions) && baseline.predictions.length,
			'Baseline predictions are required'
		);
		assert.equal(
			new Set(baseline.predictions.map((row) => row.id)).size,
			baseline.predictions.length,
			'Duplicate baseline cases'
		);
		for (const row of baseline.predictions) {
			assert(
				[row.expected, row.actual, row.tp, row.fp, row.fn].every(
					(value) => Number.isSafeInteger(value) && value >= 0
				),
				'Invalid baseline counts'
			);
			assert.equal(row.expected, row.tp + row.fn, 'Inconsistent baseline labels');
			assert.equal(row.actual, row.tp + row.fp, 'Inconsistent baseline predictions');
		}
		assert.equal(
			baseline.corpus.excerptsSha256,
			hash(excerptBytes),
			'Paired comparison requires unchanged literary excerpts'
		);
		const currentById = new Map(predictions.map((row) => [row.id, row]));
		if (baseline.schemaVersion === 1) {
			const archivedBytes = await readFile(new URL('cases-v1.json', fixtures));
			assert.equal(
				hash(archivedBytes),
				baseline.corpus.casesSha256,
				'Baseline labels must match the archived version-1 corpus'
			);
			for (const prior of JSON.parse(archivedBytes))
				assert.deepEqual(
					cases.find((item) => item.id === prior.id),
					prior,
					'Original benchmark input or annotation changed'
				);
		}
		const paired = baseline.predictions.map((prior) => {
			const current = currentById.get(prior.id);
			assert(current, `Baseline case was removed: ${prior.id}`);
			assert.equal(current.expected, prior.expected, 'Cannot compare changed annotations');
			if (baseline.schemaVersion !== 1)
				assert.equal(
					current.inputSha256,
					prior.inputSha256,
					'Cannot compare changed inputs'
				);
			return current;
		});
		const previousById = new Map(baseline.predictions.map((row) => [row.id, row]));
		const regressions = paired
			.filter((row) => {
				const prior = previousById.get(row.id);
				return row.tp < prior.tp || row.fp > prior.fp || row.fn > prior.fn;
			})
			.map((row) => row.id);
		passed = passed && regressions.length === 0;
		report.passed = passed;
		report.comparison = {
			regressions,
			baseline: baseline.implementation,
			pairedCases: paired.length,
			addedCases: predictions.length - paired.length,
			before: summarize(baseline.predictions),
			after: summarize(paired),
			changed: paired
				.filter((row) => {
					const prior = previousById.get(row.id);
					return prior.tp !== row.tp || prior.fp !== row.fp || prior.fn !== row.fn;
				})
				.map((row) => row.id),
		};
	}
	const json = `${JSON.stringify(report, null, 2)}\n`;
	if (args.output) {
		const output = resolve(args.output);
		await mkdir(dirname(output), { recursive: true });
		await writeFile(output, json);
	}
	process.stdout.write(
		`${JSON.stringify({ passed, overall: report.overall, splits, comparison: report.comparison, evidenceChecked, integrityTasks: integrity.length, humanPreference: report.humanPreference, ...(args.output ? { output: resolve(args.output) } : {}) }, null, 2)}\n`
	);
	if (!passed) process.exitCode = 1;
} finally {
	await rm(root, { recursive: true, force: true });
}
