import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
	StdioClientTransport,
	getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { cp, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerEntry } from './runtime.js';

export interface FirstSessionResult {
	ok: true;
	projectPath: string;
	proposalId: string;
	checks: { protocol: true; analysis: true; editPreview: true; manuscriptUnchanged: true };
	privacy: string;
}

export async function firstSession(
	entry: ServerEntry,
	destination?: string
): Promise<FirstSessionResult> {
	const root = destination
		? resolve(destination)
		: await mkdtemp(join(tmpdir(), 'scrivener-first-session-'));
	if (destination) await mkdir(root, { recursive: false, mode: 0o700 });
	const projectPath = join(root, 'Welcome.scriv');
	await cp(
		fileURLToPath(new URL('../../assets/sample-project/Welcome.scriv', import.meta.url)),
		projectPath,
		{ recursive: true, errorOnExist: true, force: false }
	);
	const transport = new StdioClientTransport({
		command: entry.command,
		args: entry.args,
		stderr: 'pipe',
		cwd: root,
		env: {
			...getDefaultEnvironment(),
			...entry.env,
			SCRIVENER_DISABLE_KEY_DISCOVERY: '1',
			SCRIVENER_SKIP_SETUP: 'true',
			SCRIVENER_QUIET: 'true',
			SCRIVENER_LOCAL_ONLY: 'true',
			SCRIVENER_DATA_DIR: join(root, 'server-state'),
			LOG_LEVEL: 'ERROR',
		},
	});
	transport.stderr?.on('data', () => undefined);
	const client = new Client(
		{ name: 'scrivener-first-session', version: '1' },
		{ capabilities: {} }
	);
	const call = async (
		name: string,
		args: Record<string, unknown>
	): Promise<Record<string, unknown>> => {
		const result = await client.callTool({ name, arguments: args }, undefined, {
			timeout: 60_000,
		});
		if (result.isError)
			throw new Error(`First-session ${name} failed; run redacted diagnostics for details`);
		return (result.structuredContent ?? {}) as Record<string, unknown>;
	};
	try {
		await client.connect(transport);
		await call('open_project', { path: projectPath });
		const documentId = '10000000-0000-4000-8000-000000000003';
		const file = join(projectPath, 'Files', 'Data', documentId, 'content.rtf');
		const before = createHash('sha256')
			.update(await readFile(file))
			.digest('hex');
		const analysis = await call('analyze_document', { documentId });
		if (!Object.keys(analysis).length)
			throw new Error('First-session analysis returned no structured results');
		const proposed = await call('review_changes', {
			action: 'propose',
			documentId,
			expectedRevision: before,
			edits: [{ start: 0, end: 0, text: 'A new opening. ' }],
			title: 'First-session sample preview',
			idempotencyKey: 'first-session-preview',
		});
		const proposal = proposed.result as { id?: string } | undefined;
		if (!proposal?.id) throw new Error('First-session proposal was not persisted');
		const preview = await call('review_changes', {
			action: 'preview',
			proposalId: proposal.id,
		});
		const data = preview.result as { before?: string; after?: string } | undefined;
		if (
			typeof data?.before !== 'string' ||
			typeof data.after !== 'string' ||
			data.before === data.after
		)
			throw new Error('First-session preview did not contain a real text change');
		const after = createHash('sha256')
			.update(await readFile(file))
			.digest('hex');
		if (before !== after)
			throw new Error('First-session preview unexpectedly modified the sample manuscript');
		await call('close_project', {});
		return {
			ok: true,
			projectPath,
			proposalId: proposal.id,
			checks: {
				protocol: true,
				analysis: true,
				editPreview: true,
				manuscriptUnchanged: true,
			},
			privacy:
				'This session used local analysis, disabled provider discovery and sampling, and touched only its new sample directory. No client configuration was changed.',
		};
	} finally {
		await client.close();
	}
}
