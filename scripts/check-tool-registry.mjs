/**
 * Tool-registry gate. tsc and eslint cannot see these problems: duplicate tool
 * names, a hidden tool leaking into the public surface, or a tool missing its
 * 5/5 metadata (title, annotations with all four behavior hints, a substantive
 * description, and a description on every input parameter).
 *
 * Runs against the built output (the registry pulls in the HMS module, which
 * uses top-level await and so cannot be loaded by the CommonJS test runner):
 *
 *   npm run build && node scripts/check-tool-registry.mjs
 *
 * Exits 0 when the surface is clean, 1 (with a report) when it is not.
 */
import {
	initializeSkillRegistry,
	activateSkills,
	getRegisteredTools,
} from '../dist/handlers/skill-registry.js';

const HINT_KEYS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];
const HIDDEN = [
	'find_analogies',
	'hhm_dream',
	'build_vector_store',
	'multi_agent_analysis',
	'store_chapter_order',
	'sync_to_neo4j',
	'get_queue_stats',
];

initializeSkillRegistry();
activateSkills(
	'project',
	'documents',
	'search',
	'analysis',
	'compilation',
	'memory',
	'relationships',
	'advanced'
);

const tools = getRegisteredTools();
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
	const props = t.inputSchema?.properties ?? {};
	for (const [param, schema] of Object.entries(props)) {
		if (!(typeof schema.description === 'string' && schema.description.length > 0)) {
			problems.push(`${t.name}.${param}: undocumented parameter`);
		}
	}
}

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
	'enhance_content',
	'generate_content',
	'remember',
	'suggest_improvements',
	'generate_marketing_materials',
	'add_relationship',
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
		if (!(typeof sub.description === 'string' && sub.description.length > 0)) {
			gaps.push(`${path}.${key}: undescribed`);
		}
		schemaDescriptionGaps(sub, `${path}.${key}`, gaps);
	}
	if (schema.items) schemaDescriptionGaps(schema.items, `${path}[]`, gaps);
	if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
		schemaDescriptionGaps(schema.additionalProperties, `${path}{}`, gaps);
	}
}

for (const t of tools) {
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

const out = (line) => process.stdout.write(`${line}\n`);
const dataCount = tools.filter((t) => !TEXT_ONLY.has(t.name)).length;
out(`Registry: ${tools.length} tools, ${dupes.length} duplicate names, ${dataCount} data tools.`);
if (problems.length) {
	out(`FAIL — ${problems.length} problem(s):`);
	for (const p of problems) out(`  - ${p}`);
	process.exit(1);
}
out('OK — every registered tool is 5/5 (title, annotations, description, param docs) and');
out('    every data tool declares an outputSchema.');
process.exit(0);
