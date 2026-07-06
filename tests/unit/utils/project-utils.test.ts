import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import {
	ensureProjectDataDirectory,
	getQueueStatePath,
	getCacheDirectory,
} from '../../../src/utils/project-utils.js';

/**
 * Create a minimal valid Scrivener project directory (a `.scriv` folder that
 * contains a `.scrivx` file) so that ensureProjectDataDirectory's
 * project-validity check passes.
 */
function createValidScrivProject(projectPath: string): void {
	mkdirSync(projectPath, { recursive: true });
	const projectName = projectPath
		.split('/')
		.pop()!
		.replace(/\.scriv$/, '');
	writeFileSync(
		join(projectPath, `${projectName}.scrivx`),
		'<?xml version="1.0"?><ScrivenerProject></ScrivenerProject>'
	);
}

describe('Project Utils', () => {
	let tmpBase: string;
	let testProjectPath: string;
	// Runtime state now lives under `.scrivener-mcp`, not `data`.
	let mcpDir: string;

	beforeEach(() => {
		tmpBase = join(tmpdir(), `scrivener-mcp-test-${randomUUID()}`);
		testProjectPath = join(tmpBase, 'test-project.scriv');
		mcpDir = join(testProjectPath, '.scrivener-mcp');
		createValidScrivProject(testProjectPath);
	});

	afterEach(() => {
		if (existsSync(tmpBase)) {
			rmSync(tmpBase, { recursive: true, force: true });
		}
	});

	describe('ensureProjectDataDirectory', () => {
		it('should create data directory if it does not exist', async () => {
			expect(existsSync(mcpDir)).toBe(false);

			await ensureProjectDataDirectory(testProjectPath);

			expect(existsSync(mcpDir)).toBe(true);
		});

		it('should not throw if directory already exists', async () => {
			mkdirSync(mcpDir, { recursive: true });
			expect(existsSync(mcpDir)).toBe(true);

			await expect(ensureProjectDataDirectory(testProjectPath)).resolves.not.toThrow();
		});

		it('should handle nested path creation', async () => {
			const nestedProjectPath = join(tmpBase, 'nested', 'deep', 'project.scriv');
			const nestedMcpDir = join(nestedProjectPath, '.scrivener-mcp');
			createValidScrivProject(nestedProjectPath);

			await ensureProjectDataDirectory(nestedProjectPath);
			expect(existsSync(nestedMcpDir)).toBe(true);
		});

		it('should handle project path with trailing slash', async () => {
			const projectPathWithSlash = testProjectPath + '/';

			await ensureProjectDataDirectory(projectPathWithSlash);

			expect(existsSync(mcpDir)).toBe(true);
		});
	});

	describe('getQueueStatePath', () => {
		it('should return correct queue state path', () => {
			const result = getQueueStatePath(testProjectPath);
			expect(result).toBe(join(testProjectPath, '.scrivener-mcp', 'queue-state.json'));
		});

		it('should handle project path with trailing slash', () => {
			const projectPathWithSlash = testProjectPath + '/';
			const result = getQueueStatePath(projectPathWithSlash);
			expect(result).toBe(join(testProjectPath, '.scrivener-mcp', 'queue-state.json'));
		});

		it('should work with different project paths', () => {
			const differentProject = '/home/user/novel.scriv';
			const result = getQueueStatePath(differentProject);
			expect(result).toBe('/home/user/novel.scriv/.scrivener-mcp/queue-state.json');
		});
	});

	describe('getCacheDirectory', () => {
		it('should return correct cache directory path', () => {
			const result = getCacheDirectory(testProjectPath);
			expect(result).toBe(join(testProjectPath, '.scrivener-mcp', 'cache'));
		});

		it('should handle project path with trailing slash', () => {
			const projectPathWithSlash = testProjectPath + '/';
			const result = getCacheDirectory(projectPathWithSlash);
			expect(result).toBe(join(testProjectPath, '.scrivener-mcp', 'cache'));
		});

		it('should work with different project paths', () => {
			const differentProject = '/home/user/story.scriv';
			const result = getCacheDirectory(differentProject);
			expect(result).toBe('/home/user/story.scriv/.scrivener-mcp/cache');
		});
	});

	describe('Path normalization', () => {
		it('should handle Windows-style paths', () => {
			const windowsPath = 'C:\\Users\\Author\\project.scriv';
			const result = getQueueStatePath(windowsPath);
			expect(result).toContain('queue-state.json');
		});

		it('should handle relative paths', () => {
			const relativePath = './my-project.scriv';
			const result = getCacheDirectory(relativePath);
			expect(result).toContain('.scrivener-mcp');
			expect(result).toContain('cache');
		});
	});
});
