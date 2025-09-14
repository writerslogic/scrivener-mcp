/**
 * Fixed Project Loader with atomic operations and data integrity
 * Prevents corruption, data loss, and handles concurrent access
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Parser, Builder } from 'xml2js';
import { getLogger } from '../core/logger.js';
import { AppError, ErrorCode, safeWriteFile, pathExists } from '../utils/common.js';
import { AsyncUtils } from '../utils/shared-patterns.js';
import type { ProjectStructure, BinderItem } from '../types/internal.js';

const logger = getLogger('project-loader');

export interface ProjectLoaderOptions {
	autoBackup?: boolean;
	maxBackups?: number;
	validateOnLoad?: boolean;
	lockTimeout?: number;
}

export class ProjectLoader {
	private projectPath: string;
	private scrivxPath: string;
	private lastLoadTime: number | null = null;
	private projectStructure: ProjectStructure | null = null;
	private options: Required<ProjectLoaderOptions>;
	private visitedNodes = new Set<string>();

	constructor(projectPath: string, options: ProjectLoaderOptions = {}) {
		this.projectPath = path.resolve(projectPath);
		this.scrivxPath = path.join(this.projectPath, 'project.scrivx');

		this.options = {
			autoBackup: options.autoBackup ?? true,
			maxBackups: options.maxBackups ?? 10,
			validateOnLoad: options.validateOnLoad ?? true,
			lockTimeout: options.lockTimeout ?? 30000, // 30 seconds
		};
	}

	/**
	 * Acquire file lock for safe operations
	 */
	private async acquireLock(): Promise<() => Promise<void>> {
		const lockPath = `${this.scrivxPath}.lock`;
		const lockId = `${process.pid}-${Date.now()}-${Math.random().toString(36)}`;
		const startTime = Date.now();

		while (true) {
			try {
				// Try to create lock file exclusively
				await fs.writeFile(lockPath, lockId, { flag: 'wx' });

				// Verify our lock (in case of race condition)
				const writtenId = await fs.readFile(lockPath, 'utf-8');
				if (writtenId !== lockId) {
					// Someone else got the lock, retry
					continue;
				}

				// Return unlock function
				return async () => {
					try {
						const currentLock = await fs.readFile(lockPath, 'utf-8');
						if (currentLock === lockId) {
							await fs.unlink(lockPath);
						}
					} catch {
						// Lock already removed
					}
				};
			} catch (error: unknown) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

				// Check for stale lock
				try {
					const lockStat = await fs.stat(lockPath);
					const lockAge = Date.now() - lockStat.mtime.getTime();

					// Remove stale lock (older than 60 seconds)
					if (lockAge > 60000) {
						logger.warn('Removing stale lock file');
						await fs.unlink(lockPath);
						continue;
					}
				} catch {
					// Lock doesn't exist, retry
					continue;
				}

				// Check timeout
				if (Date.now() - startTime > this.options.lockTimeout) {
					throw new AppError('Could not acquire project lock', ErrorCode.TIMEOUT_ERROR);
				}

				// Wait before retry with exponential backoff
				const delay = Math.min(100 * Math.pow(2, (Date.now() - startTime) / 1000), 1000);
				await AsyncUtils.sleep(delay);
			}
		}
	}

	/**
	 * Load project with validation and locking
	 */
	async loadProject(): Promise<ProjectStructure> {
		const unlock = await this.acquireLock();

		try {
			logger.info(`Loading Scrivener project from ${this.projectPath}`);

			// Verify project file exists
			if (!(await pathExists(this.scrivxPath))) {
				throw new AppError(
					`Project file not found: ${this.scrivxPath}`,
					ErrorCode.NOT_FOUND
				);
			}

			// Read and parse XML
			const xmlContent = await fs.readFile(this.scrivxPath, 'utf-8');
			const parser = new Parser({
				explicitArray: false,
				mergeAttrs: true,
				ignoreAttrs: false,
				normalize: true,
				normalizeTags: false,
			});

			const structure = await parser.parseStringPromise(xmlContent);

			// Validate structure
			if (this.options.validateOnLoad) {
				this.validateStructure(structure);
			}

			// Auto-backup if enabled
			if (this.options.autoBackup) {
				await this.createBackup();
			}

			this.projectStructure = structure;
			this.lastLoadTime = Date.now();

			logger.info('Project loaded successfully');
			return structure;
		} finally {
			await unlock();
		}
	}

	/**
	 * Save project with atomic write and backup
	 */
	async saveProject(structure?: ProjectStructure): Promise<void> {
		const unlock = await this.acquireLock();

		try {
			const structureToSave = structure || this.projectStructure;
			if (!structureToSave) {
				throw new AppError('No project structure to save', ErrorCode.INVALID_STATE);
			}

			// Sanitize and clean structure
			const cleanStructure = this.sanitizeStructure(structureToSave);

			// Build XML
			const builder = new Builder({
				xmldec: { version: '1.0', encoding: 'UTF-8' },
				renderOpts: { pretty: true, indent: '    ' },
				cdata: true, // Use CDATA for text content
			});

			const xml = builder.buildObject(cleanStructure);

			// Atomic write with backup
			await this.atomicWrite(this.scrivxPath, xml);

			this.lastLoadTime = Date.now();
			logger.info('Project saved successfully');
		} finally {
			await unlock();
		}
	}

	/**
	 * Atomic write with automatic backup and rollback
	 */
	private async atomicWrite(filePath: string, content: string): Promise<void> {
		const tempPath = `${filePath}.tmp.${Date.now()}`;
		const backupPath = `${filePath}.backup`;

		try {
			// Write to temp file
			await safeWriteFile(tempPath, content);

			// Verify temp file was written correctly
			const writtenContent = await fs.readFile(tempPath, 'utf-8');
			if (writtenContent !== content) {
				throw new AppError('File verification failed after write', ErrorCode.IO_ERROR);
			}

			// Backup existing file if it exists
			if (await pathExists(filePath)) {
				await fs.rename(filePath, backupPath);
			}

			// Atomic rename
			await fs.rename(tempPath, filePath);

			// Clean up backup after successful write
			if (await pathExists(backupPath)) {
				await fs.unlink(backupPath);
			}
		} catch (error) {
			// Restore from backup if exists
			if (await pathExists(backupPath)) {
				logger.warn('Write failed, restoring from backup');
				await fs.rename(backupPath, filePath);
			}

			// Clean up temp file
			await fs.unlink(tempPath).catch(() => {});

			throw error;
		}
	}

	/**
	 * Sanitize structure to prevent XML injection
	 */
	private sanitizeStructure(obj: unknown): unknown {
		if (typeof obj === 'string') {
			// Don't escape if it's already in CDATA or if it's a special field
			if (obj.startsWith('<![CDATA[') || obj.startsWith('<?xml')) {
				return obj;
			}

			// Escape XML entities for safety
			return obj
				.replace(/&(?!amp;|lt;|gt;|quot;|apos;)/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;');
		}

		if (Array.isArray(obj)) {
			return obj.map((item) => this.sanitizeStructure(item));
		}

		if (obj && typeof obj === 'object') {
			const sanitized: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(obj)) {
				// Skip internal properties
				if (key.startsWith('_')) continue;
				sanitized[key] = this.sanitizeStructure(value);
			}
			return sanitized;
		}

		return obj;
	}

	/**
	 * Validate project structure with circular reference detection
	 */
	private validateStructure(structure: ProjectStructure): void {
		if (!structure?.ScrivenerProject) {
			throw new AppError(
				'Invalid project structure: missing ScrivenerProject',
				ErrorCode.VALIDATION_ERROR
			);
		}

		const project = structure.ScrivenerProject;

		// Validate binder
		if (!project.Binder) {
			throw new AppError(
				'Invalid project structure: missing Binder',
				ErrorCode.VALIDATION_ERROR
			);
		}

		// Reset visited nodes for validation
		this.visitedNodes.clear();

		// Validate binder items recursively
		const binder = project.Binder;
		if (binder.BinderItem) {
			const items = Array.isArray(binder.BinderItem)
				? binder.BinderItem
				: [binder.BinderItem];

			for (const item of items) {
				if (!this.validateBinderItem(item)) {
					throw new AppError(
						'Invalid binder structure detected',
						ErrorCode.VALIDATION_ERROR
					);
				}
			}
		}
	}

	/**
	 * Validate binder item with circular reference protection
	 */
	private validateBinderItem(item: BinderItem): boolean {
		if (!item?.UUID) {
			logger.warn('Binder item missing UUID');
			return false;
		}

		// Check for circular reference
		if (this.visitedNodes.has(item.UUID)) {
			logger.error(`Circular reference detected: ${item.UUID}`);
			return false;
		}

		this.visitedNodes.add(item.UUID);

		// Validate type
		if (!item.Type || !['Text', 'Folder', 'Research', 'Trash'].includes(item.Type)) {
			logger.warn(`Invalid binder item type: ${item.Type}`);
			return false;
		}

		// Validate children recursively with depth limit
		if (item.Children?.BinderItem) {
			if (this.visitedNodes.size > 10000) {
				logger.error('Binder structure too deep or has loops');
				return false;
			}

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
	 * Create timestamped backup
	 */
	async createBackup(): Promise<string> {
		const backupDir = path.join(this.projectPath, '.scrivener-mcp', 'backups');
		await fs.mkdir(backupDir, { recursive: true });

		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		const backupName = `backup-${timestamp}.scrivx`;
		const backupPath = path.join(backupDir, backupName);

		// Copy project file to backup
		await fs.copyFile(this.scrivxPath, backupPath);

		// Clean up old backups
		await this.cleanupOldBackups(backupDir);

		logger.debug(`Created backup: ${backupName}`);
		return backupPath;
	}

	/**
	 * Clean up old backups safely
	 */
	private async cleanupOldBackups(backupDir: string): Promise<void> {
		const files = await fs.readdir(backupDir);

		// Filter and validate backup files
		const backups: Array<{ path: string; mtime: Date }> = [];
		const backupPattern = /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/;

		for (const file of files) {
			if (file.endsWith('.scrivx') && backupPattern.test(file)) {
				const filePath = path.join(backupDir, file);
				try {
					const stats = await fs.stat(filePath);
					backups.push({ path: filePath, mtime: stats.mtime });
				} catch {
					// Skip files we can't stat
				}
			}
		}

		// Sort by date (newest first)
		backups.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

		// Keep only maxBackups
		if (backups.length > this.options.maxBackups) {
			const toDelete = backups.slice(this.options.maxBackups);

			for (const backup of toDelete) {
				try {
					// Move to trash first (safer than immediate deletion)
					const trashPath = `${backup.path}.trash`;
					await fs.rename(backup.path, trashPath);

					// Schedule deletion after delay
					setTimeout(
						async () => {
							try {
								await fs.unlink(trashPath);
							} catch {
								// Ignore deletion errors
							}
						},
						24 * 60 * 60 * 1000
					); // Delete after 24 hours
				} catch (error) {
					logger.warn(`Failed to remove old backup: ${backup.path}`, { error });
				}
			}
		}
	}

	/**
	 * List backups with iterator for memory efficiency
	 */
	async *listBackupsIterator(limit = 100): AsyncGenerator<{
		path: string;
		date: Date;
		size: number;
	}> {
		const backupDir = path.join(this.projectPath, '.scrivener-mcp', 'backups');

		try {
			const files = await fs.readdir(backupDir);
			const backupPattern = /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/;

			let count = 0;
			for (const file of files) {
				if (file.endsWith('.scrivx') && backupPattern.test(file)) {
					const filePath = path.join(backupDir, file);

					try {
						const stats = await fs.stat(filePath);
						yield {
							path: filePath,
							date: stats.mtime,
							size: stats.size,
						};

						if (++count >= limit) break;
					} catch {
						// Skip files we can't stat
					}
				}
			}
		} catch (error) {
			logger.warn('Failed to list backups', { error });
		}
	}

	/**
	 * Check if project has been modified
	 */
	async isProjectModified(): Promise<boolean> {
		if (!this.lastLoadTime) return false;

		try {
			const stats = await fs.stat(this.scrivxPath);
			return stats.mtime.getTime() > this.lastLoadTime;
		} catch {
			return false;
		}
	}

	/**
	 * Get project metadata
	 */
	getProjectMetadata(): Record<string, unknown> | null {
		if (!this.projectStructure?.ScrivenerProject) return null;

		const project = this.projectStructure.ScrivenerProject as Record<string, unknown>;
		const projectSettings = project.ProjectSettings as Record<string, unknown> | undefined;
		
		return {
			title: projectSettings?.ProjectTitle || project.Title,
			author: projectSettings?.FullName || projectSettings?.Author || project.Author,
			created: projectSettings?.Created || project.Created,
			modified: projectSettings?.Modified || project.Modified,
			version: project.Version,
			identifier: project.Identifier,
		};
	}
}
