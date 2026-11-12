import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const script = pathToFileURL(resolve(__dirname, '../../../scripts/coverage-ledger.mjs')).href;
const tool = {
	name: 'review',
	inputSchema: {
		type: 'object',
		properties: {
			action: { type: 'string', enum: ['list', 'apply', 'undo'] },
			limit: { type: 'integer', minimum: 0, maximum: 100 },
		},
	},
	outputSchema: { type: 'object' },
};

async function inspect(planSource: string, tools: unknown[] = [tool]) {
	const { stdout } = await execute(process.execPath, [
		'--input-type=module',
		'-e',
		`import { inspectConformancePlan, buildCoverageLedger } from ${JSON.stringify(script)};
const { source, tools } = JSON.parse(process.argv[1]);
const plan = inspectConformancePlan(source);
process.stdout.write(JSON.stringify(buildCoverageLedger(tools, plan, { review: [{ file: 'existing.test.ts', line: 12, kind: 'literal-reference-only' }] })));`,
		JSON.stringify({ source: planSource, tools }),
	]);
	return JSON.parse(stdout);
}

it('keeps runtime coverage unknown despite declared conformance cases and test references', async () => {
	const ledger = await inspect(`const PLAN = [['review', { action: 'list', limit: 0 }]];`);
	expect(ledger.summary).toEqual({
		tools: 1,
		schemaBearingTools: 1,
		declaredConformanceCases: 1,
		toolsWithDeclaredCases: 1,
		inputBranches: 5,
		verifiedRuntimeCases: 0,
	});
	const row = ledger.tools[0];
	expect(Object.values(row.coverage).every((value) => value === 'U')).toBe(true);
	expect(
		row.inputBranches.find((branch: { value?: string }) => branch.value === 'list')
	).toMatchObject({
		status: 'U',
		declaredCases: [{ file: 'scripts/check-output-conformance.mjs', line: 1 }],
	});
	for (const action of ['apply', 'undo']) {
		expect(
			row.inputBranches.find((branch: { value?: string }) => branch.value === action)
		).toMatchObject({
			status: 'U',
			declaredCases: [],
			nextCheck: expect.stringContaining(action),
		});
	}
	expect(
		row.inputBranches.filter((branch: { kind: string }) => branch.kind === 'boundary')
	).toHaveLength(2);
	expect(row.sourceReferences).toEqual([
		{ file: 'existing.test.ts', line: 12, kind: 'literal-reference-only' },
	]);
});

it('reads literal discriminators from dynamic fixture factories without executing them', async () => {
	const ledger = await inspect(`const PLAN = [
['review', () => ({action: 'apply', documentId: dangerous()} )],
['review', async (context) => { const value = await dangerous(); return {action: 'undo', documentId: value}; }],
['review', 'NEEDS_DOC']
];`);
	expect(
		ledger.tools[0].declaredConformanceCases.map(
			(entry: { inputs: object; dynamicInputs: boolean }) => [
				entry.inputs,
				entry.dynamicInputs,
			]
		)
	).toEqual([
		[{ action: 'apply' }, true],
		[{ action: 'undo' }, true],
		[{}, true],
	]);
	expect(ledger.summary.verifiedRuntimeCases).toBe(0);
});

it('enumerates nested enum, const, length and union obligations without inventing execution coverage', async () => {
	const nested = {
		name: 'nested',
		inputSchema: {
			properties: { modes: { items: { enum: ['brief', 'full'] }, minItems: 1, maxItems: 2 } },
			oneOf: [
				{ properties: { kind: { const: 'source' }, text: { minLength: 1, maxLength: 5 } } },
			],
		},
	};
	const ledger = await inspect('const PLAN = [];', [nested]);
	const branches = ledger.tools[0].inputBranches;
	expect(branches.map((branch: { path: string }) => branch.path)).toContain('$.modes[]');
	expect(branches).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ kind: 'schema-branch', path: '$.oneOf[0]', status: 'U' }),
			expect.objectContaining({
				kind: 'const',
				path: '$.oneOf[0].kind',
				value: 'source',
				status: 'U',
			}),
			expect.objectContaining({
				kind: 'boundary',
				path: '$.oneOf[0].text',
				bound: 'maxLength',
				value: 5,
			}),
		])
	);
	expect(ledger.tools[0].nextChecks.success).toContain('text/acknowledgment');
});

it.each([
	['const OTHER = [];', 'PLAN was not found'],
	['const PLAN = fetchCases();', 'literal array'],
	['const PLAN = [...cases];', 'unrecognized case'],
	["const PLAN = [['missing', {}]];", 'unregistered tools'],
])('fails loudly for an incomplete source inventory: %s', async (source, error) => {
	await expect(inspect(source)).rejects.toThrow(error);
});

it('adds newly registered tools as explicit unknowns even without any source references', async () => {
	const ledger = await inspect('const PLAN = [];', [tool, { name: 'new_tool', inputSchema: {} }]);
	expect(ledger.summary.tools).toBe(2);
	expect(ledger.tools.find((entry: { tool: string }) => entry.tool === 'new_tool')).toMatchObject(
		{
			outputSchema: false,
			coverage: { success: 'U', errors: 'U', limits: 'U', runtimeBranches: 'U' },
			declaredConformanceCases: [],
			sourceReferences: [],
		}
	);
});

it('retains conditional and referenced schemas as explicit unverified investigations', async () => {
	const ledger = await inspect('const PLAN = [];', [
		{
			name: 'conditional',
			inputSchema: {
				if: { properties: { action: { const: 'apply' } } },
				then: { properties: { revision: { minLength: 64, maxLength: 64 } } },
				$defs: { identity: { properties: { id: { minLength: 1 } } } },
				properties: { target: { $ref: '#/$defs/identity' } },
			},
		},
	]);
	expect(ledger.tools[0].inputBranches).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ path: '$.if.action', value: 'apply', status: 'U' }),
			expect.objectContaining({ path: '$.then.revision', bound: 'maxLength', value: 64 }),
			expect.objectContaining({
				kind: 'schema-reference',
				path: '$.target',
				value: '#/$defs/identity',
				status: 'U',
			}),
			expect.objectContaining({ path: '$.$defs.identity.id', bound: 'minLength', value: 1 }),
		])
	);
});

it('freezes existing evidence without promoting self-labels and rejects corpus/hash drift', async () => {
	const { mkdtemp, cp, mkdir, readFile, writeFile, rm } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const root = await mkdtemp(resolve(tmpdir(), 'coverage-evidence-'));
	const repository = resolve(__dirname, '../../..');
	const inspectFreeze = () =>
		execute(process.execPath, [
			'--input-type=module',
			'-e',
			`import { freezeEditorialEvidence } from ${JSON.stringify(script)};
const frozen = await freezeEditorialEvidence(process.argv[1]);
process.stdout.write(JSON.stringify({ retrieval: frozen.retrieval, editorial: frozen.editorial, files: Object.keys(frozen.files).length }));`,
			root,
		]);
	try {
		await mkdir(resolve(root, 'tests/fixtures'), { recursive: true });
		await mkdir(resolve(root, 'docs/benchmarks'), { recursive: true });
		await mkdir(resolve(root, 'scripts'), { recursive: true });
		await cp(
			resolve(repository, 'tests/fixtures/editorial-quality'),
			resolve(root, 'tests/fixtures/editorial-quality'),
			{ recursive: true }
		);
		await cp(
			resolve(repository, 'tests/fixtures/passage-relevance.json'),
			resolve(root, 'tests/fixtures/passage-relevance.json')
		);
		await cp(resolve(repository, 'docs/benchmarks'), resolve(root, 'docs/benchmarks'), {
			recursive: true,
		});
		for (const name of ['evaluate-editorial.mjs', 'benchmark-editorial.mjs'])
			await cp(resolve(repository, 'scripts', name), resolve(root, 'scripts', name));
		const first = JSON.parse((await inspectFreeze()).stdout);
		expect(first).toMatchObject({
			files: 18,
			retrieval: { queries: 4, independentLabels: 'U', nDCGAt10: 'U', recallAt10: 'U' },
			editorial: {
				cases: 36,
				independentLabels: 'U',
				evaluatorAgreement: 'U',
				untouchedHoldout: false,
				reviewTemplate: { reviewerSupplied: false, completedJudgments: 0 },
			},
		});
		const corpusPath = resolve(root, 'tests/fixtures/editorial-quality/evaluation-v1.json');
		await writeFile(corpusPath, `${await readFile(corpusPath, 'utf8')}\n`);
		await expect(inspectFreeze()).rejects.toThrow('Frozen editorial corpus does not match');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('preserves stable case IDs and refusal expectations without treating them as runtime evidence', async () => {
	const ledger = await inspect(`const PLAN = [
['review', { action: 'apply' }, { id: 'review.apply', after: () => dangerous() }],
['review', { action: 'list', limit: 0 }, { id: 'review.refuse.zero', expectError: 'Too small' }]
];`);
	expect(ledger.tools[0].declaredConformanceCases).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ id: 'review.apply', expectedOutcome: 'success' }),
			expect.objectContaining({ id: 'review.refuse.zero', expectedOutcome: 'refusal' }),
		])
	);
	expect(ledger.summary.verifiedRuntimeCases).toBe(0);
	expect(Object.values(ledger.tools[0].coverage).every((value) => value === 'U')).toBe(true);
});

it.each([
	["const PLAN = [['review', {}, { id: 'same' }], ['review', {}, { id: 'same' }]];", 'unique'],
	["const PLAN = [['review', {}, { after: () => {} }]];", 'stable id'],
	["const PLAN = [['review', {}, { id: variable }]];", 'stable id'],
])('rejects ambiguous case metadata', async (source, message) => {
	await expect(inspect(source)).rejects.toThrow(message);
});
