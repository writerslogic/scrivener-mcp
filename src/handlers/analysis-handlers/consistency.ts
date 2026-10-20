import type { CharacterProfile, MemoryManager, PlotThread } from '../../memory-manager.js';
import type { ScrivenerDocument } from '../../types/index.js';
import { compact, formatError } from '../../core/response-formatter.js';
import type { HandlerResult, ToolDefinition } from '../types.js';
import { getOptionalArrayArg, requireMemoryManager, requireProject } from '../types.js';

export const checkConsistencyHandler: ToolDefinition = {
	name: 'check_consistency',
	title: 'Check Project Consistency',
	description:
		'Scan the whole project for continuity problems and return the issues found: character ' +
		'contradictions, timeline conflicts, location mismatches, and dropped or inconsistent plot ' +
		'threads. This is the project-wide continuity checker; use analyze_document to critique a ' +
		"single document's prose instead. Narrow the scan with checkTypes. Requires an open project.",
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			checkTypes: {
				type: 'array',
				items: {
					type: 'string',
					enum: ['characters', 'timeline', 'locations', 'plotThreads', 'all'],
				},
				description:
					'Continuity dimensions to check. Omit or use ["all"] for every check; otherwise ' +
					'pick any of characters, timeline, locations, plotThreads.',
			},
		},
	},
	outputSchema: {
		type: 'object',
		properties: {
			issues: {
				type: 'array',
				description: 'Continuity issues found, sorted by severity.',
				items: {
					type: 'object',
					properties: {
						type: {
							type: 'string',
							description:
								'Issue category (character, timeline, worldbuilding, plot, or location).',
						},
						severity: {
							type: 'string',
							description: 'Severity: error, warning, or info.',
						},
						documentId: {
							type: 'string',
							description:
								'Id of the document the issue relates to, when applicable.',
						},
						description: { type: 'string', description: 'What the issue is.' },
						suggestion: {
							type: 'string',
							description: 'Recommended action to resolve the issue, when available.',
						},
					},
					required: ['type', 'severity', 'description'],
				},
			},
			counts: {
				type: 'object',
				description: 'Issue tallies by severity.',
				properties: {
					total: { type: 'number', description: 'Total issues found.' },
					errors: { type: 'number', description: 'Number of error-severity issues.' },
					warnings: { type: 'number', description: 'Number of warning-severity issues.' },
					info: { type: 'number', description: 'Number of info-severity issues.' },
				},
				required: ['total', 'errors', 'warnings', 'info'],
			},
			checkTypes: {
				type: 'array',
				description: 'The continuity dimensions that were checked.',
				items: { type: 'string' },
			},
		},
		required: ['issues', 'counts', 'checkTypes'],
	},
	handler: async (args, _context): Promise<HandlerResult> => {
		const project = requireProject(_context);
		const memoryManager = requireMemoryManager(_context);

		const checkTypes = getOptionalArrayArg<string>(args, 'checkTypes') || ['all'];
		const issues: ConsistencyIssue[] = [];

		try {
			// Get all documents for analysis
			const documents = await project.getAllDocuments();
			const characters = await memoryManager.getAllCharacters();
			const plotThreads = await memoryManager.getPlotThreads();

			// Character consistency checks
			if (checkTypes.includes('all') || checkTypes.includes('characters')) {
				const characterIssues = await checkCharacterConsistency(documents, characters);
				issues.push(...characterIssues);
			}

			// Timeline consistency checks
			if (checkTypes.includes('all') || checkTypes.includes('timeline')) {
				const timelineIssues = await checkTimelineConsistency(documents);
				issues.push(...timelineIssues);
			}

			// Location consistency checks
			if (checkTypes.includes('all') || checkTypes.includes('locations')) {
				const locationIssues = await checkLocationConsistency(documents, memoryManager);
				issues.push(...locationIssues);
			}

			// Plot thread consistency checks
			if (checkTypes.includes('all') || checkTypes.includes('plotThreads')) {
				const plotIssues = await checkPlotThreadConsistency(documents, plotThreads);
				issues.push(...plotIssues);
			}

			// Sort issues by severity
			issues.sort((a, b) => {
				const severityOrder = { error: 0, warning: 1, info: 2 };
				return severityOrder[a.severity] - severityOrder[b.severity];
			});

			const summary = createConsistencySummary(issues);

			const report = {
				issues,
				counts: {
					total: issues.length,
					errors: issues.filter((i) => i.severity === 'error').length,
					warnings: issues.filter((i) => i.severity === 'warning').length,
					info: issues.filter((i) => i.severity === 'info').length,
				},
				checkTypes,
			};

			return {
				content: [
					{
						type: 'text',
						text: `${summary}\n\n${compact(report)}`,
					},
				],
				structuredContent: report,
			};
		} catch (error) {
			return {
				content: [
					{
						type: 'text',
						text: `Error performing consistency check: ${formatError(error)}`,
					},
				],
				structuredContent: {
					issues: [],
					counts: { total: 0, errors: 0, warnings: 0, info: 0 },
					checkTypes,
				},
			};
		}
	},
};

// Consistency checking helper functions
type ConsistencyIssue = {
	type: 'character' | 'timeline' | 'worldbuilding' | 'plot' | 'location';
	severity: 'error' | 'warning' | 'info';
	documentId?: string;
	description: string;
	suggestion?: string;
};
async function checkCharacterConsistency(
	documents: ScrivenerDocument[],
	characters: CharacterProfile[]
): Promise<ConsistencyIssue[]> {
	const issues: ConsistencyIssue[] = [];

	// Pre-build a map of name variation -> (docId -> count) in a single pass over documents
	const allVariations = new Set<string>();
	for (const character of characters) {
		allVariations.add(character.name.toLowerCase());
		const firstName = character.name.split(' ')[0]?.toLowerCase();
		if (firstName) allVariations.add(firstName);
	}

	const variationDocCounts = new Map<string, Map<string, number>>();
	for (const v of allVariations) {
		variationDocCounts.set(v, new Map());
	}

	for (const doc of documents) {
		if (!doc.content) continue;
		const content = doc.content.toLowerCase();
		for (const variation of allVariations) {
			const regex = new RegExp(`\\b${variation}\\b`, 'gi');
			const matches = content.match(regex);
			if (matches && matches.length > 0) {
				variationDocCounts.get(variation)!.set(doc.id, matches.length);
			}
		}
	}

	for (const character of characters) {
		const nameVariations = [
			character.name.toLowerCase(),
			character.name.split(' ')[0]?.toLowerCase(),
		].filter(Boolean) as string[];

		// Aggregate mentions from pre-built map
		const mentionsByDoc = new Map<string, number>();
		for (const variation of nameVariations) {
			const docCounts = variationDocCounts.get(variation);
			if (docCounts) {
				for (const [docId, count] of docCounts) {
					mentionsByDoc.set(docId, (mentionsByDoc.get(docId) || 0) + count);
				}
			}
		}

		const mentions = Array.from(mentionsByDoc.entries()).map(([docId, count]) => ({
			docId,
			count,
		}));

		// Check for character inconsistencies
		if (mentions.length === 0) {
			issues.push({
				type: 'character',
				severity: 'warning',
				description: `Character "${character.name}" is defined but never mentioned in any document`,
				suggestion: 'Remove unused character or add references to the story',
			});
		} else if (mentions.length === 1 && mentions[0].count < 3) {
			issues.push({
				type: 'character',
				severity: 'info',
				documentId: mentions[0].docId,
				description: `Character "${character.name}" only appears briefly in one document`,
				suggestion: "Consider expanding the character's role or removing if not essential",
			});
		}

		// Check for sudden disappearances
		const orderedMentions = mentions.sort((a, b) => a.docId.localeCompare(b.docId));

		if (orderedMentions.length > 2) {
			// Check if character disappears for extended periods
			// Create a map of all documents for easier lookup
			const docMap = new Map(documents.map((d) => [d.id, d]));

			// Get document indices for proper ordering
			const docIndices = new Map<string, number>();
			documents.forEach((doc, index) => {
				if (doc.id) docIndices.set(doc.id, index);
			});

			// Analyze gaps between character appearances
			for (let i = 0; i < orderedMentions.length - 1; i++) {
				const currentMention = orderedMentions[i];
				const nextMention = orderedMentions[i + 1];

				const currentIndex = docIndices.get(currentMention.docId) ?? 0;
				const nextIndex = docIndices.get(nextMention.docId) ?? 0;
				const gap = nextIndex - currentIndex;

				// Flag if character disappears for more than 3 consecutive chapters
				if (gap > 3) {
					const currentDoc = docMap.get(currentMention.docId);
					const nextDoc = docMap.get(nextMention.docId);

					issues.push({
						type: 'character',
						description: `${character.name} disappears for ${gap - 1} chapter(s) between "${currentDoc?.title}" and "${nextDoc?.title}"`,
						severity: gap > 5 ? 'error' : 'warning',
						documentId: currentMention.docId,
						suggestion:
							gap > 5
								? "Consider adding mentions or explaining the character's absence"
								: 'Verify if character absence is intentional',
					});
				}
			}

			// Check for abrupt final disappearance
			const lastMention = orderedMentions[orderedMentions.length - 1];
			const lastMentionIndex = docIndices.get(lastMention.docId) ?? 0;
			const remainingChapters = documents.length - lastMentionIndex - 1;

			if (remainingChapters > 3) {
				const lastDoc = docMap.get(lastMention.docId);
				issues.push({
					type: 'character',
					description: `${character.name} disappears after "${lastDoc?.title}" with ${remainingChapters} chapters remaining`,
					severity: remainingChapters > 5 ? 'error' : 'warning',
					documentId: lastMention.docId,
					suggestion:
						"Consider resolving the character's storyline or explaining their absence",
				});
			}
		}
	}

	return issues;
}

async function checkTimelineConsistency(
	documents: ScrivenerDocument[]
): Promise<ConsistencyIssue[]> {
	const issues: ConsistencyIssue[] = [];

	// Look for temporal inconsistencies in document content
	const timeKeywords = [
		'yesterday',
		'today',
		'tomorrow',
		'last week',
		'next week',
		'months ago',
		'years later',
	];

	for (const doc of documents) {
		if (!doc.content) continue;

		const content = doc.content.toLowerCase();
		const timeReferences: Array<{ keyword: string; match: string }> = [];

		for (const keyword of timeKeywords) {
			const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
			const matches = content.match(regex);
			if (matches) {
				timeReferences.push(...matches.map((m: string) => ({ keyword, match: m })));
			}
		}

		// Check for conflicting time references within the same document
		if (timeReferences.length > 3) {
			const hasConflicts = timeReferences.some((ref) =>
				timeReferences.some(
					(other) =>
						ref.keyword !== other.keyword &&
						['yesterday', 'today', 'tomorrow'].includes(ref.keyword) &&
						['yesterday', 'today', 'tomorrow'].includes(other.keyword)
				)
			);

			if (hasConflicts) {
				issues.push({
					type: 'timeline',
					severity: 'warning',
					documentId: doc.id,
					description: `Document "${doc.title}" contains potentially conflicting time references`,
					suggestion: 'Review temporal references for consistency within the scene',
				});
			}
		}
	}

	return issues;
}

async function checkLocationConsistency(
	documents: ScrivenerDocument[],
	memoryManager: MemoryManager
): Promise<ConsistencyIssue[]> {
	const issues: ConsistencyIssue[] = [];

	// Get world-building information if available
	let worldBuilding: Record<string, unknown> = {};
	try {
		const context = memoryManager.getCustomContext('worldBuilding');
		worldBuilding = (context as Record<string, unknown>) || {};
	} catch {
		// World building not available
	}

	const locations = (worldBuilding.locations as unknown[]) || [];
	const locationNames = locations
		.map((loc) => {
			const location = loc as Record<string, unknown>;
			return typeof location.name === 'string' ? location.name.toLowerCase() : '';
		})
		.filter(Boolean);

	// Check for undefined locations mentioned in documents
	for (const doc of documents) {
		if (!doc.content) continue;

		// TODO: Look for location patterns (this is simplified - could be more sophisticated)
		const locationPatterns = [
			/\bat (?:the )?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g,
			/\bin (?:the )?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g,
		];

		for (const pattern of locationPatterns) {
			let match;
			while ((match = pattern.exec(doc.content)) !== null) {
				const possibleLocation = match[1].toLowerCase();

				// Skip common words that aren't locations
				if (
					['the', 'a', 'an', 'his', 'her', 'their', 'morning', 'evening'].includes(
						possibleLocation
					)
				) {
					continue;
				}

				if (locationNames.length > 0 && !locationNames.includes(possibleLocation)) {
					// Only flag if we have a defined world-building system
					issues.push({
						type: 'location',
						severity: 'info',
						documentId: doc.id,
						description: `Possible undefined location "${match[1]}" mentioned in "${doc.title}"`,
						suggestion: 'Add to world-building notes if this is a significant location',
					});
				}
			}
		}
	}

	return issues;
}

async function checkPlotThreadConsistency(
	documents: ScrivenerDocument[],
	plotThreads: PlotThread[]
): Promise<ConsistencyIssue[]> {
	const issues: ConsistencyIssue[] = [];

	for (const thread of plotThreads) {
		if (!thread.documents || thread.documents.length === 0) {
			issues.push({
				type: 'plot',
				severity: 'warning',
				description: `Plot thread "${thread.name}" has no associated documents`,
				suggestion: 'Link relevant documents to this plot thread or remove if unused',
			});
			continue;
		}

		// Check if plot thread documents exist
		const missingDocs = [];
		for (const docId of thread.documents) {
			const docExists = documents.some((d) => d.id === docId);
			if (!docExists) {
				missingDocs.push(docId);
			}
		}

		if (missingDocs.length > 0) {
			issues.push({
				type: 'plot',
				severity: 'error',
				description: `Plot thread "${thread.name}" references ${missingDocs.length} missing document(s)`,
				suggestion: 'Update plot thread to remove references to deleted documents',
			});
		}

		// Check plot thread progression
		if (thread.status === 'setup' && thread.documents.length > 5) {
			issues.push({
				type: 'plot',
				severity: 'info',
				description: `Plot thread "${thread.name}" has been in setup phase across many documents`,
				suggestion: 'Consider advancing this plot thread to development phase',
			});
		}
	}

	return issues;
}

function createConsistencySummary(issues: ConsistencyIssue[]): string {
	const totalIssues = issues.length;
	const errors = issues.filter((i) => i.severity === 'error').length;
	const warnings = issues.filter((i) => i.severity === 'warning').length;
	const infos = issues.filter((i) => i.severity === 'info').length;

	if (totalIssues === 0) {
		return 'No consistency issues found. Your project appears to be well-structured!';
	}

	let summary = `Found ${totalIssues} consistency issue${totalIssues !== 1 ? 's' : ''}:\n`;

	if (errors > 0) {
		summary += `\n🔴 ${errors} error${errors !== 1 ? 's' : ''} (require immediate attention)`;
	}
	if (warnings > 0) {
		summary += `\n⚠️ ${warnings} warning${warnings !== 1 ? 's' : ''} (should be reviewed)`;
	}
	if (infos > 0) {
		summary += `\n💡 ${infos} suggestion${infos !== 1 ? 's' : ''} (optional improvements)`;
	}

	summary += '\n\nReview the detailed issues below for specific recommendations.';

	return summary;
}

// Advanced analysis handlers
