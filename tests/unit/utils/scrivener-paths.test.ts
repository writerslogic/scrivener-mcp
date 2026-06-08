import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
	findScrivxPath,
	getDefaultScrivxPath,
	resolveScrivenerProjectPath,
} from '../../../src/utils/scrivener-utils.js';
import { ErrorCode } from '../../../src/utils/common.js';

describe('Scrivener project path utilities', () => {
	let tempRoot: string;

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scrivener-paths-'));
	});

	afterEach(async () => {
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	async function createProject(projectName: string, scrivxName = `${projectName}.scrivx`) {
		const projectPath = path.join(tempRoot, `${projectName}.scriv`);
		const scrivxPath = path.join(projectPath, scrivxName);

		await fs.mkdir(projectPath, { recursive: true });
		await fs.writeFile(scrivxPath, '<ScrivenerProject><Binder /></ScrivenerProject>');

		return { projectPath, scrivxPath };
	}

	it('builds the default .scrivx path from a project folder name with spaces', async () => {
		const { projectPath } = await createProject('My Novel');

		expect(getDefaultScrivxPath(projectPath)).toBe(path.join(projectPath, 'My Novel.scrivx'));
	});

	it('resolves a direct .scrivx file to its project directory', async () => {
		const { projectPath, scrivxPath } = await createProject('Direct Path');

		await expect(resolveScrivenerProjectPath(scrivxPath)).resolves.toEqual({
			projectPath,
			scrivxPath,
		});
	});

	it('finds a case-different .scrivx file for Windows project folders', async () => {
		const { projectPath, scrivxPath } = await createProject('CaseTest', 'casetest.SCRIVX');

		await expect(findScrivxPath(projectPath)).resolves.toBe(scrivxPath);
	});

	it('falls back to a single alternate .scrivx file in the project folder', async () => {
		const { projectPath, scrivxPath } = await createProject('Container', 'Manuscript.scrivx');

		await expect(findScrivxPath(projectPath)).resolves.toBe(scrivxPath);
	});

	it('rejects regular files that are not .scrivx projects', async () => {
		const filePath = path.join(tempRoot, 'notes.txt');
		await fs.writeFile(filePath, 'not a project');

		await expect(resolveScrivenerProjectPath(filePath)).rejects.toMatchObject({
			code: ErrorCode.INVALID_INPUT,
		});
	});
});
