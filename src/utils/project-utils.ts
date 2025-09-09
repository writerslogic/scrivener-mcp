/**
 * Utility functions for managing project-specific data
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { getLogger } from '../core/logger.js';
import { ensureDir, safeReadFile, safeWriteFile } from './common.js';

const logger = getLogger('project-utils');

/**
 * Ensure the .scrivener-mcp directory exists and is properly configured
 */
export async function ensureProjectDataDirectory(projectPath: string): Promise<string> {
	const mcpDir = path.join(projectPath, '.scrivener-mcp');

	try {
		// Create the directory using common utility
		await ensureDir(mcpDir);
		logger.debug('Ensured .scrivener-mcp directory exists', { path: mcpDir });

		// Create a README explaining what this directory is for
		const readmePath = path.join(mcpDir, 'README.md');
		try {
			await fs.access(readmePath);
		} catch {
			// File doesn't exist, create it
			const readmeContent = `# Scrivener MCP Data Directory

This directory contains cached data and queue state for the Scrivener MCP server.

## Contents

- \`queue-state.json\` - Job queue persistence data
- \`cache/\` - Cached analysis results
- \`vectors/\` - Vector embeddings for semantic search

## Notes

- This directory is automatically created and managed by the Scrivener MCP server
- It's safe to delete this directory; it will be recreated when needed
- Add \`.scrivener-mcp/\` to your \`.gitignore\` to avoid committing cached data

## Privacy

All data in this directory is derived from your Scrivener project and never leaves your machine.
`;
			await fs.writeFile(readmePath, readmeContent);
			logger.debug('Created README in .scrivener-mcp directory');
		}

		// Add to .gitignore if it exists
		await addToGitignore(projectPath);

		return mcpDir;
	} catch (error) {
		logger.error('Failed to ensure project data directory', { error });
		throw error;
	}
}

/**
 * Add .scrivener-mcp to .gitignore if the file exists
 */
async function addToGitignore(projectPath: string): Promise<void> {
	const gitignorePath = path.join(projectPath, '.gitignore');

	try {
		// Check if .gitignore exists
		const gitignoreContent = await safeReadFile(gitignorePath);

		// Check if .scrivener-mcp is already in .gitignore
		if (!gitignoreContent.includes('.scrivener-mcp')) {
			// Add it
			const updatedContent = `${gitignoreContent.trim()}\n\n# Scrivener MCP cache\n.scrivener-mcp/\n`;
			await safeWriteFile(gitignorePath, updatedContent);
			logger.debug('Added .scrivener-mcp to .gitignore');
		}
	} catch (error) {
		// .gitignore doesn't exist or can't be read, that's ok
		logger.debug('.gitignore not found or not writable', { error });
	}
}

/**
 * Get the path to the queue state file for a project
 */
export function getQueueStatePath(projectPath: string): string {
	return path.join(projectPath, '.scrivener-mcp', 'queue-state.json');
}

/**
 * Get the path to the cache directory for a project
 */
export function getCacheDirectory(projectPath: string): string {
	return path.join(projectPath, '.scrivener-mcp', 'cache');
}

/**
 * Get the path to the vectors directory for a project
 */
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
