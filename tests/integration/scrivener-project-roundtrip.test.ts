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
});
