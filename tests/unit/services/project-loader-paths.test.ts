import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ProjectLoader } from '../../../src/services/project-loader.js';

const scrivxContent = '<ScrivenerProject><Binder /></ScrivenerProject>';

describe('ProjectLoader Scrivener path discovery', () => {
	let tempRoot: string;

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scrivener-loader-'));
	});

	afterEach(async () => {
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it('loads the only .scrivx file when the file name differs from the project folder', async () => {
		const projectPath = path.join(tempRoot, 'WindowsNovel.scriv');
		await fs.mkdir(projectPath, { recursive: true });
		await fs.writeFile(path.join(projectPath, 'Manuscript.scrivx'), scrivxContent);

		const structure = await new ProjectLoader(projectPath).loadProject();

		expect(structure.ScrivenerProject).toBeDefined();
	});

	it('uses an explicit .scrivx path when one was resolved by the caller', async () => {
		const projectPath = path.join(tempRoot, 'ExplicitNovel.scriv');
		const scrivxPath = path.join(projectPath, 'ExplicitNovel.SCRIVX');
		await fs.mkdir(projectPath, { recursive: true });
		await fs.writeFile(scrivxPath, scrivxContent);

		const structure = await new ProjectLoader(projectPath, { scrivxPath }).loadProject();

		expect(structure.ScrivenerProject).toBeDefined();
	});
});
