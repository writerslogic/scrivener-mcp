import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PersistentStore } from '../dist/services/editorial/persistent-store.js';
import { SeriesBible } from '../dist/services/editorial/series-bible.js';
import { ContinuityService } from '../dist/services/editorial/continuity-service.js';
import { sourcePassage, verifyPassage } from '../dist/services/editorial/provenance.js';

const { values: args } = parseArgs({
	options: {
		split: { type: 'string', default: 'development' },
		output: { type: 'string' },
		baseline: { type: 'string' },
	},
	strict: true,
});
assert(['development', 'holdout', 'all'].includes(args.split), 'Invalid evaluation split');
assert(
	!args.output || !args.baseline || resolve(args.output) !== resolve(args.baseline),
	'Output must not overwrite baseline'
);
const repository = fileURLToPath(new URL('../', import.meta.url));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const bytes = await readFile(
	new URL('../tests/fixtures/editorial-quality/evaluation-v1.json', import.meta.url)
);
const fingerprint = hash(bytes);
assert.equal(
	fingerprint,
	(
		await readFile(
			new URL('../tests/fixtures/editorial-quality/evaluation-v1.sha256', import.meta.url),
			'utf8'
		)
	).trim(),
	'Frozen evaluation corpus changed'
);
const corpus = JSON.parse(bytes);
assert.equal(corpus.version, 1);
assert.equal(
	new Set(corpus.cases.map((item) => item.id)).size,
	corpus.cases.length,
	'Duplicate evaluation ids'
);
const selected = corpus.cases.filter((item) => args.split === 'all' || item.split === args.split);
assert(selected.length > 0);
const summarize = (rows) => {
	const counts = rows.reduce(
		(total, row) => ({
			tp: total.tp + row.tp,
			fp: total.fp + row.fp,
			fn: total.fn + row.fn,
			tn: total.tn + Number(row.expected === 0 && row.actual === 0),
		}),
		{ tp: 0, fp: 0, fn: 0, tn: 0 }
	);
	return {
		cases: rows.length,
		...counts,
		precision: counts.tp + counts.fp ? counts.tp / (counts.tp + counts.fp) : null,
		recall: counts.tp + counts.fn ? counts.tp / (counts.tp + counts.fn) : null,
	};
};
const root = await mkdtemp(join(tmpdir(), 'editorial-evaluation-'));
const predictions = [];
let evidenceChecked = 0;
try {
	for (const item of selected) {
		const projectId = '11111111-1111-4111-8111-111111111111';
		const inputs = [
			...item.documents,
			...item.aliases.map((alias) => ({
				text: `${alias.subject} is also known as ${alias.value}.`,
				metadata: {},
			})),
		];
		const documents = inputs.map((document, index) => ({
			...document,
			projectId,
			documentId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
			title: `Scene ${index + 1}`,
			path: `Draft/${index + 1}`,
			order: index,
			revision: hash(document.text),
		}));
		const source = {
			projectId,
			projectPath: root,
			list: async () => documents,
			read: async (id) => {
				const document = documents.find((doc) => doc.documentId === id);
				assert(document);
				return document;
			},
		};
		const store = new PersistentStore(join(root, `${item.id}.sqlite`));
		try {
			const bible = new SeriesBible(source, store);
			for (const [index, alias] of item.aliases.entries())
				await bible.curate({
					...alias,
					scope: { kind: 'project', id: projectId },
					kind: 'alias',
					predicate: 'alias',
					sources: [
						sourcePassage(
							documents[item.documents.length + index],
							0,
							documents[item.documents.length + index].text.length
						),
					],
				});
			const report = await new ContinuityService(source, store, bible).analyze();
			for (const issue of report.issues)
				for (const passage of issue.evidence) {
					verifyPassage(await source.read(passage.documentId), passage);
					evidenceChecked++;
				}
			const candidateById = new Map(report.candidates.map((fact) => [fact.id, fact]));
			const canonical = (subject) =>
				item.aliases.find(
					(alias) => alias.confidence === 'confirmed' && alias.value === subject
				)?.subject ?? subject;
			const remaining = new Set(report.issues);
			let tp = 0;
			for (const label of item.expected) {
				const spans = label.evidence.map((annotation) => {
					const document = documents[annotation.document];
					assert(document && annotation.quote.length > 0);
					const start = document.text.indexOf(annotation.quote);
					assert(
						start >= 0 && start === document.text.lastIndexOf(annotation.quote),
						'Annotation must identify one exact passage'
					);
					return {
						documentId: document.documentId,
						start,
						end: start + annotation.quote.length,
					};
				});
				const matched = [...remaining].find(
					(issue) =>
						issue.factIds.length >= 2 &&
						issue.factIds.every((id) => {
							const fact = candidateById.get(id);
							return (
								fact &&
								canonical(fact.subject) === label.subject &&
								fact.predicate === label.predicate
							);
						}) &&
						spans.every((span) =>
							issue.evidence.some(
								(passage) =>
									passage.documentId === span.documentId &&
									passage.start >= span.start &&
									passage.end <= span.end
							)
						)
				);
				if (matched) {
					tp++;
					remaining.delete(matched);
				}
			}
			predictions.push({
				id: item.id,
				split: item.split,
				category: item.category,
				inputSha256: hash(JSON.stringify(item)),
				expected: item.expected.length,
				actual: report.issues.length,
				tp,
				fp: report.issues.length - tp,
				fn: item.expected.length - tp,
				findings: report.issues.map((issue) => ({
					description: issue.description,
					confidence: issue.confidence,
					evidence: issue.evidence,
				})),
			});
		} finally {
			store.close();
		}
	}
	const report = {
		schemaVersion: 1,
		corpusSha256: fingerprint,
		annotationStatus: corpus.annotationStatus,
		split: args.split,
		implementation: {
			commit: execFileSync('git', ['rev-parse', 'HEAD'], {
				cwd: repository,
				encoding: 'utf8',
			}).trim(),
			workingTreeDirty: !!execFileSync('git', ['status', '--porcelain'], {
				cwd: repository,
				encoding: 'utf8',
			}).trim(),
			node: process.version,
			platform: `${process.platform}-${process.arch}`,
			runnerSha256: hash(await readFile(fileURLToPath(import.meta.url))),
			modules: Object.fromEntries(
				await Promise.all(
					[
						'continuity-service',
						'object-coreference',
						'continuity-nouns',
						'series-bible',
						'provenance',
						'persistent-store',
					].map(async (name) => [
						name,
						hash(
							await readFile(
								new URL(`../dist/services/editorial/${name}.js`, import.meta.url)
							)
						),
					])
				)
			),
		},
		overall: summarize(predictions),
		splits: Object.fromEntries(
			[...new Set(predictions.map((row) => row.split))].map((split) => [
				split,
				summarize(predictions.filter((row) => row.split === split)),
			])
		),
		categories: Object.fromEntries(
			[...new Set(predictions.map((row) => row.category))].map((category) => [
				category,
				summarize(predictions.filter((row) => row.category === category)),
			])
		),
		evidenceChecked,
		predictions,
		limitations:
			'Agent-authored synthetic scenarios, labeled before predictions; no independent human review or private manuscripts. Held-out cases are reserved from tuning only until their first evaluation, then become regression cases. No result estimates general manuscript reliability or editorial preference. No paid APIs or network calls.',
	};
	if (args.baseline) {
		const baseline = JSON.parse(await readFile(resolve(args.baseline), 'utf8'));
		assert.equal(baseline.schemaVersion, 1, 'Unsupported baseline schema');
		assert.equal(baseline.corpusSha256, fingerprint, 'Cannot compare changed corpus');
		assert.equal(
			baseline.predictions.length,
			predictions.length,
			'Baseline case selection differs'
		);
		assert.equal(
			new Set(baseline.predictions.map((row) => row.id)).size,
			predictions.length,
			'Duplicate baseline ids'
		);
		const prior = new Map(baseline.predictions.map((row) => [row.id, row]));
		const regressions = [];
		for (const row of predictions) {
			const before = prior.get(row.id);
			assert(
				before &&
					before.inputSha256 === row.inputSha256 &&
					before.expected === row.expected,
				'Cannot compare changed cases or labels'
			);
			assert(
				[before.expected, before.actual, before.tp, before.fp, before.fn].every(
					(value) => Number.isSafeInteger(value) && value >= 0
				),
				'Invalid baseline counts'
			);
			assert(
				before.expected === before.tp + before.fn &&
					before.actual === before.tp + before.fp,
				'Inconsistent baseline counts'
			);
			if (row.tp < before.tp || row.fp > before.fp || row.fn > before.fn)
				regressions.push(row.id);
		}
		report.comparison = {
			before: summarize(baseline.predictions),
			after: summarize(predictions),
			regressions,
		};
		if (regressions.length) process.exitCode = 1;
	}
	if (args.output) {
		await mkdir(dirname(resolve(args.output)), { recursive: true });
		await writeFile(resolve(args.output), `${JSON.stringify(report, null, 2)}\n`);
	}
	console.log(
		JSON.stringify(
			{
				overall: report.overall,
				splits: report.splits,
				comparison: report.comparison,
				errors: predictions
					.filter((row) => row.fp || row.fn)
					.map(({ id, fp, fn }) => ({ id, fp, fn })),
			},
			null,
			2
		)
	);
} finally {
	await rm(root, { recursive: true, force: true });
}
