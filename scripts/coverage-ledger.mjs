import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import ts from 'typescript';
import { readReleaseFile } from './check-release-candidate.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceFile = (text, file = 'scenario.ts') =>
	ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
const unwrap = (node) => (ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node);
const literal = (node) => {
	if (!node) return undefined;
	node = unwrap(node);
	if (ts.isStringLiteralLike(node)) return node.text;
	if (ts.isNumericLiteral(node)) return Number(node.text);
	if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
	if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
	if (node.kind === ts.SyntaxKind.NullKeyword) return null;
	if (
		ts.isPrefixUnaryExpression(node) &&
		node.operator === ts.SyntaxKind.MinusToken &&
		ts.isNumericLiteral(node.operand)
	)
		return -Number(node.operand.text);
	if (ts.isArrayLiteralExpression(node)) {
		const items = node.elements.map(literal);
		if (items.every((item) => item !== undefined)) return items;
	}
	return undefined;
};

function objectInputs(expression) {
	if (!expression) return { values: {}, dynamic: true };
	let node = unwrap(expression);
	if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
		if (!ts.isBlock(node.body)) node = unwrap(node.body);
		else {
			const returns = node.body.statements.filter(ts.isReturnStatement);
			if (returns.length !== 1 || !returns[0].expression)
				return { values: {}, dynamic: true };
			node = unwrap(returns[0].expression);
		}
	}
	if (!ts.isObjectLiteralExpression(node)) return { values: {}, dynamic: true };
	const values = {};
	let dynamic = false;
	for (const property of node.properties) {
		if (!ts.isPropertyAssignment(property)) {
			dynamic = true;
			continue;
		}
		const name =
			ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)
				? property.name.text
				: undefined;
		const value = literal(property.initializer);
		if (name === undefined || value === undefined) dynamic = true;
		else values[name] = value;
	}
	return { values, dynamic };
}

export function inspectConformancePlan(text, file = 'scripts/check-output-conformance.mjs') {
	const source = sourceFile(text, file);
	const cases = [];
	let found = false;
	function visit(node) {
		if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'PLAN') {
			if (!node.initializer || !ts.isArrayLiteralExpression(node.initializer))
				throw new Error('Conformance PLAN must be a literal array');
			if (found) throw new Error('Ambiguous conformance PLAN declarations');
			found = true;
			for (const entry of node.initializer.elements) {
				if (
					!ts.isArrayLiteralExpression(entry) ||
					![2, 3].includes(entry.elements.length) ||
					typeof literal(entry.elements[0]) !== 'string'
				)
					throw new Error(
						'Conformance PLAN contains an unrecognized case; update the coverage inventory'
					);
				const metadata = entry.elements[2] ? objectInputs(entry.elements[2]) : undefined;
				const id = metadata?.values.id;
				if (metadata && (typeof id !== 'string' || !/^[a-z0-9.-]+$/.test(id)))
					throw new Error('Conformance case metadata requires a literal stable id');
				if (id && cases.some((entry) => entry.id === id))
					throw new Error('Conformance case IDs must be unique');
				const hasPostcondition =
					entry.elements[2] &&
					ts.isObjectLiteralExpression(entry.elements[2]) &&
					entry.elements[2].properties.some(
						(property) =>
							ts.isPropertyAssignment(property) && property.name.text === 'after'
					);
				const inputs = objectInputs(entry.elements[1]);
				cases.push({
					tool: literal(entry.elements[0]),
					...(id
						? {
								id,
								expectedError: metadata.values.expectError ?? null,
								hasPostcondition: Boolean(hasPostcondition),
								expectedOutcome:
									typeof metadata.values.expectError === 'string'
										? 'refusal'
										: 'success',
							}
						: {}),
					inputs: inputs.values,
					dynamicInputs: inputs.dynamic,
					file,
					line: source.getLineAndCharacterOfPosition(entry.getStart(source)).line + 1,
				});
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
	if (!found) throw new Error('Conformance PLAN was not found; coverage cannot be inferred');
	return cases;
}

export function schemaBranches(schema, path = '$') {
	if (!schema || typeof schema !== 'object') return [];
	const branches = [];
	for (const value of schema.enum ?? [])
		branches.push({ kind: 'enum', path, value, status: 'U' });
	if ('const' in schema) branches.push({ kind: 'const', path, value: schema.const, status: 'U' });
	for (const bound of [
		'minimum',
		'maximum',
		'exclusiveMinimum',
		'exclusiveMaximum',
		'minLength',
		'maxLength',
		'minItems',
		'maxItems',
	]) {
		if (typeof schema[bound] === 'number')
			branches.push({ kind: 'boundary', path, bound, value: schema[bound], status: 'U' });
	}
	for (const [name, child] of Object.entries(schema.properties ?? {}))
		branches.push(...schemaBranches(child, `${path}.${name}`));
	if (schema.items && !Array.isArray(schema.items))
		branches.push(...schemaBranches(schema.items, `${path}[]`));
	for (const keyword of ['oneOf', 'anyOf', 'allOf', 'prefixItems']) {
		for (const [index, child] of (schema[keyword] ?? []).entries()) {
			const branchPath = `${path}.${keyword}[${index}]`;
			branches.push(
				{ kind: 'schema-branch', path: branchPath, status: 'U' },
				...schemaBranches(child, branchPath)
			);
		}
	}
	for (const keyword of [
		'if',
		'then',
		'else',
		'not',
		'contains',
		'additionalProperties',
		'propertyNames',
	]) {
		if (schema[keyword] && typeof schema[keyword] === 'object') {
			const branchPath = `${path}.${keyword}`;
			branches.push(
				{ kind: 'schema-branch', path: branchPath, status: 'U' },
				...schemaBranches(schema[keyword], branchPath)
			);
		}
	}
	for (const keyword of ['$defs', 'definitions', 'patternProperties', 'dependentSchemas']) {
		for (const [name, child] of Object.entries(schema[keyword] ?? {})) {
			const branchPath = `${path}.${keyword}.${name}`;
			branches.push(
				{ kind: 'schema-branch', path: branchPath, status: 'U' },
				...schemaBranches(child, branchPath)
			);
		}
	}
	if (schema.$ref)
		branches.push({ kind: 'schema-reference', path, value: schema.$ref, status: 'U' });
	return branches;
}

function nextCheck(tool, branch) {
	if (branch.kind === 'boundary')
		return `Invoke ${tool} with ${branch.path} at ${branch.bound} ${branch.value}: limit-1, limit, limit+1; validate rejection/continuation and unchanged state.`;
	if (branch.kind === 'schema-reference')
		return `Resolve ${tool} schema reference ${branch.value} at ${branch.path}; enumerate and execute its material success/error branches.`;
	if (branch.kind === 'schema-branch')
		return `Construct ${tool} input for ${branch.path}; validate success and incompatible-branch errors.`;
	return `Invoke ${tool} with ${branch.path}=${JSON.stringify(branch.value)}; validate success, invalid input and a material failure without partial mutation.`;
}

export function buildCoverageLedger(tools, plan, references = {}) {
	const names = new Set(tools.map((tool) => tool.name));
	if (names.size !== tools.length) throw new Error('Duplicate registry tool names');
	const unknown = plan.filter((item) => !names.has(item.tool));
	if (unknown.length)
		throw new Error(
			`Conformance references unregistered tools: ${[...new Set(unknown.map((item) => item.tool))].join(', ')}`
		);
	const rows = [...tools]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((tool) => {
			const scenarios = plan.filter((item) => item.tool === tool.name);
			return {
				tool: tool.name,
				schemaSha256: sha256(
					JSON.stringify({ input: tool.inputSchema, output: tool.outputSchema })
				),
				outputSchema: !!tool.outputSchema,
				coverage: {
					success: 'U',
					errors: 'U',
					limits: 'U',
					modernStdio: 'U',
					legacyStdio: 'U',
					realAppsHost: 'U',
					runtimeBranches: 'U',
				},
				declaredConformanceCases: scenarios,
				inputBranches: schemaBranches(tool.inputSchema).map((branch) => ({
					...branch,
					nextCheck: nextCheck(tool.name, branch),
					declaredCases:
						(branch.kind === 'enum' || branch.kind === 'const') &&
						/^\$\.[^.\[]+(\[\])?$/.test(branch.path)
							? scenarios
									.filter((scenario) => {
										const value =
											scenario.inputs[
												branch.path.slice(2).replace(/\[\]$/, '')
											];
										return branch.path.endsWith('[]')
											? Array.isArray(value) && value.includes(branch.value)
											: value === branch.value;
									})
									.map(({ file, line }) => ({ file, line }))
							: [],
				})),
				sourceReferences: references[tool.name] ?? [],
				nextChecks: {
					success: `Run ${tool.name} with a disposable valid fixture and independently validate ${tool.outputSchema ? 'structuredContent against its output schema' : 'its documented text/acknowledgment contract'}.`,
					errors: `Exercise ${tool.name} invalid input, missing/stale project and applicable service/storage failures; verify protocol/business errors and no partial writes.`,
					limits: `Exercise ${tool.name} declared bounds plus empty/large output, cancellation and result-reference continuation; no silent omission.`,
					transports: `Repeat ${tool.name} success/error scenarios over modern and legacy stdio; do not substitute handler calls or mocked Apps messages for a real host receipt.`,
					runtimeBranches: `Inspect ${tool.name} handler/callees for branches absent from enums and pair each material return/error with an executable case.`,
				},
			};
		});
	return {
		schemaVersion: 1,
		kind: 'source-inventory-with-unverified-runtime-obligations',
		summary: {
			tools: rows.length,
			schemaBearingTools: rows.filter((row) => row.outputSchema).length,
			declaredConformanceCases: plan.length,
			toolsWithDeclaredCases: new Set(plan.map((row) => row.tool)).size,
			inputBranches: rows.reduce((total, row) => total + row.inputBranches.length, 0),
			verifiedRuntimeCases: 0,
		},
		limitations: [
			'Static PLAN entries and literal tool-name references locate candidate evidence; they never certify execution, assertions, current passing status or branch completeness.',
			'All runtime statuses remain U until exact-candidate execution receipts are reviewed. Historical CI and source presence are not current evidence.',
			'Input enums, bounds and schema unions are enumerated without claiming their Cartesian product or conditional/runtime-only branches are covered.',
			'No real Apps host, paid provider, native Scrivener GUI or performance measurement runs in this inventory.',
		],
		tools: rows,
	};
}

async function codeFiles(directory) {
	const files = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const file = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await codeFiles(file)));
		else if (entry.isFile() && /\.(?:[cm]?js|ts)$/.test(entry.name)) files.push(file);
	}
	return files.sort();
}

export async function freezeEditorialEvidence(repository) {
	const paths = [
		'tests/fixtures/passage-relevance.json',
		...[
			'README.md',
			'GUTENBERG-LICENSE.txt',
			'excerpts.json',
			'cases.json',
			'cases-v1.json',
			'evaluation-v1.json',
			'evaluation-v1.sha256',
			'evaluation-review-template.json',
		].map((name) => `tests/fixtures/editorial-quality/${name}`),
		...[
			'editorial-quality-baseline.json',
			'editorial-quality-current.json',
			'editorial-evaluation-baseline.json',
			'editorial-evaluation-development.json',
			'editorial-evaluation-holdout.json',
			'editorial-evaluation-before-coreference.json',
			'editorial-evaluation-current.json',
		].map((name) => `docs/benchmarks/${name}`),
		'scripts/evaluate-editorial.mjs',
		'scripts/benchmark-editorial.mjs',
	];
	const files = {};
	const content = {};
	for (const path of paths) {
		const bytes = await readFile(join(repository, path));
		files[path] = { sha256: sha256(bytes), bytes: bytes.length };
		content[path] = path.endsWith('.json') ? JSON.parse(bytes) : bytes.toString('utf8');
	}
	const corpusPath = 'tests/fixtures/editorial-quality/evaluation-v1.json';
	if (
		files[corpusPath].sha256 !==
		content['tests/fixtures/editorial-quality/evaluation-v1.sha256'].trim()
	)
		throw new Error('Frozen editorial corpus does not match its declared SHA-256');
	const corpus = content[corpusPath];
	const review = content['tests/fixtures/editorial-quality/evaluation-review-template.json'];
	const retrieval = content['tests/fixtures/passage-relevance.json'];
	return {
		files,
		retrieval: {
			queries: retrieval.queries.length,
			documents: retrieval.documents.length,
			independentLabels: 'U',
			nDCGAt10: 'U',
			recallAt10: 'U',
			multilingualStrata: 'U',
			evaluatorAgreement: 'U',
		},
		editorial: {
			cases: corpus.cases.length,
			annotationStatus: corpus.annotationStatus,
			splits: Object.fromEntries(
				[...new Set(corpus.cases.map((item) => item.split))].map((split) => [
					split,
					corpus.cases.filter((item) => item.split === split).length,
				])
			),
			categories: [...new Set(corpus.cases.map((item) => item.category))].sort(),
			reviewTemplate: {
				reviewerSupplied: !!review.reviewer,
				completedJudgments: review.cases.filter((item) => item.judgment !== null).length,
			},
			independentLabels: 'U',
			evaluatorAgreement: 'U',
			untouchedHoldout: false,
			limitations:
				'Existing README records post-evaluation tuning on the former holdout; preserve first evaluation separately. These fingerprints freeze regression artifacts, not a new independent holdout.',
		},
		historicalReports: Object.fromEntries(
			Object.entries(content)
				.filter(([path]) => path.startsWith('docs/benchmarks/'))
				.map(([path, report]) => [
					path,
					{
						overall: report.overall,
						splits: report.splits,
						implementation: report.implementation,
						status: 'historical artifact inspected; not rerun or certified against this candidate',
					},
				])
		),
	};
}

const RECEIPT_INPUTS = [
	'src',
	'dist',
	'tests/sample-project.scriv',
	'assets/c2pa-binding',
	'scripts/check-output-conformance.mjs',
	'scripts/create-c2pa-fixtures.mjs',
	'package.json',
	'package-lock.json',
];
const HASH = /^[a-f0-9]{64}$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const demand = (condition, message) => {
	if (!condition) throw new Error(`Invalid conformance receipt: ${message}`);
};
const hashJson = (value) => sha256(JSON.stringify(value));
const EXTRA_CASES = new Map([
	['lifecycle.open', 'open_project'],
	['lifecycle.close', 'close_project'],
	['project.structure.nonempty', 'get_structure'],
]);

export async function captureReceiptInputs(repository) {
	const inputs = {};
	async function walk(path) {
		const absolute = join(repository, path);
		const stat = await lstat(absolute);
		if (stat.isSymbolicLink()) throw new Error(`Receipt input must not be a symlink: ${path}`);
		if (stat.isDirectory()) {
			for (const name of (await readdir(absolute)).sort()) await walk(`${path}/${name}`);
		} else if (stat.isFile()) inputs[path] = sha256(await readFile(absolute));
		else throw new Error(`Receipt input must be a regular file: ${path}`);
	}
	for (const path of RECEIPT_INPUTS) await walk(path);
	return Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b)));
}

export async function readConformanceReceipt(path) {
	let bytes;
	try {
		bytes = await readReleaseFile(path, 8 * 1024 * 1024);
	} catch (error) {
		throw new Error(`Could not read conformance receipt (1 byte–8 MiB): ${error.message}`, {
			cause: error,
		});
	}
	return {
		value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
		sha256: sha256(bytes),
	};
}

export function attachConformanceReceipt(ledger, tools, plan, receipt, identity) {
	demand(object(receipt) && receipt.version === 1, 'unsupported receipt version');
	demand(receipt.repositoryRevision === identity.revision, 'repository revision differs');
	demand(HASH.test(identity.receiptSha256), 'missing receipt file hash');
	demand(
		typeof receipt.boundary === 'string' &&
			receipt.boundary.startsWith('Direct registered handlers in one local process;'),
		'producer boundary is not direct handlers'
	);
	demand(
		object(receipt.runtime) &&
			typeof receipt.runtime.node === 'string' &&
			typeof receipt.runtime.platform === 'string' &&
			typeof receipt.runtime.arch === 'string',
		'missing runtime identity'
	);
	const started = Date.parse(receipt.startedAt),
		finished = Date.parse(receipt.finishedAt);
	demand(
		Number.isFinite(started) && Number.isFinite(finished) && started <= finished,
		'invalid execution timestamps'
	);
	const manifest = receipt.provenance;
	demand(
		object(manifest) &&
			Array.isArray(manifest.files) &&
			manifest.files.length > 0 &&
			manifest.files.length <= 20000,
		'missing or oversized producer manifest'
	);
	demand(
		HASH.test(manifest.sha256) && hashJson(manifest.files) === manifest.sha256,
		'producer manifest digest differs'
	);
	const seenPaths = new Set();
	for (const entry of manifest.files) {
		demand(
			object(entry) &&
				typeof entry.path === 'string' &&
				entry.path.length <= 4096 &&
				!entry.path.includes('\\') &&
				!entry.path.includes('\0') &&
				!entry.path.split('/').some((part) => !part || part === '.' || part === '..') &&
				HASH.test(entry.sha256),
			'malformed manifest entry'
		);
		demand(!seenPaths.has(entry.path), 'duplicate manifest path');
		seenPaths.add(entry.path);
		demand(
			Object.hasOwn(identity.executionInputs, entry.path) &&
				identity.executionInputs[entry.path] === entry.sha256,
			`stale or unexpected execution input ${entry.path}`
		);
		if (Object.hasOwn(identity.inventoryInputs, entry.path))
			demand(
				identity.inventoryInputs[entry.path] === entry.sha256,
				`inventory source differs at ${entry.path}`
			);
	}
	demand(
		seenPaths.size === Object.keys(identity.executionInputs).length,
		'producer manifest omits execution inputs'
	);
	const byTool = new Map(tools.map((tool) => [tool.name, tool]));
	demand(
		Array.isArray(receipt.registry) && receipt.registry.length === byTool.size,
		'registry tool count differs'
	);
	const registryNames = new Set();
	for (const entry of receipt.registry) {
		demand(
			object(entry) && byTool.has(entry.name) && !registryNames.has(entry.name),
			'unknown or duplicate registry tool'
		);
		registryNames.add(entry.name);
		const tool = byTool.get(entry.name);
		demand(
			entry.outputSchemaSha256 === (tool.outputSchema ? hashJson(tool.outputSchema) : null),
			`output schema differs for ${entry.name}`
		);
	}
	const declared = new Map();
	for (const scenario of plan) {
		demand(
			typeof scenario.id === 'string' &&
				!declared.has(scenario.id) &&
				!EXTRA_CASES.has(scenario.id),
			'PLAN requires unique stable case IDs'
		);
		declared.set(scenario.id, scenario);
	}
	demand(
		Array.isArray(receipt.cases) && receipt.cases.length === plan.length + EXTRA_CASES.size,
		'case count does not match complete producer plan'
	);
	const seenCases = new Set(),
		qualified = [],
		nonqualifying = [];
	for (const item of receipt.cases) {
		demand(
			object(item) && typeof item.id === 'string' && !seenCases.has(item.id),
			'duplicate or malformed case ID'
		);
		seenCases.add(item.id);
		const scenario = declared.get(item.id);
		demand(scenario || EXTRA_CASES.has(item.id), `unknown case ${item.id}`);
		demand(item.status === 'PASS', `case ${item.id} did not pass`);
		demand(
			item.tool === (scenario?.tool ?? EXTRA_CASES.get(item.id)),
			`tool differs for case ${item.id}`
		);
		const tool = byTool.get(item.tool);
		demand(tool, `unregistered case tool ${item.tool}`);
		if (item.id.startsWith('lifecycle.')) {
			demand(
				item.outcome === 'success' &&
					item.schema === 'not-advertised' &&
					!tool.outputSchema &&
					typeof item.assertion === 'string',
				`invalid lifecycle acknowledgment ${item.id}`
			);
			nonqualifying.push({
				id: item.id,
				tool: item.tool,
				reason: 'Lifecycle acknowledgment has no advertised output schema or full input receipt.',
			});
			continue;
		}
		demand(
			HASH.test(item.inputSha256) && object(item.inputSelector),
			`missing input identity for ${item.id}`
		);
		for (const value of Object.values(item.inputSelector))
			demand(
				value === null ||
					typeof value === 'boolean' ||
					(typeof value === 'number' && Number.isFinite(value)) ||
					(typeof value === 'string' && value.length <= 200) ||
					(object(value) &&
						Number.isSafeInteger(value.characters) &&
						value.characters > 200 &&
						HASH.test(value.sha256) &&
						Object.keys(value).length === 2),
				`invalid input selector for ${item.id}`
			);
		demand(
			item.outputSchemaSha256 === (tool.outputSchema ? hashJson(tool.outputSchema) : null),
			`case output schema differs for ${item.id}`
		);
		if (scenario) {
			demand(
				item.inputSchemaSha256 === hashJson(tool.inputSchema),
				`case input schema differs for ${item.id}`
			);
			demand(
				item.expectedOutcome === scenario.expectedOutcome &&
					item.expectedError === scenario.expectedError,
				`case expectation differs for ${item.id}`
			);
			for (const [key, value] of Object.entries(scenario.inputs)) {
				if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
					const selector =
						typeof value === 'string' && value.length > 200
							? { characters: value.length, sha256: sha256(value) }
							: value;
					const expectedSelector = identity.redactDiagnostics
						? identity.redactDiagnostics({ [key]: selector })[key]
						: selector;
					demand(
						Object.hasOwn(item.inputSelector, key) &&
							JSON.stringify(item.inputSelector[key]) ===
								JSON.stringify(expectedSelector),
						`literal selector differs for ${item.id}.${key}`
					);
				}
			}
		}
		const refusal = scenario?.expectedOutcome === 'refusal';
		if (refusal) {
			demand(
				item.outcome === 'thrown-error' || item.outcome === 'returned-error',
				`expected refusal outcome differs for ${item.id}`
			);
			demand(
				item.schema === 'not-returned' ||
					(item.outcome === 'returned-error' && item.schema === 'valid'),
				`invalid refusal schema status for ${item.id}`
			);
			if (item.outcome === 'thrown-error')
				demand(
					typeof item.detail === 'string' &&
						new RegExp(scenario.expectedError, 'i').test(item.detail),
					`thrown refusal reason differs for ${item.id}`
				);
		} else {
			demand(
				item.outcome === 'success' && item.schema === 'valid' && tool.outputSchema,
				`success lacks schema validation for ${item.id}`
			);
			if (scenario)
				demand(
					item.postcondition === (scenario.hasPostcondition ? 'passed' : 'none'),
					`postcondition did not pass for ${item.id}`
				);
		}
		if (item.outcome !== 'thrown-error')
			demand(HASH.test(item.resultSha256), `missing returned result digest for ${item.id}`);
		const unavailableSelectors = Object.entries(item.inputSelector)
			.filter(
				([key, value]) =>
					(typeof value === 'string' && value.includes('[redacted]')) ||
					(identity.redactDiagnostics &&
						identity.redactDiagnostics({ [key]: 'selector-probe' })[key] !==
							'selector-probe')
			)
			.map(([key]) => key);
		qualified.push({
			id: item.id,
			unavailableSelectors,
			tool: item.tool,
			inputSelector: item.inputSelector,
			inputSha256: item.inputSha256,
			outcome: item.outcome,
			schema: item.schema,
			resultSha256: item.resultSha256 ?? null,
			postcondition: item.postcondition ?? null,
		});
	}
	const observedSuccess = qualified.filter((item) => item.outcome === 'success');
	const observedRefusal = qualified.filter((item) => item.outcome !== 'success');
	const expectedSummary = {
		cases: receipt.cases.length,
		pass: receipt.cases.length,
		fail: 0,
		schemaValidatedSuccesses: observedSuccess.length,
		expectedRefusals: observedRefusal.length,
	};
	demand(
		object(receipt.summary) &&
			Object.entries(expectedSummary).every(([key, value]) => receipt.summary[key] === value),
		'summary does not match actual qualifying outcomes'
	);
	const next = structuredClone(ledger);
	for (const row of next.tools) {
		row.observedSuccess = observedSuccess.filter((item) => item.tool === row.tool);
		row.observedRefusal = observedRefusal.filter((item) => item.tool === row.tool);
		for (const branch of row.inputBranches) {
			const matches = (item) =>
				(branch.kind === 'enum' || branch.kind === 'const') &&
				/^\$\.[^.\[\]]+$/.test(branch.path) &&
				Object.hasOwn(item.inputSelector, branch.path.slice(2)) &&
				!item.unavailableSelectors.includes(branch.path.slice(2)) &&
				item.inputSelector[branch.path.slice(2)] === branch.value;
			branch.observedSuccess = row.observedSuccess.filter(matches).map((item) => item.id);
			branch.observedRefusal = row.observedRefusal.filter(matches).map((item) => item.id);
		}
	}
	next.schemaVersion = 2;
	next.kind = 'source-inventory-with-verified-handler-receipt';
	next.summary.verifiedRuntimeCases = qualified.length;
	next.summary.observedSuccess = observedSuccess.length;
	next.summary.observedRefusal = observedRefusal.length;
	next.summary.nonqualifyingAcknowledgments = nonqualifying.length;
	next.receiptEvidence = {
		sha256: identity.receiptSha256,
		producerManifestSha256: manifest.sha256,
		startedAt: receipt.startedAt,
		finishedAt: receipt.finishedAt,
		runtime: receipt.runtime,
		boundary: 'Direct registered handlers only; no wire, host or exhaustive branch claim.',
		verification:
			'Current execution files, registry schemas, complete case identities, reported outcomes and summary checked. Execution and Ajv validation are reported by the reviewed producer; returned payloads are represented by digests, not independently reexecuted here.',
		nonqualifying,
	};
	next.limitations = next.limitations.filter(
		(text) => !text.startsWith('All runtime statuses remain U')
	);
	next.limitations.push(
		'ObservedSuccess/observedRefusal lists contain qualified direct-handler cases only. Existing category and branch completeness statuses remain U; selecting an enum value does not cover all behavior for that value. Bounds, unions, defaulted/array/nested selectors, wire and host obligations are never inferred.',
		'Receipt matching does not independently prove a build reproduces source, installed dependencies match the lockfile, native GUI fidelity or editorial accuracy. Retain the separate build and external validation gates.'
	);
	return next;
}

async function main(argv) {
	const { values } = parseArgs({
		args: argv,
		options: {
			repository: { type: 'string' },
			output: { type: 'string' },
			receipt: { type: 'string' },
		},
		strict: true,
	});
	if (!values.output)
		throw new Error(
			'Usage: node --import tsx scripts/coverage-ledger.mjs [--repository PATH] --output PATH [--receipt PATH]'
		);
	const repository = resolve(values.repository ?? fileURLToPath(new URL('../', import.meta.url)));
	const inventoryFiles = async () =>
		[
			...(await codeFiles(join(repository, 'src'))),
			...(await codeFiles(join(repository, 'scripts'))),
			...(await codeFiles(join(repository, 'tests'))),
			join(repository, 'package.json'),
			join(repository, 'package-lock.json'),
		].sort();
	const receiptPath = values.receipt ? resolve(values.receipt) : undefined;
	const receipt = receiptPath ? await readConformanceReceipt(receiptPath) : undefined;
	const executionInputs = receipt ? await captureReceiptInputs(repository) : undefined;
	const files = await inventoryFiles();
	const inputs = Object.fromEntries(
		await Promise.all(
			files.map(async (file) => [
				relative(repository, file).split('\\').join('/'),
				sha256(await readFile(file)),
			])
		)
	);
	process.env.SCRIVENER_DISABLE_KEY_DISCOVERY = '1';
	process.env.SCRIVENER_LOCAL_ONLY = 'true';
	process.env.SCRIVENER_HMS_ENGINE = 'fallback';
	process.env.SCRIVENER_MCP_EAGER_TOOLS = '1';
	const { initializeSkillRegistry, getRegisteredTools } = await import(
		pathToFileURL(join(repository, 'src/handlers/skill-registry.ts')).href
	);
	initializeSkillRegistry();
	const tools = getRegisteredTools(true, true);
	const planPath = 'scripts/check-output-conformance.mjs';
	const plan = inspectConformancePlan(
		await readFile(join(repository, planPath), 'utf8'),
		planPath
	);
	const references = Object.fromEntries(tools.map((tool) => [tool.name, []]));
	for (const file of files) {
		const bytes = await readFile(file);
		const path = relative(repository, file).split('\\').join('/');
		if (inputs[path] !== sha256(bytes))
			throw new Error(`Source changed during inventory: ${path}; retry after edits settle`);
		if (path.startsWith('src/') || path.endsWith('.json')) continue;
		const source = sourceFile(bytes.toString('utf8'), file);
		const seen = new Set();
		function visit(node) {
			if (ts.isStringLiteralLike(node) && Object.hasOwn(references, node.text)) {
				const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
				const key = `${node.text}:${line}`;
				if (!seen.has(key))
					references[node.text].push({
						file: path,
						line,
						kind: 'literal-reference-only',
					});
				seen.add(key);
			}
			ts.forEachChild(node, visit);
		}
		visit(source);
	}
	let ledger = buildCoverageLedger(tools, plan, references);
	ledger.provenance = {
		repository,
		revision: execFileSync('git', ['rev-parse', 'HEAD'], {
			cwd: repository,
			encoding: 'utf8',
		}).trim(),
		workingTreeDirty: !!execFileSync('git', ['status', '--porcelain'], {
			cwd: repository,
			encoding: 'utf8',
		}).trim(),
		node: process.version,
		platform: `${process.platform}-${process.arch}`,
		inputs,
		runnerSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
	};
	ledger.editorialEvidence = await freezeEditorialEvidence(repository);
	if (receipt) {
		ledger.provenance.executionInputs = executionInputs;
		const { redactDiagnostics } = await import(
			pathToFileURL(join(repository, 'dist/setup/redaction.js')).href
		);
		ledger = attachConformanceReceipt(ledger, tools, plan, receipt.value, {
			revision: ledger.provenance.revision,
			receiptSha256: receipt.sha256,
			redactDiagnostics,
			executionInputs,
			inventoryInputs: inputs,
		});
		ledger.receiptEvidence.file = relative(repository, receiptPath).split('\\').join('/');
	}
	if (JSON.stringify(await inventoryFiles()) !== JSON.stringify(files))
		throw new Error('Source file inventory changed; retry after edits settle');
	for (const [path, digest] of Object.entries(inputs)) {
		if (sha256(await readFile(join(repository, path))) !== digest)
			throw new Error(`Source changed during inventory: ${path}; retry after edits settle`);
	}
	for (const [path, { sha256: digest }] of Object.entries(ledger.editorialEvidence.files)) {
		if (sha256(await readFile(join(repository, path))) !== digest)
			throw new Error(`Editorial evidence changed during inventory: ${path}`);
	}
	if (
		receipt &&
		(JSON.stringify(await captureReceiptInputs(repository)) !==
			JSON.stringify(executionInputs) ||
			(await readConformanceReceipt(receiptPath)).sha256 !== receipt.sha256)
	)
		throw new Error('Conformance receipt or execution inputs changed during inventory');
	await mkdir(dirname(resolve(values.output)), { recursive: true });
	await writeFile(resolve(values.output), `${JSON.stringify(ledger, null, 2)}\n`, { flag: 'wx' });
	process.stdout.write(`${JSON.stringify(ledger.summary)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
	main(process.argv.slice(2)).catch((error) => {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	});
