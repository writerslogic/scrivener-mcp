import { ErrorCode } from '../../../src/core/errors.js';
import { CompilationService } from '../../../src/services/compilation-service.js';
import { documentIndexer } from '../../../src/services/document-indexer.js';
import { DocumentManager } from '../../../src/services/document-manager.js';
import { ProjectContent } from '../../../src/services/project-content.js';
import type { ScrivenerDocument } from '../../../src/types/index.js';
import { TEMP_DIR } from '../../setup.js';

describe('ProjectContent search with an initialized binder index', () => {
	const documents: ScrivenerDocument[] = [
		{
			id: 'one',
			title: 'First scene',
			type: 'Text',
			path: '/First scene',
			synopsis: 'Secret meeting',
		},
		{ id: 'two', title: 'Second scene', type: 'Text', path: '/Second scene' },
		{ id: 'trash', title: 'Discarded scene', type: 'Text', path: '/Trash/Discarded scene' },
		{ id: 'folder', title: 'Folder', type: 'Folder', path: '/Folder' },
	];
	let content: Map<string, string>;
	let manager: DocumentManager;
	let project: ProjectContent;

	beforeEach(async () => {
		content = new Map([
			['one', 'Alice met Bob beneath the Silver Bridge.'],
			['two', 'ALICE met BOB beyond the silver bridge.'],
			['trash', 'Alice met Bob in a discarded scene.'],
		]);
		manager = new DocumentManager(TEMP_DIR);
		await documentIndexer.buildIndex(documents.filter((doc) => doc.id !== 'trash'));
		project = new ProjectContent(
			manager,
			new CompilationService(),
			async (id) => {
				const text = content.get(id);
				if (text === undefined) throw new Error('Unreadable document');
				return text;
			},
			async (includeTrash) => documents.filter((doc) => includeTrash || doc.id !== 'trash'),
			async () => {
				throw new Error('Unused document info');
			},
			async () => {
				throw new Error('Unused compile metadata');
			},
			() => true
		);
	});

	afterEach(async () => {
		documentIndexer.clearIndex();
		await manager.close();
	});

	it('finds phrases in fresh content without priming the word index', async () => {
		const results = await project.searchContent('silver bridge');
		expect(results.map((result) => result.documentId)).toEqual(['one', 'two']);
		expect(results[0].matches).toEqual(['Alice met Bob beneath the Silver Bridge.']);
	});

	it('matches original text case exactly', async () => {
		const results = await project.searchContent('Alice met Bob', { caseSensitive: true });
		expect(results.map((result) => result.documentId)).toEqual(['one']);
	});

	it('matches regular expressions spanning words and punctuation', async () => {
		const results = await project.searchContent('^ALICE.*bridge\\.$', {
			regex: true,
			caseSensitive: true,
		});
		expect(results.map((result) => result.documentId)).toEqual(['two']);
	});

	it('honors the trash scope', async () => {
		expect(await project.searchContent('discarded')).toEqual([]);
		const results = await project.searchContent('discarded', { includeTrash: true });
		expect(results.map((result) => result.documentId)).toEqual(['trash']);
	});

	it('reflects edits on the next search', async () => {
		await project.searchContent('silver bridge');
		content.set('one', 'A newly revised scene.');
		expect(
			(await project.searchContent('silver bridge')).map((result) => result.documentId)
		).toEqual(['two']);
		expect(
			(await project.searchContent('newly revised')).map((result) => result.documentId)
		).toEqual(['one']);
	});

	it('searches metadata only when requested', async () => {
		expect(await project.searchContent('Secret meeting')).toEqual([]);
		const results = await project.searchContent('Secret meeting', { searchMetadata: true });
		expect(results.map((result) => result.documentId)).toEqual(['one']);
		expect(results[0].matches).toEqual(['Synopsis: Secret meeting...']);
	});

	it('skips unreadable documents without dropping other results', async () => {
		content.delete('one');
		expect(
			(await project.searchContent('silver bridge')).map((result) => result.documentId)
		).toEqual(['two']);
	});

	it('rejects invalid regular expressions with the existing error code', async () => {
		await expect(project.searchContent('[', { regex: true })).rejects.toMatchObject({
			code: ErrorCode.INVALID_INPUT,
		});
	});

	it('returns no results for an empty query', async () => {
		expect(await project.searchContent('')).toEqual([]);
	});
});
