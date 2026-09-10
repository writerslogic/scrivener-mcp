/**
 * Integration tests for ScrivenerProject — round-trip read/write on the real fixture.
 * These guard against regressions in the XML parser and document manager that
 * would only surface by corrupting actual manuscripts in production.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ScrivenerProject } from '../../src/scrivener-project.js';

const FIXTURE = path.join(process.cwd(), 'tests', 'sample-project.scriv');
const CHAPTER1_ID = '95A0E87E-0497-4ADA-8A51-8855420732BC';
const CHAPTER2_ID = '0BFBFA71-F1E9-401C-8A78-97B10BC12399';
// Has synopsis.txt and notes.rtf on disk but no MetaData.Synopsis/Notes in the
// .scrivx — the layout every real Scrivener 3 project uses.
const TITLE_PAGE_ID = '684ADA52-4D45-48D2-B03D-5ECB784963EE';

describe('ScrivenerProject — fixture round-trip', () => {
	let project: ScrivenerProject;
	let workDir: string;

	beforeAll(async () => {
		// Operate on a disposable copy so the write-path tests below never touch
		// the checked-in fixture (writeDocument() also updates a checksum file
		// that a content.rtf-only backup/restore would miss).
		workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scrivener-roundtrip-'));
		const projectCopy = path.join(workDir, 'sample-project.scriv');
		await fs.cp(FIXTURE, projectCopy, { recursive: true });

		project = new ScrivenerProject(projectCopy);
		await project.loadProject();
	}, 30000);

	afterAll(async () => {
		await project.close();
		await fs.rm(workDir, { recursive: true, force: true });
	});

	it('loads the project and returns metadata', async () => {
		const meta = await project.getProjectMetadata();
		expect(meta).toBeDefined();
		expect(typeof meta).toBe('object');
	});

	it('returns a binder structure with a root node', async () => {
		const structure = await project.getStructure();
		expect(structure).toBeDefined();
		expect(structure.root).toBeDefined();
	});

	it('reads Chapter-01 content without throwing', async () => {
		const doc = await project.getDocument(CHAPTER1_ID);
		expect(doc).not.toBeNull();
		expect(typeof doc.content).toBe('string');
	});

	it('reads Chapter-02 content without throwing', async () => {
		const doc = await project.getDocument(CHAPTER2_ID);
		expect(doc).not.toBeNull();
		expect(typeof doc.content).toBe('string');
	});

	it('round-trips plain text through write → read', async () => {
		const testContent = 'Round-trip test: Café — naïve résumé.\nSecond paragraph.';
		await project.writeDocument(CHAPTER1_ID, testContent);
		const doc = await project.getDocument(CHAPTER1_ID);
		expect(doc.content).toContain('Round-trip test');
		expect(doc.content).toContain('Caf');
		expect(doc.content).toContain('\n');
	});

	it('throws for an unknown document ID', async () => {
		await expect(project.getDocument('00000000-0000-0000-0000-000000000000')).rejects.toThrow();
	});

	describe('synopsis and notes', () => {
		it('reads synopsis.txt and notes.rtf from disk, not the .scrivx MetaData block', async () => {
			const info = await project.getDocumentInfo(TITLE_PAGE_ID);

			expect(info.document?.synopsis).toBe('Title page to the manuscript.');
			expect(info.document?.notes).toContain(
				'This is the title page of the manuscript.'
			);
			expect(info.document?.notes).toContain('Section Type');
			expect(info.metadata.synopsis).toBe('Title page to the manuscript.');
		});

		it('degrades to undefined when synopsis.txt/notes.rtf are absent, without throwing', async () => {
			const info = await project.getDocumentInfo(CHAPTER1_ID);

			expect(info.document?.synopsis).toBeUndefined();
			expect(info.document?.notes).toBeUndefined();
			expect(info.metadata.synopsis).toBeUndefined();
			expect(info.metadata.notes).toBeUndefined();
		});

		it('round-trips a synopsis/notes update through update_document to disk and back', async () => {
			await project.updateDocumentMetadata(CHAPTER2_ID, {
				synopsis: 'Updated synopsis for chapter two.',
				notes: 'Updated notes for chapter two.',
			});

			// The in-session index must reflect the update immediately, not just
			// after a reload (see documentIndexer.patchDocumentMetadata).
			const info = await project.getDocumentInfo(CHAPTER2_ID);
			expect(info.document?.synopsis).toBe('Updated synopsis for chapter two.');
			expect(info.document?.notes).toBe('Updated notes for chapter two.');

			// And it must actually be on disk where Scrivener's own UI reads it.
			const synopsisPath = path.join(
				workDir,
				'sample-project.scriv',
				'Files',
				'Data',
				CHAPTER2_ID,
				'synopsis.txt'
			);
			const onDisk = await fs.readFile(synopsisPath, 'utf-8');
			expect(onDisk).toBe('Updated synopsis for chapter two.');
		});
	});
});
