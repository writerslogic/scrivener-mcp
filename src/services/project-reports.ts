import * as path from 'path';
import { DOCUMENT_TYPES } from '../core/constants.js';
import { findDraftFolder } from '../utils/binder-tree.js';
import type { CompilationService } from './compilation-service.js';
import type { DocumentManager } from './document-manager.js';
import type { CompileMetadata } from './compile-settings.js';
import { getAccurateWordCount } from '../utils/text-metrics.js';
import type {
	DocumentInfo,
	ProjectStatistics,
	ScrivenerDocument,
	ScrivenerMetadata,
} from '../types/index.js';
import type { ManuscriptBriefing } from '../project-types.js';

/** Project-level statistics and the manuscript briefing. */
export class ProjectReports {
	constructor(
		private readonly projectPath: string,
		private readonly documentManager: DocumentManager,
		private readonly compilationService: CompilationService,
		private readonly readDocument: (documentId: string) => Promise<string>,
		private readonly getProjectMetadata: () => Promise<ScrivenerMetadata>,
		private readonly getCompileMetadata: () => Promise<CompileMetadata>
	) {}

	async getStatistics(): Promise<ProjectStatistics> {
		// getAllDocuments carries neither content nor a word count, so statistics over
		// it report zero words. Read content into the tree first, then aggregate.
		const tree = await this.documentManager.getProjectStructure();
		await this.annotateWordCounts(tree);
		return this.compilationService.getStatistics(tree);
	}

	/**
	 * Read each Text node's content and set its wordCount in place, so statistics
	 * over the tree reflect real prose (the binder tree stores no counts). Content
	 * is capped per document as defense against any binary/outlier; embedded images
	 * are already stripped by the RTF handler. Unreadable documents count as zero.
	 */
	private async annotateWordCounts(nodes: ScrivenerDocument[]): Promise<void> {
		const CONTENT_CAP = 2_000_000;
		for (const node of nodes) {
			if (node.type === DOCUMENT_TYPES.TEXT) {
				try {
					const text = await this.readDocument(node.id);
					node.wordCount = getAccurateWordCount(
						text.length > CONTENT_CAP ? text.slice(0, CONTENT_CAP) : text
					);
				} catch {
					node.wordCount = 0;
				}
			}
			if (node.children?.length) await this.annotateWordCounts(node.children);
		}
	}

	/**
	 * A single "where am I?" orientation of the manuscript: total words against
	 * the project's draft target (with percent-to-goal and deadline), document and
	 * folder counts, the per-status and per-label breakdown, and the longest and
	 * shortest documents. Composes getStatistics with the project's word targets so
	 * a caller does not have to stitch several tools together after open_project.
	 */
	async getManuscriptBriefing(): Promise<ManuscriptBriefing> {
		// Scope to the Draft/Manuscript folder (like Scrivener) and count words from
		// document content (annotateWordCounts), since the binder tree stores none.
		const tree = await this.documentManager.getProjectStructure();
		const draft = findDraftFolder(tree);
		const scopeNodes = draft?.children ?? tree;
		await this.annotateWordCounts(scopeNodes);

		const stats = this.compilationService.getStatistics(scopeNodes);
		const meta = await this.getProjectMetadata();

		// Label and Status are stored on documents as taxonomy ids; resolve them to
		// human names via the compile metadata so the breakdown is readable.
		const taxonomy = await this.getCompileMetadata().catch(() => null);
		const nameById = (
			defs: Array<{ id: string; title: string }> | undefined
		): Map<string, string> => new Map((defs ?? []).map((d) => [d.id, d.title]));
		const labelNames = nameById(taxonomy?.labels);
		const statusNames = nameById(taxonomy?.statuses);
		const relabel = (counts: Record<string, number>, names: Map<string, string>) => {
			const out: Record<string, number> = {};
			for (const [key, n] of Object.entries(counts)) out[names.get(key) ?? key] = n;
			return out;
		};

		// A project with no draft target parses to NaN/undefined; treat only a finite
		// positive number as a real goal so percent-to-target isn't NaN.
		const rawTarget = meta.projectTargets?.draft;
		const draftTarget =
			typeof rawTarget === 'number' && Number.isFinite(rawTarget) && rawTarget > 0
				? rawTarget
				: undefined;
		const slim = (d: DocumentInfo | null) =>
			d ? { id: d.id, title: d.title, wordCount: d.wordCount ?? 0 } : null;

		return {
			// Many projects store no ProjectTitle (Scrivener shows the .scriv filename);
			// fall back to the package basename so the briefing is never nameless.
			title: meta.title || path.basename(this.projectPath, '.scriv'),
			author: meta.author,
			words: {
				total: stats.totalWords,
				draftTarget,
				percentToTarget: draftTarget
					? Math.round((stats.totalWords / draftTarget) * 100)
					: undefined,
				deadline: meta.projectTargets?.deadline,
			},
			documents: {
				total: stats.totalDocuments,
				folders: stats.totalFolders,
				textDocuments: stats.totalDocuments - stats.totalFolders,
			},
			averageDocumentLength: stats.averageDocumentLength,
			byStatus: relabel(stats.documentsByStatus, statusNames),
			byLabel: relabel(stats.documentsByLabel, labelNames),
			longest: slim(stats.longestDocument),
			shortest: slim(stats.shortestDocument),
		};
	}
}
