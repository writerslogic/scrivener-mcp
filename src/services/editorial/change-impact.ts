import { z } from 'zod';
import type { ManuscriptSource, SourceDocument, SourcePassage, StoryFact } from './types.js';
import type { PersistentStore } from './persistent-store.js';
import type { SeriesBible } from './series-bible.js';
import type { ContinuityFinding, ContinuityService } from './continuity-service.js';
import type { ReviewService } from './review-service.js';
import { passageState, sourcePassage, stableStoryId, verifyPassage } from './provenance.js';

const DEPENDENCIES = 'story:dependencies';
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const impactInput = z
	.object({
		documentId: z.string().uuid().describe('Saved scene whose change is being evaluated.'),
		expectedRevision: revision.describe('Current saved RTF revision; stale requests fail.'),
		kind: z
			.enum(['replace', 'remove', 'move'])
			.describe('Hypothetical change; never mutates the manuscript.'),
		replacementText: z
			.string()
			.max(1000000)
			.optional()
			.describe(
				'Complete hypothetical scene text for replace, unless proposalId is supplied.'
			),
		proposalId: z
			.string()
			.uuid()
			.optional()
			.describe('Use an existing guarded review preview instead of replacementText.'),
		editIds: z
			.array(z.string().uuid())
			.min(1)
			.max(1000)
			.optional()
			.describe('Pending proposal edits to evaluate.'),
		beforeDocumentId: z
			.string()
			.uuid()
			.nullable()
			.optional()
			.describe('Move before this scene; null means the end of the manuscript.'),
		terms: z
			.array(z.string().trim().min(1).max(100))
			.max(20)
			.optional()
			.describe('Additional names or terms to locate as candidate downstream references.'),
		limit: z
			.number()
			.int()
			.min(1)
			.max(500)
			.default(100)
			.describe('Maximum returned impacts; total and truncated disclose omitted results.'),
	})
	.strict()
	.superRefine((value, ctx) => {
		const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
		if (value.kind === 'replace') {
			if ((value.replacementText === undefined) === (value.proposalId === undefined))
				issue('Replace requires exactly one of replacementText or proposalId');
			if (value.beforeDocumentId !== undefined)
				issue('beforeDocumentId is only valid for move');
		} else if (
			value.replacementText !== undefined ||
			value.proposalId !== undefined ||
			value.editIds !== undefined
		)
			issue('Replacement fields require kind replace');
		if (value.editIds && !value.proposalId) issue('editIds requires proposalId');
		if (value.kind === 'move' && value.beforeDocumentId === undefined)
			issue('Move requires beforeDocumentId, or null for the end');
		if (value.kind === 'remove' && value.beforeDocumentId !== undefined)
			issue('beforeDocumentId is only valid for move');
	});
export type ImpactRequest = z.input<typeof impactInput>;

export interface StoryDependency {
	id: string;
	kind: 'causal' | 'timeline' | 'revelation';
	prerequisite: SourcePassage;
	dependent: SourcePassage;
	explanation: string;
}
export interface ChangeImpact {
	id: string;
	kind: 'story-fact' | 'continuity-finding' | 'dependency' | 'order' | 'mention';
	certainty: 'recorded-reference' | 'candidate';
	description: string;
	evidence: SourcePassage[];
	stale: boolean;
	referenceId?: string;
}

function snapshot(documents: SourceDocument[]): string {
	return stableStoryId(
		...documents.map((doc) => `${doc.documentId}:${doc.revision}:${doc.order}`)
	);
}

export function evaluateChangeImpact(
	documents: SourceDocument[],
	facts: StoryFact[],
	findings: ContinuityFinding[],
	dependencies: StoryDependency[],
	input: ImpactRequest
) {
	const request = impactInput.parse(input);
	if (request.proposalId) throw new Error('Resolve a proposal preview before evaluating impact');
	if (
		documents.length > 1000 ||
		documents.reduce((n, doc) => n + doc.text.length, 0) > 5000000 ||
		facts.length > 10000 ||
		findings.length > 10000 ||
		dependencies.length > 10000
	)
		throw new Error('Impact scope exceeds its bounded analysis budget');
	const byId = new Map(documents.map((doc) => [doc.documentId, doc]));
	if (byId.size !== documents.length) throw new Error('Duplicate source document identity');
	const changed = byId.get(request.documentId);
	if (!changed || changed.revision !== request.expectedRevision)
		throw new Error(
			'Saved source changed or is outside the manuscript; refresh before checking impact'
		);
	if (documents.some((doc) => doc.projectId !== changed.projectId))
		throw new Error('Impact sources must belong to one project');
	const ordered = [...documents].sort((a, b) => a.order - b.order);
	const next = ordered.filter((doc) => doc.documentId !== changed.documentId);
	if (request.kind === 'move') {
		if (request.beforeDocumentId === changed.documentId)
			throw new Error('A scene cannot move before itself');
		const at =
			request.beforeDocumentId === null
				? next.length
				: next.findIndex((doc) => doc.documentId === request.beforeDocumentId);
		if (at < 0) throw new Error('Move destination is outside the manuscript');
		next.splice(at, 0, changed);
	}
	const ranks = new Map(next.map((doc, index) => [doc.documentId, index]));
	const impacts: ChangeImpact[] = [];
	let total = 0;
	let evidenceCharacters = 0;
	const current = (passage: SourcePassage) =>
		passage.projectId === changed.projectId &&
		passageState(byId.get(passage.documentId), passage) === 'current';
	const add = (impact: Omit<ChangeImpact, 'id' | 'stale'>) => {
		total++;
		const characters = impact.evidence.reduce((sum, passage) => sum + passage.quote.length, 0);
		if (impacts.length < request.limit && evidenceCharacters + characters <= 1000000) {
			evidenceCharacters += characters;
			impacts.push({
				...impact,
				id: stableStoryId(
					impact.kind,
					impact.referenceId ?? '',
					...impact.evidence.map((p) => `${p.documentId}:${p.start}:${p.end}`)
				),
				stale: impact.evidence.some((p) => !current(p)),
			});
		}
	};
	const touched = (passage: SourcePassage) =>
		passage.projectId === changed.projectId && passage.documentId === changed.documentId;
	const changedText =
		request.kind === 'remove' ||
		(request.kind === 'replace' && request.replacementText !== changed.text);
	if (changedText) {
		for (const fact of facts) {
			if (!fact.sources.some(touched)) continue;
			add({
				kind: 'story-fact',
				certainty: 'recorded-reference',
				referenceId: fact.id,
				description: `Revalidate ${fact.subject}: ${fact.predicate} = ${fact.value}; its cited scene ${request.kind === 'remove' ? 'would be removed' : 'would change revision'}.`,
				evidence: fact.sources,
			});
		}
		for (const finding of findings) {
			if (!finding.evidence.some(touched)) continue;
			add({
				kind: 'continuity-finding',
				certainty: 'recorded-reference',
				referenceId: finding.id,
				description: `Recheck this ${finding.status} finding against the changed source: ${finding.description}`,
				evidence: finding.evidence,
			});
		}
	}
	for (const dependency of dependencies) {
		if (![dependency.prerequisite, dependency.dependent].some(touched)) continue;
		const evidence = [dependency.prerequisite, dependency.dependent];
		if (changedText)
			add({
				kind: 'dependency',
				certainty: 'recorded-reference',
				referenceId: dependency.id,
				description: `Revalidate the author's ${dependency.kind} dependency: ${dependency.explanation}`,
				evidence,
			});
		if (request.kind === 'move' && !evidence.every(current))
			add({
				kind: 'dependency',
				certainty: 'recorded-reference',
				referenceId: dependency.id,
				description: `Refresh stale evidence before judging this dependency: ${dependency.explanation}`,
				evidence,
			});
		if (request.kind === 'move' && evidence.every(current)) {
			const before =
				byId.get(dependency.prerequisite.documentId)!.order <
				byId.get(dependency.dependent.documentId)!.order;
			const after =
				ranks.get(dependency.prerequisite.documentId)! <
				ranks.get(dependency.dependent.documentId)!;
			if (before !== after)
				add({
					kind: 'order',
					certainty: 'recorded-reference',
					referenceId: dependency.id,
					description: `${after ? 'Restores' : 'Reverses'} the recorded prerequisite order: ${dependency.explanation}. Binder order is not inferred story time.`,
					evidence,
				});
		}
	}
	const terms = new Set(request.terms ?? []);
	for (const fact of facts) {
		if (fact.sources.some(touched) && ['character', 'alias', 'location'].includes(fact.kind)) {
			if (terms.size < 32 && fact.subject.length <= 100) terms.add(fact.subject);
			if (fact.kind === 'alias' && terms.size < 32 && fact.value.length <= 100)
				terms.add(fact.value);
		}
	}
	if (changedText || (request.kind === 'move' && snapshot(ordered) !== snapshot(next))) {
		for (const document of ordered) {
			if (document.documentId === changed.documentId) continue;
			for (const term of terms) {
				const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				const pattern = new RegExp(
					`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,
					'iu'
				);
				const match = pattern.exec(document.text);
				if (!match) continue;
				add({
					kind: 'mention',
					certainty: 'candidate',
					description: `Review the reference to ${JSON.stringify(term)}; a name match does not establish a contradiction or dependency.`,
					evidence: [sourcePassage(document, match.index, match.index + match[0].length)],
				});
			}
		}
	}
	return {
		projectId: changed.projectId,
		documentId: changed.documentId,
		sourceRevision: changed.revision,
		snapshot: snapshot(ordered),
		kind: request.kind,
		impacts,
		total,
		truncated: total > impacts.length,
		analyzedDocuments: documents.length,
		coverage:
			'Read-only impact preview of recorded citations, author-defined dependencies and literal name references. No automatic inference of plot causality, character knowledge or story time. Only saved manuscript scenes and project-scoped facts are analyzed; no findings means no tracked impact was found, not proof that a change is safe.',
	};
}

export class ChangeImpactService {
	constructor(
		private readonly source: ManuscriptSource,
		private readonly store: PersistentStore,
		private readonly bible: SeriesBible,
		private readonly continuity: ContinuityService,
		private readonly review: ReviewService
	) {}

	dependencyPage(options: { after?: string; limit?: number } = {}) {
		return this.store.page<StoryDependency>(DEPENDENCIES, options);
	}

	listDependencies(): StoryDependency[] {
		return this.store.list<StoryDependency>(DEPENDENCIES, {
			maxItems: 10000,
			maxBytes: 32 * 1024 * 1024,
		});
	}

	async link(input: Omit<StoryDependency, 'id'>): Promise<StoryDependency> {
		if (
			!['causal', 'timeline', 'revelation'].includes(input.kind) ||
			typeof input.explanation !== 'string' ||
			!input.explanation.trim() ||
			input.explanation.length > 2000 ||
			input.explanation.includes('\0')
		)
			throw new Error('Invalid dependency kind or explanation');
		if (
			!input.prerequisite ||
			!input.dependent ||
			input.prerequisite.projectId !== this.source.projectId ||
			input.dependent.projectId !== this.source.projectId ||
			input.prerequisite.documentId === input.dependent.documentId
		)
			throw new Error('Dependencies require two distinct scenes in this project');
		const docs = await this.source.list({ maxDocuments: 1000, maxCharacters: 5000000 });
		const passages = [input.prerequisite, input.dependent].map((p) => {
			const doc = docs.find((item) => item.documentId === p.documentId);
			if (!doc) throw new Error('Dependency evidence is outside the manuscript');
			return verifyPassage(doc, p);
		});
		const dependency = {
			id: stableStoryId(
				input.kind,
				...passages.map((p) => `${p.documentId}:${p.revision}:${p.start}:${p.end}`)
			),
			kind: input.kind,
			prerequisite: passages[0],
			dependent: passages[1],
			explanation: input.explanation.trim(),
		};
		this.store.transaction(() => {
			const prior = this.store.get<StoryDependency>(DEPENDENCIES, dependency.id);
			if (prior && prior.explanation !== dependency.explanation)
				throw new Error(
					'Dependency already exists with a different explanation; remove it before replacing'
				);
			if (!prior && this.store.count(DEPENDENCIES) >= 10000)
				throw new Error('At most 10000 story dependencies are supported');
			this.store.put(DEPENDENCIES, dependency.id, dependency);
		});
		return dependency;
	}

	unlink(id: string): void {
		if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
			throw new Error('Invalid dependency ID');
		this.store.delete(DEPENDENCIES, id);
	}

	async analyze(input: ImpactRequest) {
		const request = impactInput.parse(input);
		const documents = await this.source.list({ maxDocuments: 1000, maxCharacters: 5000000 });
		let replacementText = request.replacementText;
		if (request.proposalId) {
			const preview = await this.review.preview(request.proposalId, request.editIds);
			if (
				preview.documentId !== request.documentId ||
				preview.revision !== request.expectedRevision
			)
				throw new Error('Proposal does not match the selected saved scene');
			replacementText = preview.after;
		}
		const facts = await this.bible.listFacts(
			{ kind: 'project', id: this.source.projectId },
			{
				sourceDocuments: documents,
				readLimits: { maxItems: 10000, maxBytes: 32 * 1024 * 1024 },
			}
		);
		const report = evaluateChangeImpact(
			documents,
			facts,
			this.continuity.list({
				includeResolved: true,
				readLimits: { maxItems: 10000, maxBytes: 32 * 1024 * 1024 },
			}),
			this.listDependencies(),
			{ ...request, proposalId: undefined, editIds: undefined, replacementText }
		);
		const latest = await this.source.list({ maxDocuments: 1000, maxCharacters: 5000000 });
		if (snapshot(latest) !== snapshot(documents))
			throw new Error('Manuscript changed during impact analysis; refresh and retry');
		return report;
	}
}
