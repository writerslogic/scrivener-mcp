/**
 * Document metadata management service
 */

import { createError, ErrorCode } from '../core/errors.js';
import { getLogger } from '../core/logger.js';
import type { BinderItem, MetaDataItem, ProjectStructure } from '../types/internal.js';

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
	constructor() {}

	/**
	 * Update metadata for a binder item
	 */
	updateDocumentMetadata(item: BinderItem, metadata: DocumentMetadata): void {
		if (!item) {
			throw createError(ErrorCode.INVALID_INPUT, 'No item provided');
		}

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
	 * Batch update metadata for multiple documents
	 */
	batchUpdateMetadata(
		items: Map<string, BinderItem>,
		updates: Array<{ id: string; metadata: DocumentMetadata }>
	): Array<{ id: string; success: boolean; error?: string }> {
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
				this.updateDocumentMetadata(item, update.metadata);
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
	 * Update project-level metadata
	 */
	updateProjectMetadata(projectStructure: ProjectStructure, metadata: ProjectMetadata): void {
		if (!projectStructure?.ScrivenerProject) {
			throw createError(ErrorCode.INVALID_STATE, 'Invalid project structure');
		}

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
		const customMetadata: Record<string, string> = {};
		const items = Array.isArray(metaDataItems) ? metaDataItems : [metaDataItems];

		for (const item of items) {
			const itemId = item.ID || item.id;
			const itemValue = item.Value || item._ || item;

			if (itemId && itemValue && typeof itemValue === 'string') {
				customMetadata[itemId] = itemValue;
			}
		}

		return customMetadata;
	}

	/**
	 * Validate metadata completeness
	 */
	validateMetadata(
		item: BinderItem,
		requiredFields: string[] = []
	): { valid: boolean; missing: string[] } {
		const missing: string[] = [];
		const metadata = this.getDocumentMetadata(item);

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

		return {
			valid: missing.length === 0,
			missing,
		};
	}
}
