/**
 * Project utilities with proper error handling and security
 * Consolidated from project-utils and project-utils-fixed
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { getLogger } from '../core/logger.js';
import { FileUtils, PathUtils, AsyncUtils } from './shared-patterns.js';
import { AppError, ErrorCode } from './common.js';
import { findScrivxPath } from './scrivener-utils.js';

const logger = getLogger('project-utils');

interface CacheConfig {
	maxSizeMB: number;
	maxFiles: number;
	maxAgeMs: number;
}

const _DEFAULT_CACHE_CONFIG: CacheConfig = {
	maxSizeMB: 100,
	maxFiles: 1000,
	maxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
};

async function isScrivenerProject(projectPath: string): Promise<boolean> {
	try {
		await findScrivxPath(projectPath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Ensure the .scrivener-mcp directory exists with proper structure and security
 */
export async function ensureProjectDataDirectory(projectPath: string): Promise<string> {
	const validPath = PathUtils.validate(projectPath);

	// Verify it's actually a Scrivener project
	if (!(await isScrivenerProject(validPath))) {
		throw new AppError(`Not a valid Scrivener project: ${validPath}`, ErrorCode.INVALID_INPUT);
	}

	const mcpDir = PathUtils.build(validPath, '.scrivener-mcp');
	const cacheDir = PathUtils.build(mcpDir, 'cache');
	const backupDir = PathUtils.build(mcpDir, 'backups');
	const contextDir = PathUtils.build(mcpDir, 'context');

	// Create directories with proper permissions
	await FileUtils.ensureDir(mcpDir, 0o755);
	await FileUtils.ensureDir(cacheDir, 0o755);
	await FileUtils.ensureDir(backupDir, 0o755);
	await FileUtils.ensureDir(contextDir, 0o755);

	// Create README with safe atomic write
	const readmePath = PathUtils.build(mcpDir, 'README.md');
	const readmeContent = `# Scrivener MCP Data Directory

This directory contains persistent editorial history and cached data for the Scrivener MCP integration.

## Structure:
- \`cache/\` - Temporary cache files (auto-cleaned after 7 days)
- \`backups/\` - Project backups
- \`context/\` - AI context and memory files
- \`editorial.sqlite\` (plus WAL/SHM companions) - Proposed changes, applications, undo/recovery journals, facts, findings, passage index and durable workflows
- \`exports/\` - Generated manuscripts and beta-reader drafts

## Important:
- Back up this directory with the project. Deleting it loses review, undo and workflow history.
- Cache files are automatically cleaned up
- Backups are kept according to your retention settings

Generated: ${new Date().toISOString()}
`;

	if (!(await FileUtils.exists(readmePath))) {
		await FileUtils.safeWrite(readmePath, readmeContent);
		logger.debug('Created README.md in .scrivener-mcp directory');
	} else {
		const current = await fs.readFile(readmePath, 'utf8');
		if (current.startsWith('# Scrivener MCP Data Directory')) {
			const updated = current
				.replace(
					'This directory contains cached data and temporary files for the Scrivener MCP integration.',
					'This directory contains persistent editorial history and cached data for the Scrivener MCP integration.'
				)
				.replace(
					'- This directory is safe to delete if you want to reset the integration',
					'- Back up this directory with the project. Deleting it loses proposals, application and undo journals, facts, findings and workflow checkpoints stored in editorial.sqlite.'
				);
			if (updated !== current) await FileUtils.safeWrite(readmePath, updated);
		}
	}

	// Safely add to .gitignore
	await addToGitignoreSafely(validPath);

	return mcpDir;
}

/**
 * Safely add .scrivener-mcp to .gitignore with atomic operations
 */
async function addToGitignoreSafely(projectPath: string): Promise<void> {
	const gitignorePath = PathUtils.build(projectPath, '.gitignore');

	if (!(await FileUtils.exists(gitignorePath))) {
		return; // No .gitignore file exists
	}

	const lockPath = `${gitignorePath}.lock`;
	const lockTimeout = 5000; // 5 seconds
	const startTime = Date.now();

	// Acquire lock with timeout
	while (true) {
		try {
			// Try to create lock file exclusively
			await fs.writeFile(lockPath, process.pid.toString(), { flag: 'wx' });
			break; // Lock acquired
		} catch (error: unknown) {
			const err = error as { code?: string };
			if (err.code !== 'EEXIST') throw error;

			// Check timeout
			if (Date.now() - startTime > lockTimeout) {
				logger.warn('Timeout waiting for .gitignore lock, skipping');
				return;
			}

			// Check for stale lock
			try {
				const lockStat = await fs.stat(lockPath);
				const lockAge = Date.now() - lockStat.mtime.getTime();

				// Remove stale lock (older than 30 seconds)
				if (lockAge > 30000) {
					await fs.unlink(lockPath).catch(() => {});
				}
			} catch {
				// Lock doesn't exist, retry
			}

			// Wait before retry
			await AsyncUtils.sleep(100);
		}
	}

	try {
		const content = await fs.readFile(gitignorePath, 'utf-8');
		const lines = content.split('\n');

		if (!lines.some((line) => line.trim() === '.scrivener-mcp/')) {
			lines.push('', '# Scrivener MCP cache', '.scrivener-mcp/');
			const newContent = lines.join('\n');
			await FileUtils.safeWrite(gitignorePath, newContent);
			logger.debug('Added .scrivener-mcp/ to .gitignore');
		}
	} finally {
		await fs.unlink(lockPath).catch(() => {});
	}
}

export function getQueueStatePath(projectPath: string): string {
	return path.join(projectPath, '.scrivener-mcp', 'queue-state.json');
}

export function getCacheDirectory(projectPath: string): string {
	return path.join(projectPath, '.scrivener-mcp', 'cache');
}

export function getVectorsDirectory(projectPath: string): string {
	return path.join(projectPath, '.scrivener-mcp', 'vectors');
}

/**
 * Clean up old cache files
 */
export async function cleanupCache(
	projectPath: string,
	maxAgeMs: number = 7 * 24 * 60 * 60 * 1000
): Promise<void> {
	const cacheDir = getCacheDirectory(projectPath);

	try {
		const files = await fs.readdir(cacheDir);
		const now = Date.now();

		for (const file of files) {
			const filePath = path.join(cacheDir, file);
			const stats = await fs.stat(filePath);

			if (now - stats.mtime.getTime() > maxAgeMs) {
				await fs.unlink(filePath);
				logger.debug('Deleted old cache file', { file });
			}
		}
	} catch (error) {
		logger.debug('Cache cleanup failed or not needed', { error });
	}
}
