/**
 * Document metadata management service
 */

import { ApplicationError as AppError, ErrorCode } from '../core/errors.js';
import { getLogger } from '../core/logger.js';
import type { BinderItem, MetaDataItem, ProjectStructure } from '../types/internal.js';
import { parseMetadata } from '../utils/scrivener-utils.js';
import { AsyncUtils, MemoryCache, StringUtils, ValidationUtils } from '../utils/shared-patterns.js';

const logger = getLogger('metadata-manager');

export interface DocumentMetadata {
	title?: string;
	synopsis?: string;
	notes?: string;
	label?: string;
	status?: string;
	keywords?: string[];
	includeInCompile?: boolean;
	customMetadata?: Record<string, string>;
	created?: string;
	modified?: string;
}

export interface ProjectMetadata {
	title?: string;
	author?: string;
	keywords?: string[];
	projectTargets?: {
		draft?: number;
		session?: number;
		deadline?: string;
	};
	customFields?: Record<string, string>;
}

export class MetadataManager {
	private projectTitle: string = 'Untitled Project';
	private validationCache: MemoryCache<{ valid: boolean; missing: string[] }>;
	private metadataCache: MemoryCache<DocumentMetadata>;
	private readonly maxStringLength = 10000; // Safety limit for metadata fields

	constructor() {
		this.validationCache = new MemoryCache<{ valid: boolean; missing: string[] }>(
			5 * 60 * 1000
		); // 5 minutes
		this.metadataCache = new MemoryCache<DocumentMetadata>(10 * 60 * 1000); // 10 minutes
	}

	/**
	 * Get the project title
	 */
	getProjectTitle(): string {
		return this.projectTitle;
	}

	/**
	 * Set the project title
	 */
	setProjectTitle(title: string): void {
		this.projectTitle = title;
	}

	/**
	 * Update metadata for a binder item with validation
	 */
	updateDocumentMetadata(item: BinderItem, metadata: DocumentMetadata): void {
		if (!item) {
			throw new AppError('No item provided', ErrorCode.INVALID_INPUT);
		}

		if (!item.UUID && !item.ID) {
			throw new AppError('Item must have UUID or ID', ErrorCode.INVALID_INPUT);
		}

		// Validate UUID format if present
		if (item.UUID && !ValidationUtils.isValidUUID(item.UUID, { allowNumeric: true })) {
			throw new AppError(`Invalid UUID format: ${item.UUID}`, ErrorCode.INVALID_INPUT);
		}

		// Validate metadata before processing
		this.validateMetadataInput(metadata);

		// Initialize metadata if not present
		if (!item.MetaData) {
			item.MetaData = {};
		}

		const metaData = item.MetaData;

		// Update title (stored on item, not in metadata)
		if (metadata.title !== undefined) {
			item.Title = metadata.title;
		}

		// Update synopsis
		if (metadata.synopsis !== undefined) {
			metaData.Synopsis = metadata.synopsis;
		}

		// Update notes
		if (metadata.notes !== undefined) {
			metaData.Notes = metadata.notes;
		}

		// Update label
		if (metadata.label !== undefined) {
			metaData.Label = metadata.label;
		}

		// Update status
		if (metadata.status !== undefined) {
			metaData.Status = metadata.status;
		}

		// Update keywords
		if (metadata.keywords) {
			metaData.Keywords = metadata.keywords.join(';');
		}

		// Update include in compile
		if (metadata.includeInCompile !== undefined) {
			metaData.IncludeInCompile = metadata.includeInCompile ? 'Yes' : 'No';
		}

		// Update custom metadata
		if (metadata.customMetadata) {
			this.updateCustomMetadata(metaData, metadata.customMetadata);
		}

		// Update modified date
		metaData.Modified = new Date().toISOString();

		logger.debug(`Updated metadata for item ${item.UUID}`);
	}

	/**
	 * Get metadata from a binder item
	 */
	getDocumentMetadata(item: BinderItem): DocumentMetadata {
		const metadata: DocumentMetadata = {
			title: item.Title || 'Untitled',
		};

		if (item.MetaData) {
			const metaData = item.MetaData;

			if (metaData.Synopsis) {
				metadata.synopsis = metaData.Synopsis;
			}

			if (metaData.Notes) {
				metadata.notes = metaData.Notes;
			}

			if (metaData.Label) {
				metadata.label = metaData.Label;
			}

			if (metaData.Status) {
				metadata.status = metaData.Status;
			}

			if (metaData.Keywords) {
				metadata.keywords =
					typeof metaData.Keywords === 'string'
						? metaData.Keywords.split(';')
								.map((k) => k.trim())
								.filter((k) => k)
						: [];
			}

			metadata.includeInCompile = metaData.IncludeInCompile === 'Yes';

			if (metaData.Created) {
				metadata.created = metaData.Created;
			}

			if (metaData.Modified) {
				metadata.modified = metaData.Modified;
			}

			// Extract custom metadata
			if (metaData.CustomMetaData?.MetaDataItem) {
				metadata.customMetadata = this.extractCustomMetadata(
					metaData.CustomMetaData.MetaDataItem
				);
			}
		}

		return metadata;
	}

	/**
	 * Batch update metadata for multiple documents with retry logic
	 */
	async batchUpdateMetadata(
		items: Map<string, BinderItem>,
		updates: Array<{ id: string; metadata: DocumentMetadata }>
	): Promise<Array<{ id: string; success: boolean; error?: string }>> {
		const results: Array<{ id: string; success: boolean; error?: string }> = [];

		for (const update of updates) {
			const item = items.get(update.id);

			if (!item) {
				results.push({
					id: update.id,
					success: false,
					error: `Document ${update.id} not found`,
				});
				continue;
			}

			try {
				// Use retry logic for individual metadata updates to handle transient issues
				await AsyncUtils.retryWithBackoff(
					() => {
						this.updateDocumentMetadata(item, update.metadata);
						return Promise.resolve();
					},
					{
						maxAttempts: 3,
						initialDelay: 100,
						maxDelay: 1000,
						jitter: true,
					}
				);
				results.push({
					id: update.id,
					success: true,
				});
			} catch (error) {
				results.push({
					id: update.id,
					success: false,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		return results;
	}

	/**
	 * Update project-level metadata with validation
	 */
	updateProjectMetadata(projectStructure: ProjectStructure, metadata: ProjectMetadata): void {
		if (!projectStructure?.ScrivenerProject) {
			throw new AppError('Invalid project structure', ErrorCode.INVALID_STATE);
		}

		// Validate project metadata before processing
		this.validateProjectMetadataInput(metadata);

		const project = projectStructure.ScrivenerProject;

		// Initialize ProjectSettings if not present
		if (!project.ProjectSettings) {
			project.ProjectSettings = {};
		}

		const settings = project.ProjectSettings;

		// Update project title
		if (metadata.title !== undefined) {
			settings.ProjectTitle = metadata.title;
		}

		// Update author
		if (metadata.author !== undefined) {
			settings.FullName = metadata.author;
			settings.Author = metadata.author;
		}

		// Update project targets
		if (metadata.projectTargets) {
			if (!project.ProjectTargets) {
				project.ProjectTargets = {};
			}

			const targets = project.ProjectTargets;

			if (metadata.projectTargets.draft !== undefined) {
				targets.DraftTarget = String(metadata.projectTargets.draft);
			}

			if (metadata.projectTargets.session !== undefined) {
				targets.SessionTarget = String(metadata.projectTargets.session);
			}

			if (metadata.projectTargets.deadline !== undefined) {
				targets.Deadline = metadata.projectTargets.deadline;
			}
		}

		// Update custom fields
		if (metadata.customFields) {
			const settingsAny = settings as Record<string, unknown>;
			if (!settingsAny.CustomFields) {
				settingsAny.CustomFields = {};
			}

			Object.assign(
				settingsAny.CustomFields as Record<string, unknown>,
				metadata.customFields
			);
		}

		logger.info('Updated project metadata');
	}

	/**
	 * Get project-level metadata
	 */
	getProjectMetadata(projectStructure: ProjectStructure): ProjectMetadata {
		if (!projectStructure?.ScrivenerProject) {
			return {};
		}

		const project = projectStructure.ScrivenerProject;
		const metadata: ProjectMetadata = {};

		if (project.ProjectSettings) {
			const settings = project.ProjectSettings;
			metadata.title = settings.ProjectTitle;
			metadata.author = settings.FullName || settings.Author;

			const settingsAny = settings as Record<string, unknown>;
			if (settingsAny.CustomFields) {
				metadata.customFields = { ...(settingsAny.CustomFields as Record<string, string>) };
			}
		}

		if (project.ProjectTargets) {
			const targets = project.ProjectTargets;
			metadata.projectTargets = {
				draft: targets.DraftTarget ? parseInt(targets.DraftTarget) : undefined,
				session: targets.SessionTarget ? parseInt(targets.SessionTarget) : undefined,
				deadline: targets.Deadline,
			};
		}

		return metadata;
	}

	/**
	 * Search metadata across all documents
	 */
	searchMetadata(
		items: BinderItem[],
		query: string,
		fields: Array<'title' | 'synopsis' | 'notes' | 'keywords' | 'custom'> = [
			'title',
			'synopsis',
		]
	): Array<{ id: string; field: string; value: string }> {
		const results: Array<{ id: string; field: string; value: string }> = [];
		const lowerQuery = query.toLowerCase();

		const searchItem = (item: BinderItem) => {
			// Search title
			if (fields.includes('title') && item.Title?.toLowerCase().includes(lowerQuery)) {
				results.push({
					id: item.UUID || '',
					field: 'title',
					value: item.Title,
				});
			}

			if (item.MetaData) {
				// Search synopsis
				if (
					fields.includes('synopsis') &&
					item.MetaData.Synopsis?.toLowerCase().includes(lowerQuery)
				) {
					results.push({
						id: item.UUID || '',
						field: 'synopsis',
						value: item.MetaData.Synopsis,
					});
				}

				// Search notes
				if (
					fields.includes('notes') &&
					item.MetaData.Notes?.toLowerCase().includes(lowerQuery)
				) {
					results.push({
						id: item.UUID || '',
						field: 'notes',
						value: item.MetaData.Notes,
					});
				}

				// Search keywords
				if (fields.includes('keywords') && item.MetaData.Keywords) {
					const keywords =
						typeof item.MetaData.Keywords === 'string'
							? item.MetaData.Keywords.split(';')
							: [];

					for (const keyword of keywords) {
						if (keyword.toLowerCase().includes(lowerQuery)) {
							results.push({
								id: item.UUID || '',
								field: 'keyword',
								value: keyword.trim(),
							});
						}
					}
				}

				// Search custom metadata
				if (fields.includes('custom') && item.MetaData.CustomMetaData?.MetaDataItem) {
					const customData = this.extractCustomMetadata(
						item.MetaData.CustomMetaData.MetaDataItem
					);

					for (const [key, value] of Object.entries(customData)) {
						if (value.toLowerCase().includes(lowerQuery)) {
							results.push({
								id: item.UUID || '',
								field: `custom:${key}`,
								value,
							});
						}
					}
				}
			}

			// Search children recursively
			if (item.Children?.BinderItem) {
				const children = Array.isArray(item.Children.BinderItem)
					? item.Children.BinderItem
					: [item.Children.BinderItem];

				for (const child of children) {
					searchItem(child);
				}
			}
		};

		for (const item of items) {
			searchItem(item);
		}

		return results;
	}

	/**
	 * Get statistics about metadata usage
	 */
	getMetadataStatistics(items: BinderItem[]): Record<string, unknown> {
		const stats = {
			totalDocuments: 0,
			withSynopsis: 0,
			withNotes: 0,
			withKeywords: 0,
			withLabel: 0,
			withStatus: 0,
			withCustomMetadata: 0,
			labels: new Set<string>(),
			statuses: new Set<string>(),
			keywords: new Set<string>(),
			customFields: new Set<string>(),
		};

		const processItem = (item: BinderItem) => {
			stats.totalDocuments++;

			if (item.MetaData) {
				if (item.MetaData.Synopsis) stats.withSynopsis++;
				if (item.MetaData.Notes) stats.withNotes++;
				if (item.MetaData.Keywords) {
					stats.withKeywords++;
					const keywords =
						typeof item.MetaData.Keywords === 'string'
							? item.MetaData.Keywords.split(';')
							: [];
					keywords.forEach((k) => stats.keywords.add(k.trim()));
				}
				if (item.MetaData.Label) {
					stats.withLabel++;
					stats.labels.add(item.MetaData.Label);
				}
				if (item.MetaData.Status) {
					stats.withStatus++;
					stats.statuses.add(item.MetaData.Status);
				}
				if (item.MetaData.CustomMetaData?.MetaDataItem) {
					stats.withCustomMetadata++;
					const custom = this.extractCustomMetadata(
						item.MetaData.CustomMetaData.MetaDataItem
					);
					Object.keys(custom).forEach((k) => stats.customFields.add(k));
				}
			}

			// Process children
			if (item.Children?.BinderItem) {
				const children = Array.isArray(item.Children.BinderItem)
					? item.Children.BinderItem
					: [item.Children.BinderItem];
				children.forEach(processItem);
			}
		};

		items.forEach(processItem);

		return {
			totalDocuments: stats.totalDocuments,
			withSynopsis: stats.withSynopsis,
			withNotes: stats.withNotes,
			withKeywords: stats.withKeywords,
			withLabel: stats.withLabel,
			withStatus: stats.withStatus,
			withCustomMetadata: stats.withCustomMetadata,
			uniqueLabels: Array.from(stats.labels),
			uniqueStatuses: Array.from(stats.statuses),
			uniqueKeywords: Array.from(stats.keywords),
			customFieldNames: Array.from(stats.customFields),
			completeness: {
				synopsis: `${((stats.withSynopsis / stats.totalDocuments) * 100).toFixed(1)}%`,
				notes: `${((stats.withNotes / stats.totalDocuments) * 100).toFixed(1)}%`,
				keywords: `${((stats.withKeywords / stats.totalDocuments) * 100).toFixed(1)}%`,
			},
		};
	}

	// Private helper methods
	private updateCustomMetadata(
		metaData: BinderItem['MetaData'],
		customFields: Record<string, string>
	): void {
		if (!metaData) {
			return;
		}

		if (!metaData.CustomMetaData) {
			metaData.CustomMetaData = { MetaDataItem: [] };
		}

		const customMetaItems = Array.isArray(metaData.CustomMetaData.MetaDataItem)
			? metaData.CustomMetaData.MetaDataItem
			: metaData.CustomMetaData.MetaDataItem
				? [metaData.CustomMetaData.MetaDataItem]
				: [];

		for (const [key, value] of Object.entries(customFields)) {
			const existing = customMetaItems.find((item: MetaDataItem) => item?.ID === key);

			if (existing) {
				existing.Value = value;
			} else {
				customMetaItems.push({
					ID: key,
					Value: value,
				});
			}
		}

		metaData.CustomMetaData.MetaDataItem = customMetaItems;
	}

	private extractCustomMetadata(
		metaDataItems: MetaDataItem | MetaDataItem[]
	): Record<string, string> {
		return parseMetadata(metaDataItems);
	}

	/**
	 * Validate metadata completeness with caching
	 */
	validateMetadata(
		item: BinderItem,
		requiredFields: string[] = []
	): { valid: boolean; missing: string[] } {
		// Check cache first
		const cacheKey = `${item.UUID || item.ID}-${requiredFields.join(',')}`;
		const cached = this.validationCache.get(cacheKey);
		if (cached) {
			return cached;
		}

		const missing: string[] = [];
		const metadata = this.getDocumentMetadata(item);

		// Validate UUID if present
		if (item.UUID && !ValidationUtils.isValidUUID(item.UUID, { allowNumeric: true })) {
			missing.push('valid-uuid');
		}

		for (const field of requiredFields) {
			switch (field) {
				case 'title':
					if (!metadata.title || metadata.title === 'Untitled') {
						missing.push('title');
					}
					break;
				case 'synopsis':
					if (!metadata.synopsis) {
						missing.push('synopsis');
					}
					break;
				case 'notes':
					if (!metadata.notes) {
						missing.push('notes');
					}
					break;
				case 'keywords':
					if (!metadata.keywords || metadata.keywords.length === 0) {
						missing.push('keywords');
					}
					break;
				case 'label':
					if (!metadata.label) {
						missing.push('label');
					}
					break;
				case 'status':
					if (!metadata.status) {
						missing.push('status');
					}
					break;
			}
		}

		const result = {
			valid: missing.length === 0,
			missing,
		};

		// Cache the validation result
		this.validationCache.set(cacheKey, result);

		return result;
	}

	/**
	 * Validate metadata input
	 */
	private validateMetadataInput(metadata: DocumentMetadata): void {
		if (metadata.title && metadata.title.length > this.maxStringLength) {
			throw new AppError(
				`Title too long (max ${this.maxStringLength} characters)`,
				ErrorCode.INVALID_INPUT
			);
		}

		if (metadata.synopsis && metadata.synopsis.length > this.maxStringLength) {
			throw new AppError(
				`Synopsis too long (max ${this.maxStringLength} characters)`,
				ErrorCode.INVALID_INPUT
			);
		}

		if (metadata.notes && metadata.notes.length > this.maxStringLength) {
			throw new AppError(
				`Notes too long (max ${this.maxStringLength} characters)`,
				ErrorCode.INVALID_INPUT
			);
		}

		if (metadata.keywords && metadata.keywords.length > 100) {
			throw new AppError('Too many keywords (max 100)', ErrorCode.INVALID_INPUT);
		}

		if (metadata.customMetadata) {
			const customCount = Object.keys(metadata.customMetadata).length;
			if (customCount > 50) {
				throw new AppError(
					'Too many custom metadata fields (max 50)',
					ErrorCode.INVALID_INPUT
				);
			}

			for (const [key, value] of Object.entries(metadata.customMetadata)) {
				if (key.length > 100) {
					throw new AppError(
						`Custom field key too long: ${StringUtils.truncate(key, 50)}`,
						ErrorCode.INVALID_INPUT
					);
				}
				if (value && value.length > this.maxStringLength) {
					throw new AppError(
						`Custom field value too long for key: ${key}`,
						ErrorCode.INVALID_INPUT
					);
				}
				// Validate URLs in custom metadata if the field name suggests it's a URL
				if (key.toLowerCase().includes('url') || key.toLowerCase().includes('link')) {
					if (value && !ValidationUtils.validateUrl(value)) {
						throw new AppError(
							`Invalid URL in custom field '${key}': ${value}`,
							ErrorCode.INVALID_INPUT
						);
					}
				}
			}
		}
	}

	/**
	 * Validate project metadata input
	 */
	private validateProjectMetadataInput(metadata: ProjectMetadata): void {
		if (metadata.title && metadata.title.length > this.maxStringLength) {
			throw new AppError(
				`Project title too long (max ${this.maxStringLength} characters)`,
				ErrorCode.INVALID_INPUT
			);
		}

		if (metadata.author && metadata.author.length > 500) {
			throw new AppError(
				'Author name too long (max 500 characters)',
				ErrorCode.INVALID_INPUT
			);
		}

		if (metadata.projectTargets) {
			const { draft, session } = metadata.projectTargets;
			if (draft !== undefined && (draft < 0 || draft > 10000000)) {
				throw new AppError(
					'Draft target must be between 0 and 10,000,000',
					ErrorCode.INVALID_INPUT
				);
			}
			if (session !== undefined && (session < 0 || session > 100000)) {
				throw new AppError(
					'Session target must be between 0 and 100,000',
					ErrorCode.INVALID_INPUT
				);
			}
		}
	}

	/**
	 * Batch process metadata with enhanced error handling and timeout protection
	 */
	async batchProcessMetadata<T>(
		items: BinderItem[],
		processor: (item: BinderItem) => Promise<T> | T,
		options: {
			concurrency?: number;
			continueOnError?: boolean;
			timeoutMs?: number;
			retryOptions?: {
				maxAttempts?: number;
				initialDelay?: number;
				maxDelay?: number;
			};
		} = {}
	): Promise<Array<{ item: BinderItem; result?: T; error?: string }>> {
		const {
			concurrency = 5,
			continueOnError = true,
			timeoutMs = 30000, // 30 seconds timeout per item
			retryOptions = { maxAttempts: 2, initialDelay: 500, maxDelay: 2000 },
		} = options;
		const results: Array<{ item: BinderItem; result?: T; error?: string }> = [];

		// Process in batches for memory efficiency
		for (let i = 0; i < items.length; i += concurrency) {
			const batch = items.slice(i, i + concurrency);
			const batchPromises = batch.map(async (item) => {
				try {
					// Wrap processor with timeout and retry logic
					const result = await AsyncUtils.withTimeout(
						AsyncUtils.retryWithBackoff(async () => {
							return await processor(item);
						}, retryOptions),
						timeoutMs,
						`Processing item ${item.UUID || item.ID} timed out after ${timeoutMs}ms`
					);
					return { item, result };
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error);
					logger.warn(`Failed to process item ${item.UUID || item.ID}`, {
						error: errorMessage,
					});
					if (!continueOnError) {
						throw error;
					}
					return { item, error: errorMessage };
				}
			});

			const batchResults = await Promise.all(batchPromises);
			results.push(...batchResults);

			// Add a small delay between batches to prevent overwhelming the system
			if (i + concurrency < items.length) {
				await AsyncUtils.sleep(50); // 50ms delay between batches
			}
		}

		return results;
	}

	/**
	 * Validate multiple items with async processing and caching
	 */
	async validateMultipleItems(
		items: BinderItem[],
		requiredFields: string[] = [],
		options: { concurrency?: number; useCache?: boolean } = {}
	): Promise<Array<{ item: BinderItem; validation: { valid: boolean; missing: string[] } }>> {
		const { concurrency = 10 } = options;

		return await this.batchProcessMetadata(
			items,
			(item) => {
				const validation = this.validateMetadata(item, requiredFields);
				return validation;
			},
			{
				concurrency,
				continueOnError: true,
				timeoutMs: 5000, // 5 seconds per validation
				retryOptions: { maxAttempts: 1 }, // No retries for validation
			}
		).then((results) =>
			results.map((result) => ({
				item: result.item,
				validation: result.result || { valid: false, missing: ['validation-failed'] },
			}))
		);
	}

	/**
	 * Batch validate and repair metadata with timeout protection
	 */
	async batchValidateAndRepair(
		items: BinderItem[],
		repairOptions: {
			addMissingTitles?: boolean;
			generateSynopsis?: boolean;
			setDefaultStatus?: boolean;
			defaultStatus?: string;
		} = {},
		processingOptions: { concurrency?: number; timeoutMs?: number } = {}
	): Promise<Array<{ item: BinderItem; repaired: boolean; changes: string[] }>> {
		const { concurrency = 5, timeoutMs = 10000 } = processingOptions;
		const {
			addMissingTitles = true,
			setDefaultStatus = true,
			defaultStatus = 'Draft',
		} = repairOptions;

		return await this.batchProcessMetadata(
			items,
			async (item) => {
				const changes: string[] = [];
				let repaired = false;

				// Validate the item first
				const validation = this.validateMetadata(item, ['title', 'status']);

				if (!validation.valid) {
					// Repair missing title
					if (validation.missing.includes('title') && addMissingTitles) {
						const metadata = this.getDocumentMetadata(item);
						if (!metadata.title || metadata.title === 'Untitled') {
							this.updateDocumentMetadata(item, {
								title: `Document ${item.UUID || item.ID}`,
							});
							changes.push('title');
							repaired = true;
						}
					}

					// Set default status
					if (validation.missing.includes('status') && setDefaultStatus) {
						this.updateDocumentMetadata(item, { status: defaultStatus });
						changes.push('status');
						repaired = true;
					}
				}

				return { repaired, changes };
			},
			{
				concurrency,
				continueOnError: true,
				timeoutMs,
				retryOptions: { maxAttempts: 2, initialDelay: 200 },
			}
		).then((results) =>
			results.map((result) => ({
				item: result.item,
				repaired: result.result?.repaired || false,
				changes: result.result?.changes || [],
			}))
		);
	}

	/**
	 * Search metadata with async processing and result caching
	 */
	async searchMetadataAsync(
		items: BinderItem[],
		query: string,
		fields: Array<'title' | 'synopsis' | 'notes' | 'keywords' | 'custom'> = [
			'title',
			'synopsis',
		],
		options: { cacheResults?: boolean; timeout?: number } = {}
	): Promise<Array<{ id: string; field: string; value: string }>> {
		const { cacheResults = true, timeout = 15000 } = options;
		const cacheKey = `search-${query}-${fields.join(',')}-${items.length}`;

		// Check cache first
		if (cacheResults) {
			const cached = this.metadataCache.get(cacheKey);
			if (cached) {
				return cached as Array<{ id: string; field: string; value: string }>;
			}
		}

		try {
			const results = await AsyncUtils.withTimeout(
				Promise.resolve(this.searchMetadata(items, query, fields)),
				timeout,
				`Metadata search timed out after ${timeout}ms`
			);

			// Cache results if enabled
			if (cacheResults) {
				this.metadataCache.set(cacheKey, results as any, 5 * 60 * 1000); // 5 minutes
			}

			return results;
		} catch (error) {
			logger.error('Metadata search failed', {
				error: (error as Error).message,
				query,
				fields,
			});
			throw error;
		}
	}

	/**
	 * Clear all caches
	 */
	clearCaches(): void {
		this.metadataCache.clear();
		this.validationCache.clear();
		logger.debug('Metadata caches cleared');
	}

	/**
	 * Cleanup expired cache entries periodically
	 */
	scheduleCleanup(): void {
		setInterval(
			() => {
				this.metadataCache.cleanup();
				this.validationCache.cleanup();
				logger.debug('Performed scheduled cache cleanup');
			},
			10 * 60 * 1000
		); // Every 10 minutes
	}
}
