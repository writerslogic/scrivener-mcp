/**
 * Project loading and saving service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { parseStringPromise, Builder } from 'xml2js';
import { getLogger } from '../core/logger.js';
import { createError, ErrorCode } from '../core/errors.js';
import type { ProjectStructure, BinderItem } from '../types/internal.js';
import {
	ensureDir,
	safeParse,
	safeStringify,
	safeReadFile,
	safeWriteFile,
	buildPath,
} from '../utils/common.js';
import { FileUtils, PathUtils } from '../utils/shared-patterns.js';

const logger = getLogger('project-loader');

export interface ProjectLoaderOptions {
	autoBackup?: boolean;
	backupInterval?: number;
	maxBackups?: number;
}

export class ProjectLoader {
	private projectPath: string;
	private scrivxPath: string;
	private projectStructure?: ProjectStructure;
	private lastLoadTime?: number;
	private options: ProjectLoaderOptions;

	constructor(projectPath: string, options: ProjectLoaderOptions = {}) {
		this.projectPath = path.resolve(projectPath);
		const projectName = path.basename(projectPath, path.extname(projectPath));
		this.scrivxPath = PathUtils.build(this.projectPath, `${projectName}.scrivx`);
		this.options = {
			autoBackup: false,
			backupInterval: 3600000, // 1 hour
			maxBackups: 5,
			...options,
		};
	}

	/**
	 * Load the project structure from disk
	 */
	async loadProject(): Promise<ProjectStructure> {
		logger.info(`Loading project from ${this.scrivxPath}`);

		try {
			if (!(await FileUtils.exists(this.scrivxPath))) {
				throw createError(
					ErrorCode.NOT_FOUND,
					`Scrivener project file not found at "${this.scrivxPath}"`
				);
			}
			const scrivxContent = await safeReadFile(this.scrivxPath, 'utf-8');
			this.projectStructure = await parseStringPromise(scrivxContent, {
				explicitArray: false,
				mergeAttrs: true,
			});

			if (!this.projectStructure?.ScrivenerProject) {
				throw createError(
					ErrorCode.INVALID_FORMAT,
					'Invalid Scrivener project structure: Missing ScrivenerProject element'
				);
			}

			// Handle empty Binder element
			if ((this.projectStructure.ScrivenerProject.Binder as unknown) === '') {
				this.projectStructure.ScrivenerProject.Binder = {};
			}

			if (!this.projectStructure.ScrivenerProject.Binder) {
				this.projectStructure.ScrivenerProject.Binder = {};
			}

			// Initialize internal tracking
			this.lastLoadTime = Date.now();
			this.projectStructure._loadTime = this.lastLoadTime;

			logger.info('Project loaded successfully');
			return this.projectStructure;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				throw createError(
					ErrorCode.NOT_FOUND,
					`Scrivener project file not found at "${this.scrivxPath}"`
				);
			} else if ((error as NodeJS.ErrnoException).code === 'EACCES') {
				throw createError(
					ErrorCode.PERMISSION_DENIED,
					`Permission denied reading project file at "${this.scrivxPath}"`
				);
			} else if ((error as Error).message?.includes('XML')) {
				throw createError(
					ErrorCode.INVALID_FORMAT,
					`Invalid XML in project file: ${(error as Error).message}`
				);
			}
			throw error;
		}
	}

	/**
	 * Save the project structure to disk
	 */
	async saveProject(structure?: ProjectStructure): Promise<void> {
		const projectToSave = structure || this.projectStructure;

		if (!projectToSave) {
			throw createError(ErrorCode.INVALID_STATE, 'No project loaded to save');
		}

		logger.info(`Saving project to ${this.scrivxPath}`);

		// Create backup if enabled
		if (this.options.autoBackup) {
			await this.createBackup();
		}

		// Clean structure for saving (remove internal properties)
		const cleanStructure = this.cleanForSaving(projectToSave);

		const builder = new Builder({
			xmldec: { version: '1.0', encoding: 'UTF-8' },
			renderOpts: { pretty: true, indent: '    ' },
		});

		try {
			const xml = builder.buildObject(cleanStructure);
			await safeWriteFile(this.scrivxPath, xml);
			logger.info('Project saved successfully');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EACCES') {
				throw createError(
					ErrorCode.PERMISSION_DENIED,
					`Permission denied writing to ${this.scrivxPath}`
				);
			} else if ((error as NodeJS.ErrnoException).code === 'ENOSPC') {
				throw createError(ErrorCode.IO_ERROR, 'No space left on device');
			}
			throw createError(
				ErrorCode.IO_ERROR,
				`Failed to save project: ${(error as Error).message}`
			);
		}
	}

	/**
	 * Reload the project from disk
	 */
	async reloadProject(): Promise<ProjectStructure> {
		logger.info('Reloading project from disk');
		this.projectStructure = undefined;
		return await this.loadProject();
	}

	/**
	 * Check if the project has been modified externally
	 */
	async isProjectModified(): Promise<boolean> {
		if (!this.lastLoadTime) {
			return false;
		}

		try {
			const stats = await fs.stat(this.scrivxPath);
			return stats.mtime.getTime() > this.lastLoadTime;
		} catch {
			return false;
		}
	}

	/**
	 * Get the current project structure
	 */
	getProjectStructure(): ProjectStructure | undefined {
		return this.projectStructure;
	}

	/**
	 * Update the project structure in memory
	 */
	updateProjectStructure(structure: ProjectStructure): void {
		this.projectStructure = structure;
	}

	/**
	 * Create a backup of the project file
	 */
	async createBackup(): Promise<string> {
		const backupDir = buildPath(this.projectPath, '.backups');
		await ensureDir(backupDir);

		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		const backupName = `backup-${timestamp}.scrivx`;
		const backupPath = buildPath(backupDir, backupName);

		try {
			const content = await safeReadFile(this.scrivxPath, 'utf-8');
			await safeWriteFile(backupPath, content);
			logger.info(`Backup created at ${backupPath}`);

			// Clean up old backups
			await this.cleanupOldBackups(backupDir);

			return backupPath;
		} catch (error) {
			logger.warn(`Failed to create backup: ${(error as Error).message}`);
			throw createError(ErrorCode.IO_ERROR, `Backup failed: ${(error as Error).message}`);
		}
	}

	/**
	 * Restore from a backup
	 */
	async restoreFromBackup(backupPath: string): Promise<void> {
		logger.info(`Restoring from backup: ${backupPath}`);

		try {
			// Create a safety backup of current state
			const _safetyBackup = await this.createBackup();

			// Restore from backup
			const backupContent = await safeReadFile(backupPath, 'utf-8');
			await safeWriteFile(this.scrivxPath, backupContent);

			// Reload the project
			await this.reloadProject();

			logger.info('Project restored successfully');
		} catch (error) {
			throw createError(
				ErrorCode.IO_ERROR,
				`Failed to restore from backup: ${(error as Error).message}`
			);
		}
	}

	/**
	 * List available backups
	 */
	async listBackups(): Promise<Array<{ path: string; date: Date; size: number }>> {
		const backupDir = path.join(this.projectPath, '.backups');

		try {
			const files = await fs.readdir(backupDir);
			const backups = [];

			for (const file of files) {
				if (file.endsWith('.scrivx')) {
					const filePath = path.join(backupDir, file);
					const stats = await fs.stat(filePath);
					backups.push({
						path: filePath,
						date: stats.mtime,
						size: stats.size,
					});
				}
			}

			// Sort by date, newest first
			backups.sort((a, b) => b.date.getTime() - a.date.getTime());
			return backups;
		} catch {
			return [];
		}
	}

	/**
	 * Validate project structure
	 */
	validateProjectStructure(structure: ProjectStructure): boolean {
		if (!structure?.ScrivenerProject) {
			logger.error('Invalid structure: Missing ScrivenerProject');
			return false;
		}

		const project = structure.ScrivenerProject;

		// Check for required elements
		const projectAny = project as Record<string, unknown>;
		if (!project.Binder && !projectAny.Collections && !projectAny.Research) {
			logger.warn('Project has no content (no Binder, Collections, or Research)');
		}

		// Validate Binder structure if present
		if (project.Binder) {
			if (!this.validateBinder(project.Binder)) {
				return false;
			}
		}

		return true;
	}

	// Private helper methods
	private cleanForSaving(structure: ProjectStructure): Record<string, unknown> {
		const clean = safeParse(safeStringify(structure), {}) as Record<string, unknown>;

		// Remove internal tracking properties
		delete clean._loadTime;
		delete clean._modified;

		// Ensure ScrivenerProject is at root
		if (clean.ScrivenerProject) {
			return { ScrivenerProject: clean.ScrivenerProject };
		}

		return clean;
	}

	private async cleanupOldBackups(_backupDir: string): Promise<void> {
		if (!this.options.maxBackups || this.options.maxBackups <= 0) {
			return;
		}

		try {
			const backups = await this.listBackups();

			if (backups.length > this.options.maxBackups) {
				// Delete oldest backups
				const toDelete = backups.slice(this.options.maxBackups);

				for (const backup of toDelete) {
					await fs.unlink(backup.path);
					logger.info(`Deleted old backup: ${backup.path}`);
				}
			}
		} catch (error) {
			logger.warn('Failed to cleanup old backups:', { error });
		}
	}

	private validateBinder(binder: unknown): boolean {
		if (!binder) return true;

		const binderObj = binder as { BinderItem?: unknown };
		// Handle both object and array forms
		const items = Array.isArray(binderObj.BinderItem)
			? binderObj.BinderItem
			: binderObj.BinderItem
				? [binderObj.BinderItem]
				: [];

		for (const item of items) {
			if (!this.validateBinderItem(item)) {
				return false;
			}
		}

		return true;
	}

	private validateBinderItem(item: BinderItem): boolean {
		if (!item) return true;

		// Check required fields
		if (!item.UUID) {
			logger.error('BinderItem missing UUID');
			return false;
		}

		if (!item.Type) {
			logger.error(`BinderItem ${item.UUID} missing Type`);
			return false;
		}

		// Validate children recursively
		if (item.Children?.BinderItem) {
			const children = Array.isArray(item.Children.BinderItem)
				? item.Children.BinderItem
				: [item.Children.BinderItem];

			for (const child of children) {
				if (!this.validateBinderItem(child)) {
					return false;
				}
			}
		}

		return true;
	}

	/**
	 * Export project structure as JSON
	 */
	async exportAsJson(prettyPrint = true): Promise<string> {
		if (!this.projectStructure) {
			throw createError(ErrorCode.INVALID_STATE, 'No project loaded');
		}

		const clean = this.cleanForSaving(this.projectStructure);
		return prettyPrint ? JSON.stringify(clean, null, 2) : safeStringify(clean);
	}

	/**
	 * Import project structure from JSON
	 */
	async importFromJson(jsonString: string): Promise<void> {
		try {
			const structure = safeParse(jsonString, {});

			if (!this.validateProjectStructure(structure)) {
				throw createError(ErrorCode.INVALID_FORMAT, 'Invalid project structure in JSON');
			}

			this.projectStructure = structure;
			await this.saveProject();
		} catch (error) {
			if (error instanceof SyntaxError) {
				throw createError(ErrorCode.INVALID_FORMAT, 'Invalid JSON format');
			}
			throw error;
		}
	}

	/**
	 * Get project metadata
	 */
	getProjectMetadata(): Record<string, unknown> {
		if (!this.projectStructure?.ScrivenerProject) {
			return {};
		}

		const project = this.projectStructure.ScrivenerProject;
		return {
			title: project.ProjectSettings?.ProjectTitle,
			author: project.ProjectSettings?.FullName || project.ProjectSettings?.Author,
			created: (project.ProjectSettings as Record<string, unknown>)?.Created,
			modified: (project.ProjectSettings as Record<string, unknown>)?.Modified,
			version: (project as Record<string, unknown>).Version,
			identifier: (project as Record<string, unknown>).Identifier,
		};
	}
}
