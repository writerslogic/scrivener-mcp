/**
 * Tool-registry gate. tsc and eslint cannot see these problems: duplicate tool
 * names, a hidden tool leaking into the public surface, or a tool missing its
 * 5/5 metadata (title, annotations with all four behavior hints, a substantive
 * description, and a description on every input parameter).
 *
 * Runs against the built output, or directly against source with the tsx loader:
 *
 *   npm run build && node scripts/check-tool-registry.mjs
 *   node --import tsx scripts/check-tool-registry.mjs --source
 *
 * Exits 0 when the surface is clean, 1 (with a report) when it is not.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HINT_KEYS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];
const HIDDEN = [
	'find_analogies',
	'hhm_dream',
	'build_vector_store',
	'multi_agent_analysis',
	'store_chapter_order',
	'sync_to_neo4j',
];

// Tools that intentionally return only human-readable text or an action ack, so
// they legitimately carry no outputSchema (MCP makes outputSchema optional).
const TEXT_ONLY = new Set([
	'open_project',
	'refresh_project',
	'close_project',
	'read_document',
	'write_document',
	'delete_document',
	'move_document',
	'update_document',
	'restore_document',
	'set_writing_goal',
	'set_writing_preferences',
	'collect_feedback',
	'cancel_job',
	'use_skill',
]);
// Every declared property in an outputSchema — at any depth (object properties,
// array items, additionalProperties) — must carry a description, so the schema is
// substantive rather than a hollow shell that games "outputSchema present".
function schemaDescriptionGaps(schema, path, gaps) {
	if (!schema || typeof schema !== 'object') return;
	if (schema.properties && Object.keys(schema.properties).length === 0) {
		gaps.push(`${path}: empty properties`);
	}
	for (const [key, sub] of Object.entries(schema.properties ?? {})) {
		if (!(typeof sub?.description === 'string' && sub.description.trim().length > 0)) {
			gaps.push(`${path}.${key}: undescribed`);
		}
		schemaDescriptionGaps(sub, `${path}.${key}`, gaps);
	}
	if (Array.isArray(schema.items)) {
		schema.items.forEach((item, index) =>
			schemaDescriptionGaps(item, `${path}[${index}]`, gaps)
		);
	} else if (schema.items) schemaDescriptionGaps(schema.items, `${path}[]`, gaps);
	if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
		schemaDescriptionGaps(schema.additionalProperties, `${path}{}`, gaps);
	}
	for (const keyword of ['oneOf', 'anyOf', 'allOf', 'prefixItems']) {
		for (const [index, variant] of (schema[keyword] ?? []).entries()) {
			schemaDescriptionGaps(variant, `${path}.${keyword}[${index}]`, gaps);
		}
	}
	for (const keyword of ['$defs', 'definitions', 'patternProperties']) {
		for (const [key, definition] of Object.entries(schema[keyword] ?? {})) {
			schemaDescriptionGaps(definition, `${path}.${keyword}.${key}`, gaps);
		}
	}
}

export function inspectToolRegistry(tools) {
	const names = tools.map((t) => t.name);
	const problems = [];
	const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
	if (dupes.length) problems.push(`duplicate names: ${dupes.join(', ')}`);
	const leaked = HIDDEN.filter((n) => names.includes(n));
	if (leaked.length) problems.push(`hidden tools exposed: ${leaked.join(', ')}`);
	for (const t of tools) {
		if (!t.title) problems.push(`${t.name}: missing title`);
		if ((t.description ?? '').length < 60) problems.push(`${t.name}: description too thin`);
		const anno = t.annotations ?? {};
		if (!t.annotations || HINT_KEYS.some((k) => typeof anno[k] !== 'boolean')) {
			problems.push(`${t.name}: annotations missing a behavior hint`);
		}
		for (const [param, schema] of Object.entries(t.inputSchema?.properties ?? {})) {
			if (!(
				typeof schema?.description === 'string' && schema.description.trim().length > 0
			)) {
				problems.push(`${t.name}.${param}: undocumented parameter`);
			}
		}
		const dataTool = !TEXT_ONLY.has(t.name);
		if (dataTool && !t.outputSchema) problems.push(`${t.name}: data tool missing outputSchema`);
		if (!dataTool && t.outputSchema) {
			problems.push(`${t.name}: text-only tool unexpectedly declares outputSchema`);
		}
		if (t.outputSchema) {
			const gaps = [];
			schemaDescriptionGaps(t.outputSchema, `${t.name}.outputSchema`, gaps);
			for (const g of gaps) problems.push(g);
		}
	}
	return {
		problems,
		duplicateCount: dupes.length,
		dataCount: tools.filter((t) => !TEXT_ONLY.has(t.name)).length,
	};
}

async function main(args) {
	if (args.length && (args.length !== 1 || args[0] !== '--source')) {
		throw new Error('Usage: node [--import tsx] scripts/check-tool-registry.mjs [--source]');
	}
	process.env.SCRIVENER_MCP_EAGER_TOOLS = '1';
	const { initializeSkillRegistry, getRegisteredTools } = await import(
		args[0] === '--source'
			? '../src/handlers/skill-registry.ts'
			: '../dist/handlers/skill-registry.js'
	);
	initializeSkillRegistry();
	const tools = getRegisteredTools();
	const { problems, duplicateCount, dataCount } = inspectToolRegistry(tools);
	const out = (line) => process.stdout.write(`${line}\n`);
	out(
		`Registry: ${tools.length} tools, ${duplicateCount} duplicate names, ${dataCount} data tools.`
	);
	if (problems.length) {
		out(`FAIL — ${problems.length} problem(s):`);
		for (const p of problems) out(`  - ${p}`);
		process.exit(1);
	}
	out('OK — every registered tool is 5/5 (title, annotations, description, param docs) and');
	out('    every data tool declares an outputSchema.');
	process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
	main(process.argv.slice(2)).catch((error) => {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	});
