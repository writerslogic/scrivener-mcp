import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectExporter } from '../../../src/services/project-exporter.js';
import { CompilationService } from '../../../src/services/compilation-service.js';
import { DocumentTree } from '../../../src/services/document-tree.js';
import { RTFHandler } from '../../../src/services/parsers/rtf-handler.js';
import type { ProjectStructure } from '../../../src/types/internal.js';
import type { ScrivenerDocument } from '../../../src/types/index.js';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const FRONT = id(1);
const FIRST = id(4);
const SECOND = id(5);
const EMPTY = id(6);
const RESEARCH = id(8);
const TRASHED = id(10);
const ALTERNATE_TRASH = id(11);
const source: ProjectStructure = {
	ScrivenerProject: {
		Binder: {
			BinderItem: [
				{
					UUID: FRONT,
					Type: 'Text',
					Title: 'Front <script>title()</script>',
					MetaData: { Synopsis: 'Metadata <script>metadata()</script>' },
				},
				{
					UUID: id(2),
					Type: 'DraftFolder',
					Title: 'Manuscript',
					Children: {
						BinderItem: [
							{
								UUID: id(3),
								Type: 'Folder',
								Title: 'Part One',
								Children: {
									BinderItem: [
										{ UUID: FIRST, Type: 'Text', Title: 'First scene' },
										{
											UUID: SECOND,
											Type: 'Text',
											Title: 'Excluded from compile',
											MetaData: { IncludeInCompile: 'No' },
										},
									],
								},
							},
							{ UUID: EMPTY, Type: 'Text', Title: 'Empty scene' },
						],
					},
				},
				{
					UUID: id(7),
					Type: 'ResearchFolder',
					Title: 'Research',
					Children: {
						BinderItem: [{ UUID: RESEARCH, Type: 'Text', Title: 'Research note' }],
					},
				},
				{
					UUID: id(9),
					Type: 'TrashFolder',
					Title: 'Trash',
					Children: { BinderItem: [{ UUID: TRASHED, Type: 'Text', Title: 'Deleted' }] },
				},
			],
			SearchResults: {
				Children: {
					BinderItem: [{ UUID: ALTERNATE_TRASH, Type: 'Text', Title: 'Also deleted' }],
				},
			},
		},
	},
};
const bodies = new Map([
	[FRONT, 'Front body <script>prose()</script>.'],
	[FIRST, 'First body: Café — 東京 😀.'],
	[SECOND, 'Second body: **intentional Markdown**.'],
	[EMPTY, ''],
	[RESEARCH, 'Research body: the harbor ledger.'],
	[TRASHED, 'DELETED CONTENT MUST STAY OUT'],
	[ALTERNATE_TRASH, 'ALTERNATE DELETED CONTENT MUST STAY OUT'],
]);
type TextExport = Awaited<ReturnType<CompilationService['exportProject']>>;

let root: string;
let parser: RTFHandler;
let cached: ScrivenerDocument[];
let exporter: ProjectExporter;
let reads: string[];
let structureReads: number;
let originalFiles: Map<string, Buffer>;

function flatten(documents: ScrivenerDocument[]): ScrivenerDocument[] {
	return documents.flatMap((document) => [document, ...flatten(document.children ?? [])]);
}

function freezeTree(documents: ScrivenerDocument[]): void {
	for (const document of documents) {
		if (document.children) freezeTree(document.children);
		Object.freeze(document);
	}
	Object.freeze(documents);
}

function documentPath(documentId: string): string {
	return path.join(root, 'Files', 'Data', documentId, 'content.rtf');
}

async function readSavedDocument(documentId: string): Promise<string> {
	reads.push(documentId);
	return (await parser.readRTF(documentPath(documentId))).plainText;
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(tmpdir(), 'scrivener-text-export-'));
	parser = new RTFHandler();
	originalFiles = new Map();
	for (const [documentId, text] of bodies) {
		await parser.writeRTF(documentPath(documentId), text);
		originalFiles.set(documentId, await fs.readFile(documentPath(documentId)));
	}
	const tree = new DocumentTree(root, parser, () => source);
	cached = await tree.getProjectStructure();
	freezeTree(cached);
	reads = [];
	structureReads = 0;
	exporter = new ProjectExporter(
		new CompilationService(),
		async () => {
			structureReads++;
			return cached;
		},
		async () => ({ title: 'Synthetic export fixture' }),
		readSavedDocument,
		root
	);
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

test.each(['markdown', 'html', 'json'] as const)(
	'%s exports saved active text in binder order without changing cached metadata or source files',
	async (format) => {
		const before = structuredClone(cached);
		const result = (await exporter.exportProject(format)) as TextExport;
		const markers = ['Front body', 'First body', 'Second body', 'Research body'];
		let previous = -1;
		for (const marker of markers) {
			const position = result.content.indexOf(marker);
			expect(position).toBeGreaterThan(previous);
			previous = position;
		}
		expect(result.content).toContain('Café — 東京 😀');
		expect(result.content).not.toContain('DELETED CONTENT MUST STAY OUT');
		expect(reads).toEqual([FRONT, FIRST, SECOND, EMPTY, RESEARCH]);
		expect(cached).toEqual(before);
		expect(flatten(cached).every((document) => document.content === undefined)).toBe(true);
		for (const [documentId, raw] of originalFiles)
			expect(await fs.readFile(documentPath(documentId))).toEqual(raw);
		if (format === 'json') {
			const exported = flatten(JSON.parse(result.content) as ScrivenerDocument[]);
			expect(exported.find((document) => document.id === EMPTY)?.content).toBe('');
			expect(exported.find((document) => document.id === SECOND)?.includeInCompile).toBe(false);
		} else if (format === 'html') {
			expect(result.content).not.toContain('<script>');
			for (const text of ['title()', 'metadata()', 'prose()'])
				expect(result.content).toContain(`&lt;script&gt;${text}&lt;/script&gt;`);
		} else {
			expect(result.content).toContain('**intentional Markdown**');
		}
	}
);

test('unsupported formats fail before reading project structure or saved text', async () => {
	await expect(exporter.exportProject('unsupported')).rejects.toThrow(/unsupported export format/i);
	expect(structureReads).toBe(0);
	expect(reads).toEqual([]);
});

test('a later export reads newly saved text while reusing the same metadata tree', async () => {
	await exporter.exportProject('markdown');
	await parser.writeRTF(documentPath(FIRST), 'A newly saved chapter.');
	reads = [];
	const result = (await exporter.exportProject('markdown')) as TextExport;
	expect(result.content).toContain('A newly saved chapter.');
	expect(result.content).not.toContain('First body:');
	expect(reads).toEqual([FRONT, FIRST, SECOND, EMPTY, RESEARCH]);
	expect(flatten(cached).every((document) => document.content === undefined)).toBe(true);
});

test.each(['markdown', 'html', 'json'] as const)(
	'%s propagates an unavailable saved chapter rather than returning an incomplete export',
	async (format) => {
		const unavailable = new Error('The saved chapter is unavailable');
		const failing = new ProjectExporter(
			new CompilationService(),
			async () => cached,
			async () => ({}),
			async (documentId) => {
				if (documentId === FIRST) throw unavailable;
				return readSavedDocument(documentId);
			}
		);
		await expect(failing.exportProject(format)).rejects.toBe(unavailable);
		expect(flatten(cached).every((document) => document.content === undefined)).toBe(true);
	}
);

test.each(['markdown', 'html', 'json'] as const)(
	'%s exports an empty active binder without requesting document content',
	async (format) => {
		const empty = new ProjectExporter(
			new CompilationService(),
			async () => [],
			async () => ({}),
			readSavedDocument
		);
		const result = (await empty.exportProject(format)) as TextExport;
		expect(reads).toEqual([]);
		expect(result.metadata.documentCount).toBe(0);
		if (format === 'json') expect(JSON.parse(result.content)).toEqual([]);
		else if (format === 'markdown') expect(result.content).toBe('');
		else expect(result.content).toContain('<!DOCTYPE html>');
	}
);
