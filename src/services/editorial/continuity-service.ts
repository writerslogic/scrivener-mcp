import type { PersistentStore } from './persistent-store.js';
import type { SeriesBible } from './series-bible.js';
import type {
	FactConfidence,
	SourceDocument,
	SourcePassage,
	StoryFact,
	ManuscriptSource,
} from './types.js';
import {
	passageState,
	sourcePassage,
	stableStoryId,
	storyIdentifier,
	storyText,
	passageKey,
} from './provenance.js';

export type FindingStatus = 'open' | 'confirmed' | 'dismissed' | 'resolved';
export type ContinuityCheck = 'characters' | 'timeline' | 'locations' | 'plotThreads' | 'all';

export interface ContinuityFinding {
	id: string;
	type: 'character' | 'timeline' | 'location' | 'worldbuilding' | 'plot';
	severity: 'error' | 'warning' | 'info';
	documentId: string;
	description: string;
	suggestion: string;
	confidence: FactConfidence;
	status: FindingStatus;
	evidence: SourcePassage[];
	factIds: string[];
	order: number;
	stale: boolean;
	basis: 'canon-conflict' | 'candidate-mismatch';
	createdAt: string;
	updatedAt: string;
	checkedAt: string;
	note?: string;
	resolution?: 'author' | 'no-longer-detected';
	seriesId?: string;
}

export interface ContinuityReport {
	issues: ContinuityFinding[];
	counts: { total: number; errors: number; warnings: number; info: number };
	checkTypes: ContinuityCheck[];
	candidates: StoryFact[];
	analyzedDocuments: number;
	analyzedAt: string;
	coverage: string;
}

export interface ContinuityOptions {
	checkTypes?: ContinuityCheck[];
	documentIds?: string[];
	seriesId?: string;
}

const FINDINGS = 'continuity:findings';
const CHECKS: readonly ContinuityCheck[] = [
	'characters',
	'timeline',
	'locations',
	'plotThreads',
	'all',
];
const IMMUTABLE = new Set(['birth-year', 'birthplace', 'species']);

function normalized(value: string): string {
	return value.normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/g, ' ').trim();
}

export function extractContinuityCandidates(document: SourceDocument): StoryFact[] {
	const name = "([\\p{Lu}][\\p{L}\\p{M}'’.-]*(?: [\\p{Lu}][\\p{L}\\p{M}'’.-]*){0,2})";
	const colors =
		'(blue|green|brown|hazel|grey|gray|amber|black|violet|red|blond|blonde|silver|white)';
	const patterns: Array<{ pattern: RegExp; predicate: string; kind: StoryFact['kind'] }> = [
		{
			pattern: new RegExp(`${name}['’]s eyes (?:are|were) ${colors}\\b`, 'gu'),
			predicate: 'eye-color',
			kind: 'character',
		},
		{
			pattern: new RegExp(`${name} (?:has|had) ${colors} eyes\\b`, 'gu'),
			predicate: 'eye-color',
			kind: 'character',
		},
		{
			pattern: new RegExp(`${name}['’]s hair (?:is|was) ${colors}\\b`, 'gu'),
			predicate: 'hair-color',
			kind: 'character',
		},
		{
			pattern: new RegExp(`${name} was born in ([0-9]{4})\\b`, 'gu'),
			predicate: 'birth-year',
			kind: 'chronology',
		},
	];
	const candidates: StoryFact[] = [];
	for (const { pattern, predicate, kind } of patterns) {
		for (const match of document.text.matchAll(pattern)) {
			if (candidates.length >= 256)
				throw new Error(
					'Document has more than 256 explicit continuity candidates; narrow the analysis scope'
				);
			const start = match.index;
			const quote = sourcePassage(document, start, start + match[0].length);
			const surrounding = document.text.slice(
				Math.max(0, start - 100),
				Math.min(document.text.length, start + match[0].length + 100)
			);
			const uncertain =
				/[“”"]|\b(?:dream|dreamed|dreamt|imagined|rumou?r|claimed|pretended|perhaps|maybe|unreliable)\b/i.test(
					surrounding
				);
			const metadata = document.metadata;
			const flashback =
				/^(?:true|yes|1)$/i.test(metadata.flashback ?? '') ||
				/\bflashback\b/i.test(document.title);
			const storyTime = metadata.storyTime || metadata['story-time'] || metadata.timeline;
			const intentional = /^(?:true|yes|1)$/i.test(
				metadata.intentionalContradiction ?? metadata['intentional-contradiction'] ?? ''
			);
			const fact: StoryFact = {
				id: stableStoryId(
					'candidate',
					document.projectId,
					document.documentId,
					document.revision,
					String(start),
					predicate
				),
				scope: { kind: 'project', id: document.projectId },
				kind,
				subject: match[1],
				predicate,
				value: match[2] === 'gray' ? 'grey' : match[2],
				confidence: uncertain || (flashback && !storyTime) ? 'uncertain' : 'inferred',
				sources: [quote],
				updatedAt: new Date().toISOString(),
			};
			if (storyTime) fact.storyTime = storyTime;
			if (flashback && !storyTime) fact.storyTime = `flashback:${document.documentId}`;
			if (intentional) fact.intentional = true;
			candidates.push(fact);
		}
	}
	return candidates;
}

export class ContinuityService {
	constructor(
		private readonly source: ManuscriptSource,
		private readonly store: PersistentStore,
		private readonly bible: SeriesBible
	) {}

	async analyze(options: ContinuityOptions = {}): Promise<ContinuityReport> {
		const checkTypes = options.checkTypes ?? ['all'];
		if (
			!Array.isArray(checkTypes) ||
			checkTypes.length === 0 ||
			checkTypes.length > CHECKS.length ||
			checkTypes.some((check) => !CHECKS.includes(check))
		)
			throw new Error('Choose valid continuity check types');
		if (
			options.documentIds !== undefined &&
			(!Array.isArray(options.documentIds) ||
				options.documentIds.length === 0 ||
				options.documentIds.length > 5000)
		)
			throw new Error('Document scope must contain 1 to 5000 document ids');
		return this.analyzeSnapshot(options, await this.source.list());
	}

	private async analyzeSnapshot(
		options: ContinuityOptions,
		documents: SourceDocument[]
	): Promise<ContinuityReport> {
		const checkTypes = options.checkTypes ?? ['all'];
		const documentById = new Map(documents.map((document) => [document.documentId, document]));
		const wanted = options.documentIds
			? new Set(options.documentIds.map((id) => storyIdentifier(id, 'Document id')))
			: undefined;
		if (wanted && [...wanted].some((id) => !documentById.has(id)))
			throw new Error('A requested document is outside the current manuscript');
		const scoped = documents
			.filter((document) => !wanted || wanted.has(document.documentId))
			.sort((a, b) => a.order - b.order);
		if (
			scoped.length > 5000 ||
			scoped.reduce((length, document) => length + document.text.length, 0) > 50000000
		)
			throw new Error('Continuity scope is too large; analyze a chapter at a time');
		const candidates = scoped.flatMap(extractContinuityCandidates);
		if (candidates.length > 10000)
			throw new Error('Continuity analysis exceeds 10000 candidates; narrow the scope');
		const projectFacts = await this.bible.listFacts(
			{
				kind: 'project',
				id: this.source.projectId,
			},
			{ sourceDocuments: documents }
		);
		const seriesFacts = options.seriesId
			? await this.bible.listFacts(
					{ kind: 'series', id: options.seriesId },
					{ sourceDocuments: documents }
				)
			: [];
		const currentPassages = new Set(
			[...projectFacts, ...seriesFacts].flatMap((fact) =>
				fact.sourceStates
					.filter((passage) => passage.state === 'current')
					.map((passage) => passageKey(passage.source))
			)
		);
		const sourceOrder = (passage: SourcePassage): number =>
			passage.projectId === this.source.projectId
				? (documentById.get(passage.documentId)?.order ?? Number.MAX_SAFE_INTEGER)
				: Number.MAX_SAFE_INTEGER;
		const canon = [...projectFacts, ...seriesFacts].filter((fact) => !fact.stale);
		for (const candidate of candidates) {
			if (
				canon.some(
					(fact) =>
						fact.intentional &&
						normalized(fact.subject) === normalized(candidate.subject) &&
						normalized(fact.predicate) === normalized(candidate.predicate) &&
						fact.sources.some((passage) =>
							candidate.sources.some(
								(source) =>
									source.projectId === passage.projectId &&
									source.documentId === passage.documentId &&
									source.revision === passage.revision &&
									source.start < passage.end &&
									source.end > passage.start
							)
						)
				)
			)
				candidate.intentional = true;
		}
		const aliases = new Map(
			canon
				.filter((fact) => fact.kind === 'alias' && fact.confidence === 'confirmed')
				.map((fact) => [normalized(fact.value), normalized(fact.subject)])
		);
		const subject = (fact: StoryFact): string =>
			aliases.get(normalized(fact.subject)) ?? normalized(fact.subject);
		const groups = new Map<string, StoryFact[]>();
		for (const fact of [...canon, ...candidates]) {
			if (fact.sources.length === 0 || fact.kind === 'alias' || fact.intentional) continue;
			const key = JSON.stringify([subject(fact), normalized(fact.predicate)]);
			const group = groups.get(key) ?? [];
			if (!group.some((existing) => existing.id === fact.id)) group.push(fact);
			groups.set(key, group);
		}
		const detected = new Map<string, ContinuityFinding>();
		const now = new Date().toISOString();
		for (const group of groups.values()) {
			if (group.length > 200)
				throw new Error('Too many facts for one continuity attribute; narrow the scope');
			for (let i = 0; i < group.length; i++) {
				for (let j = i + 1; j < group.length; j++) {
					const left = group[i];
					const right = group[j];
					if (normalized(left.value) === normalized(right.value)) continue;
					if (
						left.storyTime !== right.storyTime &&
						(left.storyTime || right.storyTime) &&
						!IMMUTABLE.has(normalized(left.predicate))
					)
						continue;
					if (left.confidence === 'uncertain' || right.confidence === 'uncertain')
						continue;
					if (
						wanted &&
						![...left.sources, ...right.sources].some(
							(passage) =>
								passage.projectId === this.source.projectId &&
								wanted.has(passage.documentId)
						)
					)
						continue;
					const type = this.category(left.kind);
					if (!checkTypes.includes('all') && !checkTypes.includes(this.checkFor(type)))
						continue;
					const evidence = [
						...new Map(
							[...left.sources, ...right.sources].map((passage) => [
								passageKey(passage),
								passage,
							])
						).values(),
					].sort((a, b) => sourceOrder(a) - sourceOrder(b) || a.start - b.start);
					if (evidence.length < 2) continue;
					const confirmed =
						left.confidence === 'confirmed' &&
						right.confidence === 'confirmed' &&
						(IMMUTABLE.has(normalized(left.predicate)) ||
							Boolean(left.storyTime && left.storyTime === right.storyTime));
					const values = [normalized(left.value), normalized(right.value)].sort();
					const id = stableStoryId(
						'finding',
						this.source.projectId,
						options.seriesId ?? '',
						subject(left),
						normalized(left.predicate),
						...values,
						...evidence
							.map(
								(passage) =>
									`${passage.projectId}:${passage.documentId}:${passage.revision}:${passage.start}`
							)
							.sort()
					);
					if (detected.has(id)) continue;
					const location =
						evidence.find((passage) => passage.projectId === this.source.projectId) ??
						evidence[0];
					const order = sourceOrder(location);
					detected.set(id, {
						id,
						type,
						severity: confirmed ? 'error' : 'warning',
						documentId: location.documentId,
						description: `${confirmed ? 'Conflicting confirmed facts' : 'Potential continuity mismatch'} for ${left.subject}: ${left.predicate} has competing values ${JSON.stringify(left.value)} and ${JSON.stringify(right.value)}.`,
						suggestion:
							'Review the quoted context and story time; confirm canon, record an intentional variation, or dismiss the finding.',
						confidence: confirmed ? 'confirmed' : 'inferred',
						status: 'open',
						evidence,
						factIds: [left.id, right.id],
						order,
						stale: false,
						basis: confirmed ? 'canon-conflict' : 'candidate-mismatch',
						createdAt: now,
						updatedAt: now,
						checkedAt: now,
						...(options.seriesId ? { seriesId: options.seriesId } : {}),
					});
				}
			}
		}
		const findings = this.store.transaction(() => {
			const results: ContinuityFinding[] = [];
			for (const finding of detected.values()) {
				const existing = this.store.get<ContinuityFinding>(FINDINGS, finding.id);
				const reopened = existing?.resolution === 'no-longer-detected';
				const current = existing
					? {
							...finding,
							status: reopened ? ('open' as const) : existing.status,
							note: existing.note,
							createdAt: existing.createdAt,
							resolution: reopened ? undefined : existing.resolution,
							updatedAt: reopened ? now : existing.updatedAt,
						}
					: finding;
				this.store.put(FINDINGS, current.id, current);
				results.push(current);
			}
			for (const previous of this.store.list<ContinuityFinding>(FINDINGS)) {
				if (
					detected.has(previous.id) ||
					previous.status === 'dismissed' ||
					previous.status === 'resolved' ||
					previous.seriesId !== options.seriesId
				)
					continue;
				if (
					!checkTypes.includes('all') &&
					!checkTypes.includes(this.checkFor(previous.type))
				)
					continue;
				if (
					wanted &&
					!previous.evidence.some(
						(passage) =>
							passage.projectId === this.source.projectId &&
							wanted.has(passage.documentId)
					)
				)
					continue;
				previous.status = 'resolved';
				previous.resolution = 'no-longer-detected';
				previous.stale = previous.evidence.some((passage) => {
					const document =
						passage.projectId === this.source.projectId
							? documentById.get(passage.documentId)
							: undefined;
					return document
						? passageState(document, passage) !== 'current'
						: !currentPassages.has(passageKey(passage));
				});
				previous.checkedAt = now;
				previous.updatedAt = now;
				this.store.put(FINDINGS, previous.id, previous);
			}
			return results;
		});
		const issues = findings
			.filter((finding) => finding.status === 'open' || finding.status === 'confirmed')
			.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
		return {
			issues,
			counts: {
				total: issues.length,
				errors: issues.filter((issue) => issue.severity === 'error').length,
				warnings: issues.filter((issue) => issue.severity === 'warning').length,
				info: issues.filter((issue) => issue.severity === 'info').length,
			},
			checkTypes,
			candidates,
			analyzedDocuments: scoped.length,
			analyzedAt: now,
			coverage:
				'Local analysis compares curated facts and explicit eye-color, hair-color and birth-year statements. Narrative candidates remain inferred; quoted/dream context and untimed flashbacks remain uncertain. Location, world-rule and chronology conflicts require curated facts with matching subjects and predicates. Keyword counts, character absence and plot-thread silence are not treated as contradictions. Story time is not inferred from binder order.',
		};
	}

	list(options: { includeResolved?: boolean } = {}): ContinuityFinding[] {
		return this.store
			.list<ContinuityFinding>(FINDINGS)
			.filter(
				(finding) =>
					options.includeResolved ||
					finding.status === 'open' ||
					finding.status === 'confirmed'
			)
			.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
	}

	transition(
		id: string,
		action: 'confirm' | 'dismiss' | 'resolve',
		note?: string
	): ContinuityFinding {
		storyIdentifier(id, 'Finding id');
		if (!['confirm', 'dismiss', 'resolve'].includes(action))
			throw new Error('Finding action must be confirm, dismiss or resolve');
		if (note !== undefined) storyText(note, 'Finding note');
		return this.store.transaction(() => {
			const finding = this.store.get<ContinuityFinding>(FINDINGS, id);
			if (!finding) throw new Error('Continuity finding was not found');
			if (action === 'confirm' && finding.stale)
				throw new Error('Recheck stale source passages before confirming this finding');
			finding.status =
				action === 'confirm'
					? 'confirmed'
					: action === 'dismiss'
						? 'dismissed'
						: 'resolved';
			if (note !== undefined) finding.note = note.trim();
			if (action === 'resolve') finding.resolution = 'author';
			else delete finding.resolution;
			finding.updatedAt = new Date().toISOString();
			this.store.put(FINDINGS, id, finding);
			return finding;
		});
	}

	async recheck(id?: string): Promise<ContinuityFinding[]> {
		if (id !== undefined) storyIdentifier(id, 'Finding id');
		const requested = id ? this.store.get<ContinuityFinding>(FINDINGS, id) : undefined;
		if (id && !requested) throw new Error('Continuity finding was not found');
		const initial = requested ? [requested] : this.list({ includeResolved: true });
		if (!initial.length) return [];
		const memberships = new Set(this.bible.listSeries().map((series) => series.id));
		const documents = await this.source.list();
		for (const seriesId of new Set(initial.map((finding) => finding.seriesId))) {
			if (!seriesId || memberships.has(seriesId))
				await this.analyzeSnapshot({ seriesId }, documents);
		}
		const findings = id
			? [this.store.get<ContinuityFinding>(FINDINGS, id)!]
			: this.list({ includeResolved: true });
		const groups = new Map<string | undefined, ContinuityFinding[]>();
		for (const finding of findings) {
			const group = groups.get(finding.seriesId) ?? [];
			group.push(finding);
			groups.set(finding.seriesId, group);
		}
		const states = new Map<string, boolean>();
		for (const [seriesId, group] of groups) {
			if (seriesId && !memberships.has(seriesId)) {
				for (const finding of group) states.set(finding.id, true);
				continue;
			}
			const passages = [
				...new Map(
					group
						.flatMap((finding) => finding.evidence)
						.map((passage) => [passageKey(passage), passage])
				).values(),
			];
			const scope = seriesId
				? { kind: 'series' as const, id: seriesId }
				: { kind: 'project' as const, id: this.source.projectId };
			const checked = await this.bible.checkPassages(scope, passages, documents);
			const current = new Set(
				checked
					.filter((passage) => passage.state === 'current')
					.map((passage) => passageKey(passage.source))
			);
			for (const finding of group)
				states.set(
					finding.id,
					finding.evidence.some((passage) => !current.has(passageKey(passage)))
				);
		}
		return this.store.transaction(() =>
			findings.map((before) => {
				const finding = this.store.get<ContinuityFinding>(FINDINGS, before.id);
				if (!finding) throw new Error('Continuity finding disappeared while rechecking');
				finding.stale = states.get(finding.id) ?? true;
				finding.checkedAt = new Date().toISOString();
				this.store.put(FINDINGS, finding.id, finding);
				return finding;
			})
		);
	}

	private category(kind: StoryFact['kind']): ContinuityFinding['type'] {
		return kind === 'character' || kind === 'alias'
			? 'character'
			: kind === 'location'
				? 'location'
				: kind === 'world-rule'
					? 'worldbuilding'
					: 'timeline';
	}

	private checkFor(type: ContinuityFinding['type']): ContinuityCheck {
		return type === 'character'
			? 'characters'
			: type === 'timeline'
				? 'timeline'
				: type === 'location'
					? 'locations'
					: type === 'plot'
						? 'plotThreads'
						: 'locations';
	}
}
