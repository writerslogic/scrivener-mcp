import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

const fixture = new URL('../assets/narrative-lens/', import.meta.url);
const provenance = JSON.parse(readFileSync(new URL('provenance.json', fixture), 'utf8'));
const output = new URL('../src/handlers/narrative-annotation-schema.ts', import.meta.url);
const require = createRequire(import.meta.url);
function installedVersion() {
	return JSON.parse(
		readFileSync(join(dirname(require.resolve('narrative-lens')), 'package.json'), 'utf8')
	).version;
}

const modes = {
	causality: { nodes: 'AuthorCausalNodes', interventions: 'AuthorInterventions' },
	knowledge: { propositions: 'AuthorPropositions', events: 'AuthorKnowledgeEvents' },
	epistemics: {
		propositions: 'AuthorPropositions',
		events: 'AuthorKnowledgeEvents',
		queries: 'AuthorEpistemicQueries',
	},
	reader: { propositions: 'AuthorPropositions', events: 'AuthorKnowledgeEvents' },
	promises: { events: 'AuthorPromiseEvents' },
	subtext: { annotations: 'AuthorSubtextAnnotations' },
	themes: { theses: 'AuthorThematicTheses', annotations: 'AuthorThematicAnnotations' },
	coreference: { links: 'AuthorCoreferenceLinks' },
	uncertainty: { observations: 'SuppliedUncertaintyObservations' },
	history: { catalogue: 'HistoricalEntries', usages: 'HistoricalUsages' },
};

export async function generateAnnotationSchema({
	inputPath = new URL('annotations.schema.json', fixture),
	outputPath = output,
	check = false,
	version = installedVersion(),
} = {}) {
	if (version !== provenance.version)
		throw new Error(
			`Narrative Lens ${version} does not match schema version ${provenance.version}; review and regenerate the pinned contracts`
		);
	const raw = readFileSync(inputPath);
	const digest = createHash('sha256').update(raw).digest('hex');
	if (![provenance.fullSha256, provenance.subsetSha256].includes(digest))
		throw new Error('Annotation source does not match the pinned upstream schema or subset');
	const upstream = JSON.parse(raw.toString('utf8'));
	const definitions = {};
	const variants = Object.entries(modes).map(([kind, fields]) => {
		const properties = {};
		for (const [field, contract] of Object.entries(fields)) {
			const { $defs, $schema, title, ...schema } = upstream[contract];
			for (const [name, definition] of Object.entries($defs ?? {})) {
				if (
					definitions[name] &&
					JSON.stringify(definitions[name]) !== JSON.stringify(definition)
				)
					throw new Error(`Conflicting upstream definition: ${name}`);
				definitions[name] = definition;
			}
			properties[field] = { ...schema, maxItems: 4096 };
		}
		if (kind === 'history')
			Object.assign(properties, {
				targetYear: {
					type: 'integer',
					minimum: -2147483648,
					maximum: 2147483647,
					description: 'Signed year; BCE years are negative.',
				},
				toleranceYears: { type: 'integer', minimum: 0, maximum: 4294967295 },
			});
		return {
			if: { properties: { kind: { const: kind } }, required: ['kind'] },
			then: {
				properties: {
					input: {
						type: 'object',
						additionalProperties: false,
						properties,
						required: Object.keys(properties),
					},
				},
			},
		};
	});
	function normalize(value) {
		if (Array.isArray(value)) return value.map(normalize);
		if (!value || typeof value !== 'object') return value;
		const { format, ...rest } = value;
		if (format) {
			const bounds = {
				uint32: [0, 4294967295],
				int32: [-2147483648, 2147483647],
				uint: [0, Number.MAX_SAFE_INTEGER],
			}[format];
			if (bounds) Object.assign(rest, { minimum: bounds[0], maximum: bounds[1] });
			else if (format !== 'double') throw new Error(`Unmapped native format: ${format}`);
		}
		return Object.fromEntries(
			Object.entries(rest).map(([key, item]) => [key, normalize(item)])
		);
	}
	const schema = normalize({
		type: 'object',
		additionalProperties: false,
		properties: {
			kind: { type: 'string', enum: Object.keys(modes) },
			input: {
				type: 'object',
				description:
					'Select the matching kind branch; all nested native contracts are defined below.',
			},
		},
		required: ['kind', 'input'],
		allOf: variants,
		$defs: definitions,
	});
	const generated = await format(
		`// Generated from Narrative Lens v${provenance.version} standalone.schema.json (SHA-256 ${provenance.fullSha256}).\n// Regenerate with scripts/generate-narrative-annotation-schema.mjs; do not edit by hand.\nimport type { ToolSchema } from './types.js';\nexport const annotationInputSchema: ToolSchema = ${JSON.stringify(schema, null, '\t')};\n`,
		{ ...(await resolveConfig(fileURLToPath(output))), filepath: fileURLToPath(output) }
	);
	if (check) {
		if (readFileSync(outputPath, 'utf8') !== generated)
			throw new Error(
				'Generated annotation schema is stale; run node scripts/generate-narrative-annotation-schema.mjs'
			);
	} else writeFileSync(outputPath, generated);
}

async function main(args) {
	const options = {};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === '--check' && !options.check) options.check = true;
		else if (
			arg === '--output' &&
			!options.outputPath &&
			args[index + 1] &&
			!args[index + 1].startsWith('--')
		)
			options.outputPath = args[++index];
		else if (!arg.startsWith('-') && !options.inputPath) options.inputPath = arg;
		else
			throw new Error(
				'Usage: node scripts/generate-narrative-annotation-schema.mjs [upstream.schema.json] [--output file] [--check]'
			);
	}
	await generateAnnotationSchema(options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
	main(process.argv.slice(2)).catch((error) => {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	});
