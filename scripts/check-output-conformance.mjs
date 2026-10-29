/**
 * Runtime output-conformance gate. The registry gate proves each data tool
 * DECLARES a substantive outputSchema; this proves the tool actually RETURNS a
 * structuredContent that VALIDATES against that schema when invoked for real.
 *
 * It uses the canonical registry with throwaway project and credential assets,
 * exercises local-only paths, and validates structuredContent with ajv.
 * Provider and external graph calls are outside this gate's plan.
 *
 *   npm run build && node scripts/check-output-conformance.mjs
 *
 * Exits 0 when every exercised tool conforms, 1 on any missing/invalid result.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Ajv from 'ajv';
import { redactDiagnostics } from '../dist/setup/redaction.js';
import { ContentAnalyzer } from '../dist/analysis/base-analyzer.js';
import { ContentEnhancer } from '../dist/services/enhancements/content-enhancer.js';
import {
	initializeSkillRegistry,
	getRegisteredTools,
	executeRegisteredHandler,
} from '../dist/handlers/skill-registry.js';
import { createC2paTestSigner } from './create-c2pa-fixtures.mjs';

const out = (l) => process.stdout.write(`${l}\n`);
const ajv = new Ajv({ strict: false, allErrors: true });

const PLAN = [
	['c2pa_capabilities', {}],
	[
		'sign_content_credentials',
		(context) => ({
			assetPath: context.credentialAssetPath,
			outputPath: context.credentialManifestPath,
			mode: 'sidecar',
		}),
	],
	[
		'validate_content_credentials',
		(context) => ({
			assetPath: context.credentialAssetPath,
			manifestPath: context.credentialManifestPath,
		}),
	],
	['manuscript_dashboard', {}],
	['review_changes', { action: 'list' }],
	['search_passages', { query: 'fear', mode: 'semantic' }],
	['semantic_search', { query: 'fear' }],
	['search', { query: 'storm' }],
	['check_consistency', {}],
	['continuity_findings', { action: 'list' }],
	['manage_series', { action: 'list' }],
	[
		'story_bible',
		(context) => ({
			action: 'list',
			scope: { kind: 'project', id: context.project.getEditorialServices().source.projectId },
		}),
	],
	['editorial_workflow', { action: 'list' }],
	['export_manuscript', { preset: 'ebook' }],
	['get_structure', {}],
	['get_statistics', {}],
	['get_compile_settings', {}],
	['find_orphaned_entities', {}],
	['get_entity_references', 'NEEDS_DOC'],
	['get_entity_references', { entity: 'storm' }],
	['suggest_connections', 'NEEDS_DOC'],
	['verify_project_integrity', {}],
	['list_trash', {}],
	['search', { query: 'storm', field: 'title' }],
	['find_mentions', { entity: 'storm' }],
	['get_writing_goals', {}],
	['get_writing_preferences', {}],
	['analyze_document', 'NEEDS_DOC'],
	[
		'create_document',
		{ title: 'Conformance Probe', content: 'A sample paragraph about a storm.', force: true },
	],
	['get_document_info', 'NEEDS_DOC'],
	['read_annotations', 'NEEDS_DOC'],
];

function copyDir(src, dst) {
	fs.mkdirSync(dst, { recursive: true });
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		const s = path.join(src, entry.name);
		const d = path.join(dst, entry.name);
		if (entry.isDirectory()) copyDir(s, d);
		else if (entry.isFile()) fs.copyFileSync(s, d);
	}
}

async function main() {
	// Run credit-independent: with no provider key, AI tools take their fallback
	// path, so we validate the degraded-mode structuredContent without spending
	// (or depending on) Claude credits.
	delete process.env.ANTHROPIC_API_KEY;
	delete process.env.OPENAI_API_KEY;
	process.env.SCRIVENER_LOCAL_ONLY = 'true';
	process.env.SCRIVENER_DISABLE_KEY_DISCOVERY = '1';

	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriv-conf-'));
	process.env.SCRIVENER_DATA_DIR = path.join(tmp, 'server-state');
	const projPath = path.join(tmp, 'sample-project.scriv');
	copyDir(path.join(process.cwd(), 'tests', 'sample-project.scriv'), projPath);

	const context = {
		project: null,
		memoryManager: null,
		contentAnalyzer: new ContentAnalyzer(),
		contentEnhancer: new ContentEnhancer(),
		credentialAssetPath: path.join(tmp, 'credential-source.txt'),
		credentialManifestPath: path.join(tmp, 'credential-source.c2pa'),
	};
	process.env.SCRIVENER_MCP_EAGER_TOOLS = '1';
	initializeSkillRegistry();
	const byName = new Map(
		getRegisteredTools().map((tool) => [
			tool.name,
			{
				...tool,
				handler: (args, current) => executeRegisteredHandler(tool.name, args, current),
			},
		])
	);
	const credentialVariables = [
		'SCRIVENER_C2PA_CERT_PATH',
		'SCRIVENER_C2PA_KEY_PATH',
		'SCRIVENER_C2PA_KEY_PASSWORD',
		'SCRIVENER_C2PA_TRUST_ANCHORS_PATH',
	];
	const credentialEnvironment = new Map(
		credentialVariables.map((name) => [name, process.env[name]])
	);

	const results = [];
	let anyDocId = null;
	const record = (r) => {
		results.push(r);
		out(`  ${r.status.padEnd(4)} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
	};
	const withTimeout = (p, ms) =>
		Promise.race([
			p,
			new Promise((_, rej) =>
				setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms)
			),
		]);
	try {
		const signer = await createC2paTestSigner(path.join(tmp, 'credential-signer'));
		Object.assign(process.env, {
			SCRIVENER_C2PA_CERT_PATH: signer.certificatePath,
			SCRIVENER_C2PA_KEY_PATH: signer.privateKeyPath,
			SCRIVENER_C2PA_KEY_PASSWORD: signer.password,
			SCRIVENER_C2PA_TRUST_ANCHORS_PATH: signer.trustAnchorsPath,
		});
		fs.writeFileSync(context.credentialAssetPath, 'Original synthetic CC0 credential fixture.');
		out('opening fixture project...');
		await withTimeout(byName.get('open_project').handler({ path: projPath }, context), 20000);

		// grab a document id for the tools that need one
		const structure = await withTimeout(byName.get('get_structure').handler({}, context), 8000);
		const docs = structure.structuredContent?.documents ?? [];
		anyDocId = docs.find((d) => d.type !== 'Folder')?.id ?? docs[0]?.id ?? null;
		out(`project open; ${docs.length} binder items; sample doc id: ${anyDocId ?? 'none'}`);
		// Regression guard: get_structure must not collapse a non-empty binder to []
		// (it did when the tree builder only descended the first top-level item).
		record({
			name: 'get_structure(non-empty)',
			status: docs.length > 0 ? 'PASS' : 'FAIL',
			detail: docs.length > 0 ? undefined : 'returned 0 items for a non-empty project',
		});

		for (const [name, argsSpec] of PLAN) {
			const tool = byName.get(name);
			if (!tool) {
				record({ name, status: 'FAIL', detail: 'not registered' });
				continue;
			}
			let args = typeof argsSpec === 'function' ? argsSpec(context) : argsSpec;
			if (argsSpec === 'NEEDS_DOC') {
				if (!anyDocId) {
					record({ name, status: 'FAIL', detail: 'no document id available' });
					continue;
				}
				args = { documentId: anyDocId };
			}
			try {
				const nativeCredential = [
					'c2pa_capabilities',
					'sign_content_credentials',
					'validate_content_credentials',
				].includes(name);
				const res = await withTimeout(
					tool.handler(args, context),
					nativeCredential ? 35000 : 8000
				);
				if (name === 'create_document' && res.structuredContent?.documentId) {
					anyDocId = res.structuredContent.documentId;
				}
				if (!tool.outputSchema) {
					record({ name, status: 'FAIL', detail: 'tool has no outputSchema' });
					continue;
				}
				if (res.structuredContent === undefined) {
					record({ name, status: 'FAIL', detail: 'no structuredContent returned' });
					continue;
				}
				const validate = ajv.compile(tool.outputSchema);
				if (validate(res.structuredContent)) {
					record({ name, status: 'PASS' });
				} else {
					record({ name, status: 'FAIL', detail: ajv.errorsText(validate.errors) });
				}
			} catch (err) {
				record({ name, status: 'FAIL', detail: `handler threw: ${err.message}` });
			}
		}

		await withTimeout(byName.get('close_project').handler({}, context), 8000).catch(() => {});
	} finally {
		for (const [name, value] of credentialEnvironment) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		fs.rmSync(tmp, { recursive: true, force: true });
	}

	const pass = results.filter((r) => r.status === 'PASS');
	const fail = results.filter((r) => r.status === 'FAIL');
	const skip = results.filter((r) => r.status === 'SKIP');
	out(`Conformance: ${pass.length} pass, ${fail.length} fail, ${skip.length} skip.`);
	process.exit(fail.length ? 1 : 0);
}

main().catch((err) => {
	const seen = new Set();
	let failure = err;
	while (failure && !seen.has(failure) && seen.size < 4) {
		seen.add(failure);
		out(
			`harness error: ${JSON.stringify(
				redactDiagnostics({
					name: failure.name,
					code: failure.code,
					message: failure.message ?? String(failure),
					stack: failure.stack,
					originalError: failure.details?.originalError,
				})
			)}`
		);
		failure = failure.cause ?? failure.details?.cause;
	}
	process.exit(1);
});
