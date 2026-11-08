import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/server';
import { PersistentStore } from '../../src/services/editorial/persistent-store.js';
import { ProjectSource } from '../../src/services/editorial/project-source.js';
import type { ManuscriptSource, SourceDocument } from '../../src/services/editorial/types.js';
import { RelationshipEngine, relationshipInput } from '../../src/services/relationship-engine.js';
import type { Neo4jManager } from '../../src/handlers/database/neo4j-manager.js';
import { relationshipHandlers } from '../../src/handlers/relationship-handlers.js';
import type { HandlerContext } from '../../src/handlers/types.js';
import { RTFHandler } from '../../src/services/parsers/rtf-handler.js';
import { disposeSpool, readResult } from '../../src/core/response-formatter.js';

const tools = new Map(relationshipHandlers.map((tool) => [tool.name, tool]));
const validator = new AjvJsonSchemaValidator();
const outputValidators = new Map(
	relationshipHandlers.map((tool) => [
		tool.name,
		validator.getValidator(tool.outputSchema as JsonSchemaType),
	])
);
const inputValidators = new Map(
	relationshipHandlers.map((tool) => [
		tool.name,
		validator.getValidator(tool.inputSchema as JsonSchemaType),
	])
);
const rtf = new RTFHandler();
let root: string;
let store: PersistentStore;
let source: ProjectSource;
let engine: RelationshipEngine;
let context: HandlerContext;
let documentIds: string[];
let connections: PersistentStore[];
const edge = (head: string, tail = 'Story') => ({
	head,
	headType: 'Character' as const,
	relation: 'appears_in',
	tail,
	tailType: 'Theme' as const,
});

async function save(id: string, text: string) {
	if (!documentIds.includes(id)) documentIds.push(id);
	await writeFile(join(root, `${id}.rtf`), rtf.convertToRTF(text));
}

async function call(name: string, args: Record<string, unknown> = {}) {
	const response = await tools.get(name)!.handler(args, context);
	if (response.structuredContent) {
		expect(inputValidators.get(name)!(args).valid).toBe(true);
		expect(outputValidators.get(name)!(response.structuredContent).valid).toBe(true);
		expect(JSON.parse(response.content[0].text!)).toEqual(response.structuredContent);
	}
	return response;
}

function retrieve(value: Record<string, unknown>) {
	if (typeof value._ref !== 'string') return value;

	let offset: number | null = 0;
	let json = '';
	do {
		const page = readResult(value._ref, offset, 1024);
		expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(1024);
		json += page.text;
		offset = page.nextOffset;
	} while (offset !== null);
	return JSON.parse(json) as Record<string, unknown>;
}

function useDocuments(documents: SourceDocument[]) {
	const fixture = {
		projectId: source.projectId,
		projectPath: root,
		list: jest.fn(async () => documents),
		read: async () => documents[0],
	} satisfies ManuscriptSource;
	engine = new RelationshipEngine(fixture, store);
	return fixture;
}

const document = (id: string, text = ''): SourceDocument => ({
	projectId: source.projectId,
	documentId: id,
	title: id,
	path: id,
	revision: 'saved-revision',
	text,
	order: 0,
	metadata: {},
});

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), 'scrivener-relationships-')));
	store = new PersistentStore(join(root, 'editorial.sqlite'));
	connections = [];
	documentIds = [];
	source = new ProjectSource(
		root,
		store,
		async () => documentIds.map((id) => ({ id, title: id, type: 'Text', path: id })),
		async (id) => readFile(join(root, `${id}.rtf`), 'utf8')
	);
	engine = new RelationshipEngine(source, store);
	context = {
		project: { getEditorialServices: () => ({ source, store, relationships: engine }) },
	} as unknown as HandlerContext;
	await save('scene-1', 'Mara met Élodie and 李雷.');
});

afterEach(async () => {
	jest.restoreAllMocks();
	for (const connection of connections) connection.close();
	store.close();
	await rm(root, { recursive: true, force: true });
});

afterAll(async () => {
	disposeSpool();
});

test('records exact directed edges idempotently and retrieves incoming as well as outgoing relationships', async () => {
	const input = {
		head: 'Mara',
		headType: 'Character',
		relation: 'mentors',
		tail: 'Élodie',
		tailType: 'Character',
	};
	const first = await call('add_relationship', input);
	expect(first.isError).not.toBe(true);
	expect((await call('add_relationship', input)).structuredContent).toEqual(
		first.structuredContent
	);
	engine.addRelationship(edge('Unrelated'));
	const incoming = (await call('find_relationships', { entity: 'Élodie' })).structuredContent!;
	expect(incoming).toMatchObject({
		relationships: [{ ...input, id: first.structuredContent!.id }],
		total: 1,
		truncated: false,
		projectId: source.projectId,
	});
	expect(
		(await call('find_relationships', { entity: 'Mara', relation: 'unknown' }))
			.structuredContent
	).toMatchObject({ relationships: [], total: 0 });
	expect((await call('find_relationships', { entity: 'ara' })).structuredContent).toMatchObject({
		relationships: [],
		total: 0,
	});
});

test('survives reopening the real store and isolates another project without HMS or Neo4j', async () => {
	engine.addRelationship({ ...edge('Mara', 'Élodie'), tailType: 'Character' });
	const before = engine.getCharacterNetwork();
	store.close();
	store = new PersistentStore(join(root, 'editorial.sqlite'));
	engine = new RelationshipEngine(source, store);
	expect(engine.getCharacterNetwork()).toEqual(before);
	const second = new PersistentStore(join(root, 'other', 'editorial.sqlite'));
	connections.push(second);
	const isolated = new RelationshipEngine(
		{
			projectId: 'other',
			projectPath: root,
			list: async () => [],
			read: async () => {
				throw new Error('unused');
			},
		},
		second
	);
	expect(isolated.getCharacterNetwork().network).toEqual({});
	expect((await call('find_relationships', { entity: 'Mara' })).structuredContent).toMatchObject({
		total: 1,
	});
});

test('retains prototype-shaped names and both endpoints in the complete network', async () => {
	engine.addRelationship({ ...edge('__proto__', 'constructor'), tailType: 'Character' });
	engine.addRelationship({ ...edge('toString', '__proto__'), tailType: 'Character' });
	const network = (await call('character_network')).structuredContent!.network;
	expect(network).toEqual(
		JSON.parse(
			'{"__proto__":[{"target":"constructor","relation":"appears_in"}],"constructor":[],"toString":[{"target":"__proto__","relation":"appears_in"}]}'
		)
	);
	expect(Object.prototype).not.toHaveProperty('target');
});

test('keeps delimiter-like names distinct and preserves metadata across idempotent public writes', async () => {
	const properties = { evidence: { note: 'keep' } };
	const first = engine.addRelationship({ ...edge('A--B'), properties });
	const second = engine.addRelationship(edge('A‒‒B'));
	expect(first).not.toBe(second);
	properties.evidence.note = 'caller mutation';
	await call('add_relationship', edge('A--B'));
	const saved = engine.findRelated('A--B').relationships[0];
	expect(saved.properties).toEqual({ evidence: { note: 'keep' } });
	(saved.properties!.evidence as { note: string }).note = 'returned mutation';
	expect(engine.findRelated('A--B').relationships[0].properties).toEqual({
		evidence: { note: 'keep' },
	});
});

test('rolls back a failed store write and reports failure without committing an edge', async () => {
	const put = store.put.bind(store);
	jest.spyOn(store, 'put').mockImplementation((namespace, id, value) => {
		put(namespace, id, value);
		throw new Error('fixture-private-storage-detail');
	});
	const response = await call('add_relationship', edge('Mara'));
	expect(response.isError).toBe(true);
	expect(JSON.stringify(response)).not.toContain('fixture-private-storage-detail');
	expect(engine.findRelated('Mara').relationships).toEqual([]);
});

test('reports a closed store as unavailable rather than a successful empty network', async () => {
	store.close();
	expect((await call('character_network')).isError).toBe(true);
});

test('rejects stored corruption rather than inventing a valid relationship', async () => {
	store.put('story:relationships', 'corrupt', { head: 'Mara', headType: 'Bogus' });
	expect((await call('find_relationships', { entity: 'Mara' })).isError).toBe(true);
});

test('enforces 9999/10000/10001 admission without evicting edges, including a second SQLite owner', () => {
	store.transaction(() => {
		for (let i = 0; i < 9999; i++) {
			const rel = relationshipInput(edge(`character-${i}`));
			store.put('story:relationships', rel.id, rel);
		}
	});
	expect(store.count('story:relationships')).toBe(9999);
	const last = engine.addRelationship(edge('last'));
	expect(store.count('story:relationships')).toBe(10000);
	const second = new PersistentStore(join(root, 'editorial.sqlite'));
	connections.push(second);
	const competitor = new RelationshipEngine(source, second);
	expect(() => competitor.addRelationship(edge('overflow'))).toThrow('10000');
	expect(competitor.addRelationship(edge('last'))).toBe(last);
	expect(store.count('story:relationships')).toBe(10000);
});

test.each([127, 128, 129])('validates entity name length %i before writes', async (length) => {
	const response = await call('add_relationship', edge('x'.repeat(length)));
	expect(response.isError === true).toBe(length > 128);
	expect(store.count('story:relationships')).toBe(length > 128 ? 0 : 1);
});

test.each([63, 64, 65])('validates relationship label length %i', async (length) => {
	const response = await call('add_relationship', {
		...edge('Mara'),
		relation: 'x'.repeat(length),
	});
	expect(response.isError === true).toBe(length > 64);
});

test.each([1023, 1024, 1025])('validates property JSON byte length %i', (bytes) => {
	const properties = { v: 'x'.repeat(bytes - JSON.stringify({ v: '' }).length) };
	expect(Buffer.byteLength(JSON.stringify(properties))).toBe(bytes);
	if (bytes > 1024)
		expect(() => engine.addRelationship({ ...edge('Mara'), properties })).toThrow('1024');
	else expect(engine.addRelationship({ ...edge('Mara'), properties })).toMatch(/^[a-f0-9]{64}$/);
});

test.each([0, 1, 99, 100, 101, 1.5, null])(
	'validates retrieval limit %j in schema and runtime',
	async (k) => {
		const valid = Number.isInteger(k) && Number(k) >= 1 && Number(k) <= 100;
		for (const name of ['find_relationships', 'discover_connections']) {
			const args = name === 'find_relationships' ? { entity: 'Mara', k } : { k };
			expect(inputValidators.get(name)!(args).valid).toBe(valid);
			expect((await call(name, args)).isError === true).toBe(!valid);
		}
	}
);

test.each([
	{ head: '' },
	{ head: ' ' },
	{ head: '\0' },
	{ headType: 'Person' },
	{ tailType: null },
	{ relation: 3 },
	{ extra: true },
])('rejects invalid relationship arguments: %j', async (patch) => {
	const args = { ...edge('Mara'), ...patch };
	expect(inputValidators.get('add_relationship')!(args).valid).toBe(false);
	expect((await call('add_relationship', args)).isError).toBe(true);
	expect(store.count('story:relationships')).toBe(0);
});

test('returns measured co-occurrence candidates with saved revisions and excludes already recorded pairs', async () => {
	for (const name of ['Mara', 'Élodie', '李雷']) engine.addRelationship(edge(name));
	engine.addRelationship({ ...edge('Mara', 'Élodie'), tailType: 'Character' });
	await save('scene-2', 'Mara and Élodie sailed.');
	await save('scene-3', '李雷 stayed.');
	const response = await call('discover_connections');
	expect(response.isError).not.toBe(true);
	const result = retrieve(response.structuredContent!);
	expect(result).toMatchObject({
		total: 2,
		truncated: false,
		method: 'literal-whole-word-co-occurrence',
		coverage: { documents: 3, entities: 3 },
	});
	const candidates = result.connections as Array<{
		entity1: string;
		entity2: string;
		strength: number;
		documentIds: string[];
	}>;
	expect(candidates.map((candidate) => [candidate.entity1, candidate.entity2].sort())).toEqual(
		expect.arrayContaining([
			['Mara', '李雷'],
			['Élodie', '李雷'],
		])
	);
	for (const candidate of candidates) {
		expect(candidate.strength).toBeCloseTo(1 / 3);
		expect(candidate.documentIds).toEqual(['scene-1']);
	}
	expect(result.envelope).toMatchObject({
		sourceRevisions: (await source.list()).map(({ documentId, revision }) => ({
			documentId,
			revision,
		})),
		engine: { name: 'scrivener-mcp', version: null },
		policy: {
			mode: 'local',
			providerAccess: false,
			allowsRawNativeAnalysis: false,
			revisionChecked: true,
		},
	});
	const limited = retrieve((await call('discover_connections', { k: 1 })).structuredContent!);
	expect(limited).toMatchObject({ total: 2, truncated: true, connections: [candidates[0]] });
});

test('checks presence without materializing every offset when only document co-occurrence is requested', async () => {
	engine.addRelationship(edge('A'));
	engine.addRelationship(edge('B'));
	useDocuments([document('dense', 'A B '.repeat(500001))]);
	const response = await call('discover_connections');
	expect(response.isError).not.toBe(true);
	expect(retrieve(response.structuredContent!)).toMatchObject({
		connections: [{ strength: 1, documentIds: ['dense'] }],
		total: 1,
	});
});

test('detects saved edits and graph changes during discovery without returning stale results', async () => {
	engine.addRelationship(edge('Mara'));
	engine.addRelationship(edge('Élodie'));
	const first = document('scene', 'Mara and Élodie.');
	const fixture = useDocuments([first]);
	fixture.list
		.mockResolvedValueOnce([first])
		.mockResolvedValueOnce([{ ...first, revision: 'changed' }]);
	expect((await call('discover_connections')).isError).toBe(true);
	fixture.list.mockImplementation(async () => {
		engine.addRelationship(edge('Added'));
		return [first];
	});
	expect((await call('discover_connections')).isError).toBe(true);
});

test.each([255, 256, 257])(
	'enforces discovery entity bound %i before reading source',
	async (count) => {
		store.transaction(() => {
			for (let i = 0; i < count; i++) engine.addRelationship(edge(`Name${i}`));
		});
		const fixture = useDocuments([]);
		const response = await call('discover_connections');
		expect(response.isError === true).toBe(count > 256);
		if (count > 256) expect(fixture.list).not.toHaveBeenCalled();
	}
);

test.each([999, 1000, 1001])('enforces discovery document bound %i', async (count) => {
	useDocuments(Array.from({ length: count }, (_, index) => document(`scene-${index}`)));
	expect((await call('discover_connections')).isError === true).toBe(count > 1000);
});

test.each([2097151, 2097152, 2097153])(
	'enforces discovery source character bound %i',
	async (length) => {
		useDocuments([document('scene', 'x'.repeat(length))]);
		expect((await call('discover_connections')).isError === true).toBe(length > 2097152);
	}
);

test.each([1048575, 1048576, 1048577])(
	'enforces combined work bound for 128 entities and %i characters',
	async (length) => {
		store.transaction(() => {
			for (let i = 0; i < 128; i++) engine.addRelationship(edge(`Name${i}`));
		});
		useDocuments([document('scene', 'x'.repeat(length))]);
		expect((await call('discover_connections')).isError === true).toBe(length > 1048576);
	}
);

test('retrieves a large Unicode graph without losing or duplicating any edge', async () => {
	store.transaction(() => {
		for (let i = 0; i < 200; i++)
			engine.addRelationship({
				...edge(`Élodie-🌙-${i}`, `李雷-${i}`),
				tailType: 'Character',
			});
	});
	const expected = engine.getCharacterNetwork();
	const response = await call('character_network');
	expect(response.structuredContent).toHaveProperty('_ref');
	expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(4000);
	expect(retrieve(response.structuredContent!)).toEqual(expected);
});

test('paginates 101 exact relationships once at a fixed graph revision and rejects stale continuation', async () => {
	store.transaction(() => {
		for (let i = 0; i < 101; i++) engine.addRelationship(edge('Mara', `Topic-${i}`));
	});
	const first = retrieve(
		(await call('find_relationships', { entity: 'Mara', k: 100 })).structuredContent!
	);
	expect(first).toMatchObject({ total: 101, offset: 0, nextOffset: 100, truncated: true });
	const request = {
		entity: 'Mara',
		k: 100,
		offset: first.nextOffset,
		graphRevision: first.graphRevision,
	};
	const second = retrieve((await call('find_relationships', request)).structuredContent!);
	expect(second).toMatchObject({ total: 101, offset: 100, nextOffset: null, truncated: false });
	const combined = [
		...(first.relationships as Array<{ id: string }>),
		...(second.relationships as Array<{ id: string }>),
	];
	expect(combined).toEqual(engine.snapshot().relationships);
	expect(new Set(combined.map(({ id }) => id)).size).toBe(101);
	expect((await call('find_relationships', { entity: 'Mara', offset: 100 })).isError).toBe(true);
	engine.addRelationship(edge('Mara', 'New topic'));
	expect((await call('find_relationships', request)).isError).toBe(true);
});

test.each([4095, 4096, 4097])(
	'bounds the internal chapter sequence at %i entries and preserves stored order',
	async (count) => {
		const chapters = Array.from({ length: count }, (_, index) => `chapter-${index}`);
		const response = await call('store_chapter_order', { sequenceId: 'draft', chapters });
		expect(response.isError === true).toBe(count > 4096);
		if (count <= 4096)
			expect(store.get('story:sequences', 'draft')).toEqual({ id: 'draft', chapters });
		else expect(store.get('story:sequences', 'draft')).toBeUndefined();
	}
);

test('internal graph synchronization reports unavailable and partial outcomes without false success', async () => {
	expect((await call('sync_to_neo4j')).isError).toBe(true);
	engine.addRelationship(edge('Mara'));
	engine.addRelationship(edge('Élodie'));
	const query = jest
		.fn()
		.mockResolvedValueOnce({ records: [] })
		.mockImplementationOnce(async (_cypher, parameters) => ({
			records: [{ get: () => parameters.id }],
		}));
	const graph = { isAvailable: () => true, query } as unknown as Neo4jManager;
	engine = new RelationshipEngine(source, store, () => graph);
	const response = await call('sync_to_neo4j');
	expect(response.isError).toBe(true);
	expect(response.structuredContent).toMatchObject({ synced: 1, errors: 1, status: 'partial' });
	for (const [cypher, parameters] of query.mock.calls) {
		expect(cypher).toContain('projectId: $projectId');
		expect(parameters.projectId).toBe(source.projectId);
		expect(cypher).not.toContain(parameters.head);
	}
	expect(engine.snapshot().relationships).toHaveLength(2);
});
