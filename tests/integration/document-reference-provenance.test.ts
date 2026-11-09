import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/server';
import { SQLiteManager } from '../../src/handlers/database/sqlite-manager.js';
import { CachedSQLiteManager } from '../../src/handlers/database/keydb-cache.js';
import { PersistentStore } from '../../src/services/editorial/persistent-store.js';
import { ProjectSource } from '../../src/services/editorial/project-source.js';
import { RTFHandler } from '../../src/services/parsers/rtf-handler.js';
import { documentGraphHandlers } from '../../src/handlers/document-graph-handlers.js';
import type { HandlerContext } from '../../src/handlers/types.js';
import { disposeSpool, readResult } from '../../src/core/response-formatter.js';
import type { ScrivenerDocument } from '../../src/types/index.js';

const tools = new Map(documentGraphHandlers.map((tool) => [tool.name, tool]));
const validator = new AjvJsonSchemaValidator();
const outputs = new Map(
	documentGraphHandlers.map((tool) => [
		tool.name,
		validator.getValidator(tool.outputSchema as JsonSchemaType),
	])
);
const inputs = new Map(
	documentGraphHandlers.map((tool) => [
		tool.name,
		validator.getValidator(tool.inputSchema as JsonSchemaType),
	])
);
const rtf = new RTFHandler();
let root: string;
let store: PersistentStore;
let sqlite: SQLiteManager;
let source: ProjectSource;
let context: HandlerContext;
let items: ScrivenerDocument[];

async function save(id: string, text: string) {
	await writeFile(join(root, `${id}.rtf`), rtf.convertToRTF(text));
}
async function call(name: string, args: Record<string, unknown> = {}) {
	const response = await tools.get(name)!.handler(args, context);
	expect(response.isError).not.toBe(true);
	expect(inputs.get(name)!(args).valid).toBe(true);
	expect(outputs.get(name)!(response.structuredContent).valid).toBe(true);
	expect(JSON.parse(response.content[0].text!)).toEqual(response.structuredContent);
	let data = response.structuredContent!;
	if (typeof data._ref === 'string') {
		expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(4000);

		let offset: number | null = 0,
			json = '';
		do {
			const part = readResult(data._ref, offset, 1024);
			expect(Buffer.byteLength(part.text)).toBeLessThanOrEqual(1024);
			json += part.text;
			offset = part.nextOffset;
		} while (offset !== null);
		data = JSON.parse(json);
		expect(outputs.get(name)!(data).valid).toBe(true);
	}
	return data;
}

beforeEach(async () => {
	jest.spyOn(CachedSQLiteManager.prototype, 'initialize').mockResolvedValue(undefined);
	root = await realpath(await mkdtemp(join(tmpdir(), 'scrivener-references-')));
	store = new PersistentStore(join(root, 'editorial.sqlite'));
	sqlite = new SQLiteManager(join(root, 'registry.sqlite'));
	await sqlite.initialize();
	sqlite.execute('CREATE TABLE IF NOT EXISTS locations(id TEXT PRIMARY KEY, name TEXT NOT NULL)');
	for (const [id, name] of [
		['mara', 'Mara'],
		['elodie', 'Élodie'],
		['ghost', 'Ghost'],
	])
		sqlite.execute('INSERT INTO characters(id, name) VALUES (?, ?)', [id, name]);
	sqlite.execute('INSERT INTO locations(id, name) VALUES (?, ?)', ['harbor', 'Harbor']);
	items = ['draft', 'research', 'excluded'].map((id) => ({
		id,
		title: id,
		path: id,
		type: 'Text',
	}));
	source = new ProjectSource(
		root,
		store,
		async () => [items[0]],
		async (id) => readFile(join(root, `${id}.rtf`), 'utf8'),
		async () => items
	);
	context = {
		project: { getEditorialServices: () => ({ source }) },
		databaseService: { getSQLite: () => sqlite },
	} as unknown as HandlerContext;
	await save('draft', 'Mara visits Harbor.');
	await save('research', 'Élodie lives in Harbor.');
	await save('excluded', 'Mara and Élodie travel.');
});

afterEach(async () => {
	jest.restoreAllMocks();
	await sqlite.close();
	store.close();
	await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
	disposeSpool();
});

test('reads actual saved RTF across active source scope and returns source/registry provenance', async () => {
	const list = jest.spyOn(source, 'list');
	const result = await call('get_entity_references', { documentId: 'draft' });
	expect(list).not.toHaveBeenCalled();
	expect(result.mentions).toEqual([
		{ entityId: 'mara', entityName: 'Mara', type: 'character', count: 1, positions: [0] },
		{ entityId: 'harbor', entityName: 'Harbor', type: 'location', count: 1, positions: [12] },
	]);
	expect(result.availability).toEqual({ status: 'available', unavailableRegistries: [] });
	expect(result.coverage).toMatchObject({
		scope: 'selected-document',
		documents: 1,
		entities: 4,
	});
	expect(result.envelope).toMatchObject({
		sourceFormat: 'saved-rtf',
		sourceRevisions: [await source.read('draft')].map(({ documentId, revision }) => ({
			documentId,
			revision,
		})),
		engine: { name: 'scrivener-mcp', version: null },
		policy: { mode: 'local', revisionChecked: true, providerAccess: false },
	});
	expect(result.registryRevision).toMatch(/^[a-f0-9]{64}$/);
	expect((await source.list()).map(({ documentId }) => documentId)).toEqual(['draft']);
});

test('includes Research and excluded Draft references rather than reporting mentioned entities as orphans', async () => {
	const references = await call('get_entity_references', { entity: 'Élodie' });
	expect(references.coverage).toMatchObject({ scope: 'all-active-text', documents: 3 });
	expect(references.documents).toEqual([
		{ documentId: 'research', title: 'research', count: 1 },
		{ documentId: 'excluded', title: 'excluded', count: 1 },
	]);
	const orphans = await call('find_orphaned_entities');
	expect(orphans.orphans).toEqual([{ id: 'ghost', name: 'Ghost', type: 'character' }]);
	expect(orphans.registrySize).toBe(4);
});

test('suggests only measured cross-document co-occurrence with its supporting registry identity', async () => {
	const result = await call('suggest_connections', { documentId: 'draft' });
	expect(result.suggestions).toEqual([
		{
			entityId: 'elodie',
			entityName: 'Élodie',
			type: 'character',
			coOccurrences: 2,
			relatedTo: ['Harbor', 'Mara'],
		},
	]);
});

test.each([true, false])(
	'resolves an exact registry ID before a conflicting name when mentioned=%s',
	async (mentioned) => {
		sqlite.execute('UPDATE characters SET name = ? WHERE id = ?', ['Captain', 'mara']);
		sqlite.execute('INSERT INTO characters(id, name) VALUES (?, ?)', ['a-shadow', 'mara']);
		await save('draft', mentioned ? 'Mara Mara Captain.' : 'Mara Mara.');
		const result = await call('get_entity_references', { entity: 'mara' });
		expect(result.documents).toEqual(
			mentioned ? [{ documentId: 'draft', title: 'draft', count: 1 }] : []
		);
	}
);

test('requires a registry ID for an ambiguous name while retaining exact ID queries', async () => {
	sqlite.execute('INSERT INTO locations(id, name) VALUES (?, ?)', ['other-mara', 'Mara']);
	await expect(call('get_entity_references', { entity: 'MARA' })).rejects.toThrow(
		'ambiguous; provide its unique registry ID'
	);
	expect((await call('get_entity_references', { entity: 'mara' })).documents).toHaveLength(2);
});

test('preserves valid character findings while explicitly reporting an unavailable location registry', async () => {
	sqlite.execute('DROP TABLE locations');
	const result = await call('get_entity_references', { documentId: 'draft' });
	expect(result.mentions).toEqual([
		{ entityId: 'mara', entityName: 'Mara', type: 'character', count: 1, positions: [0] },
	]);
	expect(result.availability).toEqual({
		status: 'partial',
		unavailableRegistries: ['locations'],
	});
});

test('reports registry absence explicitly while allowing actual source failures to propagate', async () => {
	context.databaseService = undefined;
	expect((await call('find_orphaned_entities')).availability).toEqual({
		status: 'unavailable',
		unavailableRegistries: ['characters', 'locations'],
	});
	await rm(join(root, 'draft.rtf'));
	await expect(call('find_orphaned_entities')).rejects.toThrow();
});

test('propagates a broken registry connection instead of returning successful empty findings', async () => {
	await sqlite.close();
	await expect(call('find_orphaned_entities')).rejects.toThrow('Database not initialized');
});

test('propagates unexpected registry acquisition errors instead of disguising them as expected absence', async () => {
	context.databaseService = {
		getSQLite: () => {
			throw new Error('Registry acquisition failed');
		},
	} as unknown as HandlerContext['databaseService'];
	await expect(call('get_entity_references', { entity: 'Mara' })).rejects.toThrow(
		'Registry acquisition failed'
	);
});

test.each(['text', 'registry', 'binder'])(
	'rejects %s changes during source reads without returning stale evidence',
	async (change) => {
		const list = source.list.bind(source);
		jest.spyOn(source, 'list').mockImplementationOnce(async (options) => {
			const saved = await list(options);
			expect(sqlite.getDatabase().isTransaction).toBe(false);
			if (change === 'text') await save('draft', 'Changed text.');
			if (change === 'registry')
				sqlite.execute('UPDATE characters SET name = ? WHERE id = ?', ['Renamed', 'mara']);
			if (change === 'binder') items[0].title = 'Renamed scene';
			return saved;
		});
		await expect(call('get_entity_references', { entity: 'Mara' })).rejects.toThrow(
			'changed during reference analysis'
		);
	}
);

test('keeps every source offset in a spooled Unicode report beyond the former 100-position cap', async () => {
	const text = '🌙 Élodie '.repeat(1200).trim();
	await save('research', text);
	const result = await call('get_entity_references', { documentId: 'research' });
	expect(result.mentions).toEqual([
		{
			entityId: 'elodie',
			entityName: 'Élodie',
			type: 'character',
			count: 1200,
			positions: Array.from({ length: 1200 }, (_, index) => index * 10 + 3),
		},
	]);
});

test.each([255, 256, 257])(
	'bounds registry admission at %i entries before reading saved documents',
	async (count) => {
		sqlite.execute('DELETE FROM characters');
		sqlite.execute('DELETE FROM locations');
		sqlite.getDatabase().transaction(() => {
			for (let i = 0; i < count; i++)
				sqlite.execute('INSERT INTO characters(id,name) VALUES (?,?)', [
					`entity-${i}`,
					`Name${i}`,
				]);
		})();
		const list = jest.spyOn(source, 'list');
		if (count > 256) {
			await expect(call('find_orphaned_entities')).rejects.toThrow(
				'bounded reference-analysis input limits'
			);
			expect(list).not.toHaveBeenCalled();
		} else expect((await call('find_orphaned_entities')).registrySize).toBe(count);
	}
);

test.each([1999, 2000, 2001])(
	'validates a %i-character registry name before matching',
	async (length) => {
		sqlite.execute('UPDATE characters SET name = ? WHERE id = ?', [
			'x'.repeat(length),
			'ghost',
		]);
		if (length > 2000)
			await expect(call('find_orphaned_entities')).rejects.toThrow('2000 characters');
		else expect((await call('find_orphaned_entities')).registrySize).toBe(4);
	}
);

test('rejects ambiguous entity identifiers across registries rather than merging their identities', async () => {
	sqlite.execute('INSERT INTO locations(id,name) VALUES (?,?)', ['mara', 'Different Place']);
	await expect(call('find_orphaned_entities')).rejects.toThrow('ambiguous');
});

test('rejects a malformed stored identifier instead of changing its identity in returned evidence', async () => {
	sqlite.execute('UPDATE characters SET id = ? WHERE id = ?', [' mara ', 'mara']);
	await expect(call('get_entity_references', { entity: 'Mara' })).rejects.toThrow(
		'surrounding whitespace'
	);
});

test.each([
	{},
	{ documentId: 'draft', entity: 'Mara' },
	{ documentId: null },
	{ entity: '' },
	{ entity: 7 },
	{ documentId: 'draft', extra: true },
])('rejects malformed reference input consistently with its schema: %j', async (args) => {
	expect(inputs.get('get_entity_references')!(args).valid).toBe(false);
	await expect(tools.get('get_entity_references')!.handler(args, context)).rejects.toThrow();
});

test.each(['get_entity_references', 'suggest_connections'])(
	'rejects an inactive document in %s',
	async (name) => {
		await expect(call(name, { documentId: 'missing' })).rejects.toThrow(
			/selected project scope|not active text/
		);
	}
);
