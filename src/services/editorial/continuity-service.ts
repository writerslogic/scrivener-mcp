import { setTimeout } from 'node:timers/promises';
import { hasNonpersonalObject } from './object-coreference.js';
import type { PersistentStore, StorePageOptions, StorePage } from './persistent-store.js';
import type { SeriesBible, StoryScope, FactView } from './series-bible.js';
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
	signal?: AbortSignal;
	checkTypes?: ContinuityCheck[];
	documentIds?: string[];
	seriesId?: string;
	expectedRevisions?: Array<{ documentId: string; revision: string }>;
}

interface CanonBasis {
	scope: StoryScope;
	revision: string;
	states: FactView['sourceStates'];
}

interface PreparedContinuity {
	bases: CanonBasis[];
	publish: () => ContinuityReport;
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

function markUncertainCandidates(text: string, candidates: StoryFact[]): void {
	const paragraphs = text.matchAll(/\r?\n[ \t]*\r?\n/g);
	let boundary = paragraphs.next();
	let paragraphStart = 0;
	let paragraphEnd = boundary.done ? text.length : boundary.value.index;
	const uncertainLanguage =
		/\b(?:dream|dreamed|dreamt|imagined|rumou?r|claimed|pretended|perhaps|maybe|unreliable|if|unless|imagine|suppose|supposed|false|untrue|denied|denies|not|never|doubt|doubted|doubts|doubtful|questioned|questions|whether)\b|\?/i;
	let uncertainParagraph = uncertainLanguage.test(text.slice(paragraphStart, paragraphEnd));
	const quotes = text.matchAll(/(?:^|\r?\n[ \t]*\r?\n)[ \t]*["']|[“”"‘’']/g);
	let nextQuote = quotes.next();
	let curlyDouble = false,
		straightDouble = false,
		curlySingle = false,
		straightSingle = false;
	for (const candidate of [...candidates].sort(
		(a, b) => a.sources[0].start - b.sources[0].start
	)) {
		const start = candidate.sources[0].start;
		while (!boundary.done && start >= boundary.value.index + boundary.value[0].length) {
			paragraphStart = boundary.value.index + boundary.value[0].length;
			boundary = paragraphs.next();
			paragraphEnd = boundary.done ? text.length : boundary.value.index;
			uncertainParagraph = uncertainLanguage.test(text.slice(paragraphStart, paragraphEnd));
		}
		while (!nextQuote.done && nextQuote.value.index < start) {
			const token = nextQuote.value[0];
			const index = nextQuote.value.index + token.length - 1;
			const character = token[token.length - 1];
			const paragraphOpening = token.length > 1 || index === 0;
			if (character === '“') curlyDouble = true;
			else if (character === '”') curlyDouble = false;
			else if (character === '"') straightDouble = paragraphOpening || !straightDouble;
			else if (character === '‘') curlySingle = true;
			else if (character === "'") {
				const beforeWord = /[\p{L}\p{N}]$/u.test(text.slice(Math.max(0, index - 2), index));
				const afterWord = /^[\p{L}\p{N}]/u.test(text.slice(index + 1, index + 3));
				if (!(beforeWord && afterWord) && (straightSingle || !beforeWord))
					straightSingle = paragraphOpening || !straightSingle;
			} else if (
				!/[\p{L}\p{N}]$/u.test(text.slice(Math.max(0, index - 2), index)) ||
				!/^[\p{L}\p{N}]/u.test(text.slice(index + 1, index + 3))
			)
				curlySingle = false;
			nextQuote = quotes.next();
		}
		if (uncertainParagraph || curlyDouble || straightDouble || curlySingle || straightSingle)
			candidate.confidence = 'uncertain';
	}
}

export function extractContinuityCandidates(document: SourceDocument): StoryFact[] {
	const name =
		"([\\p{Lu}](?:\\.|[\\p{L}\\p{M}'’-]*)(?: [\\p{Lu}](?:\\.|[\\p{L}\\p{M}'’-]*)){0,2})";
	const colors =
		'([Bb]lue|[Gg]reen|[Bb]rown|[Hh]azel|[Gg]rey|[Gg]ray|[Aa]mber|[Bb]lack|[Vv]iolet|[Rr]ed|[Bb]lond|[Bb]londe|[Ss]ilver|[Ww]hite)';
	// Restrict coreference to a complete, single-subject action and its adjacent sentence.
	const antecedent =
		"(?=[\\p{Lu}])(?<=^|[.!?][ \\t]+|\\n)(?!(?:He|She|It|They|We|You|I|The|This|That|Someone|Somebody|Nobody|Everyone|Everybody)\\b)([\\p{Lu}][\\p{L}\\p{M}'’-]*(?: [\\p{Lu}][\\p{L}\\p{M}'’-]*){0,2}) (?:stepped (?:forward|back|backward|aside)|approached|arrived|entered|departed|smiled|nodded|paused|waited|stood|sat)\\.(?:[ \\t]+|[ \\t]*\\r?\\n[ \\t]*)";
	const objectAntecedent =
		"(?=[\\p{Lu}])(?<=^|[.!?][ \\t]+|\\n)(?!(?:He|She|It|They|We|You|I|The|This|That|Someone|Somebody|Nobody|Everyone|Everybody)\\b)([\\p{Lu}][\\p{L}\\p{M}'’-]*(?: [\\p{Lu}][\\p{L}\\p{M}'’-]*){0,2}) ([a-z-]{1,32}(?: [a-z-]{1,32}){2,7})\\.(?:[ \\t]+|[ \\t]*\\r?\\n[ \\t]*)";
	const patterns: Array<{
		pattern: RegExp;
		predicate: string;
		kind: StoryFact['kind'];
		valueFirst?: boolean;
		objectReference?: boolean;
	}> = [
		{
			pattern: new RegExp(
				`${objectAntecedent}(?:Her|His) (?:eyes|irises) (?:are|were) ${colors}\\b`,
				'gu'
			),
			predicate: 'eye-color',
			kind: 'character',
			objectReference: true,
		},
		{
			pattern: new RegExp(
				`${objectAntecedent}(?:Her|His) hair (?:is|was) ${colors}\\b`,
				'gu'
			),
			predicate: 'hair-color',
			kind: 'character',
			objectReference: true,
		},
		{
			pattern: new RegExp(`${objectAntecedent}(?:She|He) was born in ([0-9]{4})\\b`, 'gu'),
			predicate: 'birth-year',
			kind: 'chronology',
			objectReference: true,
		},
		{
			pattern: new RegExp(
				`${antecedent}(?:Her|His) (?:eyes|irises) (?:are|were) ${colors}\\b`,
				'gu'
			),
			predicate: 'eye-color',
			kind: 'character',
		},
		{
			pattern: new RegExp(`${antecedent}(?:Her|His) hair (?:is|was) ${colors}\\b`, 'gu'),
			predicate: 'hair-color',
			kind: 'character',
		},
		{
			pattern: new RegExp(`${antecedent}(?:She|He) was born in ([0-9]{4})\\b`, 'gu'),
			predicate: 'birth-year',
			kind: 'chronology',
		},
		{
			pattern: new RegExp(`${name}['’]s (?:eyes|irises) (?:are|were) ${colors}\\b`, 'gu'),
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
			pattern: new RegExp(
				`(?:[Tt]he )?(?:eyes|irises) of ${name} (?:are|were) ${colors}\\b`,
				'gu'
			),
			predicate: 'eye-color',
			kind: 'character',
		},
		{
			pattern: new RegExp(`(?:[Tt]he )?hair of ${name} (?:is|was) ${colors}\\b`, 'gu'),
			predicate: 'hair-color',
			kind: 'character',
		},
		{
			pattern: new RegExp(
				`${colors} (?:is|was) the colou?r of ${name}['’]s (?:eyes|irises)\\b`,
				'gu'
			),
			predicate: 'eye-color',
			kind: 'character',
			valueFirst: true,
		},
		{
			pattern: new RegExp(`${name} (?:wore|wears) (?:her|his|their) ${colors} hair\\b`, 'gu'),
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
	const objectChecks = new Map<string, boolean>();
	let objectReferences = 0;
	for (const { pattern, predicate, kind, valueFirst, objectReference } of patterns) {
		for (const match of document.text.matchAll(pattern)) {
			if (objectReference) {
				if (++objectReferences > 256)
					throw new Error(
						'Document has more than 256 object-reference candidates; narrow the analysis scope'
					);
				if (!objectChecks.has(match[2]))
					objectChecks.set(match[2], hasNonpersonalObject(match[2]));
				if (!objectChecks.get(match[2])) continue;
			}
			const subject = match[valueFirst ? 2 : 1];
			const value = normalized(match[objectReference ? 3 : valueFirst ? 1 : 2]);
			if (/^(?:he|she|it|they|we|you|i)$/i.test(subject)) continue;
			if (candidates.length >= 256)
				throw new Error(
					'Document has more than 256 explicit continuity candidates; narrow the analysis scope'
				);
			const start = match.index;
			const quote = sourcePassage(document, start, start + match[0].length);
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
				subject,
				predicate,
				value: value === 'gray' ? 'grey' : value,
				confidence: flashback && !storyTime ? 'uncertain' : 'inferred',
				sources: [quote],
				updatedAt: new Date().toISOString(),
			};
			if (storyTime) fact.storyTime = storyTime;
			if (flashback && !storyTime) fact.storyTime = `flashback:${document.documentId}`;
			if (intentional) fact.intentional = true;
			candidates.push(fact);
		}
	}
	markUncertainCandidates(document.text, candidates);
	return candidates;
}

export class ContinuityService {
	constructor(
		private readonly source: ManuscriptSource,
		private readonly store: PersistentStore,
		private readonly bible: SeriesBible
	) {}

	async analyze(options: ContinuityOptions = {}): Promise<ContinuityReport> {
		options.signal?.throwIfAborted();
		const identity = this.sourceIdentity();
		const checkTypes = options.checkTypes ?? ['all'];
		if (
			!Array.isArray(checkTypes) ||
			checkTypes.length === 0 ||
			checkTypes.length > CHECKS.length ||
			checkTypes.some((check) => !CHECKS.includes(check))
		)
			throw new Error('Choose valid continuity check types');
		if (checkTypes.includes('plotThreads'))
			throw new Error(
				'Plot-thread continuity analysis is unavailable; choose characters, timeline, locations or all supported checks'
			);
		if (
			options.documentIds !== undefined &&
			(!Array.isArray(options.documentIds) ||
				options.documentIds.length === 0 ||
				options.documentIds.length > 5000)
		)
			throw new Error('Document scope must contain 1 to 5000 document ids');
		const documents = await this.source.list();
		options.signal?.throwIfAborted();
		if (options.expectedRevisions !== undefined) {
			const expected = options.expectedRevisions;
			if (
				!Array.isArray(expected) ||
				!expected.length ||
				expected.length > 5000 ||
				expected.some(
					(doc) =>
						!doc ||
						typeof doc.documentId !== 'string' ||
						typeof doc.revision !== 'string' ||
						!/^[a-f0-9]{64}$/.test(doc.revision)
				)
			)
				throw new Error('Invalid expected continuity revisions');
			const selected = new Set(options.documentIds ?? documents.map((doc) => doc.documentId));
			const current = new Map(documents.map((doc) => [doc.documentId, doc.revision]));
			if (
				expected.length !== selected.size ||
				new Set(expected.map((doc) => doc.documentId)).size !== expected.length ||
				expected.some(
					(doc) =>
						!selected.has(doc.documentId) ||
						current.get(doc.documentId) !== doc.revision
				)
			)
				throw new Error(
					'Saved source changed before continuity analysis; refresh and queue a new analysis'
				);
		}
		const revision = this.sourceRevision(documents);
		const prepared = await this.prepareAnalysis(options, documents);
		await this.validateForeignSources(prepared.bases, options.signal);
		const current = await this.source.list();
		return this.store.transaction(() => {
			options.signal?.throwIfAborted();
			this.assertSource(current, identity, revision);
			this.assertCanon(prepared.bases);
			return prepared.publish();
		});
	}

	private async prepareAnalysis(
		options: ContinuityOptions,
		documents: SourceDocument[]
	): Promise<PreparedContinuity> {
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
		const scopes: StoryScope[] = [
			{ kind: 'project', id: this.source.projectId },
			...(options.seriesId ? [{ kind: 'series' as const, id: options.seriesId }] : []),
		];
		const bases: CanonBasis[] = scopes.map((scope) => ({
			scope,
			revision: this.bible.scopeRevision(scope),
			states: [],
		}));
		const projectFacts = await this.bible.listFacts(scopes[0], { sourceDocuments: documents });
		options.signal?.throwIfAborted();
		const seriesFacts = options.seriesId
			? await this.bible.listFacts(
					{ kind: 'series', id: options.seriesId },
					{ sourceDocuments: documents }
				)
			: [];
		options.signal?.throwIfAborted();
		bases[0].states = projectFacts.flatMap((fact) => fact.sourceStates);
		if (bases[1]) bases[1].states = seriesFacts.flatMap((fact) => fact.sourceStates);
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
		const publish = (): ContinuityReport => {
			const findings = (() => {
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
			})();
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
					'Local analysis compares curated facts and explicit eye-color, hair-color and birth-year statements. Narrative candidates remain inferred; quoted speech, paragraphs containing uncertainty or negation cues, and untimed flashbacks remain uncertain. Singular pronouns are resolved only immediately after a supported standalone named-subject action sentence, including a simple direct object whose known WordNet noun senses exclude living entities, agents, collectives and bodily depictions; evidence includes both sentences. Unknown or ambiguous objects remain unresolved. Dictionary coverage and fictional personification limit this inference. Ambiguous, distant and cross-paragraph references are not resolved. Location, world-rule and chronology conflicts require curated facts with matching subjects and predicates. Keyword counts, character absence and plot-thread silence are not treated as contradictions. Plot-thread analysis is unavailable. Story time is not inferred from binder order.',
			};
		};
		return { bases, publish };
	}

	list(
		options: {
			includeResolved?: boolean;
			readLimits?: { maxItems: number; maxBytes: number };
		} = {}
	): ContinuityFinding[] {
		return this.store
			.list<ContinuityFinding>(FINDINGS, options.readLimits)
			.filter(
				(finding) =>
					options.includeResolved ||
					finding.status === 'open' ||
					finding.status === 'confirmed'
			)
			.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
	}

	listPage(
		options: StorePageOptions & { includeResolved?: boolean } = {}
	): StorePage<ContinuityFinding> {
		return this.store.page(
			FINDINGS,
			options,
			undefined,
			options.includeResolved ? undefined : { field: 'status', values: ['open', 'confirmed'] }
		);
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

	async recheck(id?: string, signal?: AbortSignal): Promise<ContinuityFinding[]> {
		signal?.throwIfAborted();
		if (id !== undefined) storyIdentifier(id, 'Finding id');
		const requested = id ? this.store.get<ContinuityFinding>(FINDINGS, id) : undefined;
		if (id && !requested) throw new Error('Continuity finding was not found');
		const initial = requested ? [requested] : this.list({ includeResolved: true });
		if (!initial.length) return [];
		const identity = this.sourceIdentity();
		const series = this.bible.listSeries();
		const membershipRevision = stableStoryId(JSON.stringify(series));
		const memberships = new Set(series.map((member) => member.id));
		const documents = await this.source.list();
		signal?.throwIfAborted();
		const revision = this.sourceRevision(documents);
		const prepared: PreparedContinuity[] = [];
		for (const seriesId of new Set(initial.map((finding) => finding.seriesId))) {
			if (!seriesId || memberships.has(seriesId))
				prepared.push(await this.prepareAnalysis({ seriesId, signal }, documents));
		}
		const groups = new Map<string | undefined, ContinuityFinding[]>();
		for (const finding of initial) {
			const group = groups.get(finding.seriesId) ?? [];
			group.push(finding);
			groups.set(finding.seriesId, group);
		}
		const bases = prepared.flatMap((analysis) => analysis.bases);
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
			const scope: StoryScope = seriesId
				? { kind: 'series', id: seriesId }
				: { kind: 'project', id: this.source.projectId };
			const basis: CanonBasis = {
				scope,
				revision: this.bible.scopeRevision(scope),
				states: [],
			};
			const checked = await this.bible.checkPassages(scope, passages, documents);
			signal?.throwIfAborted();
			basis.states = checked;
			bases.push(basis);
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
		await this.validateForeignSources(bases, signal);
		const current = await this.source.list();
		return this.store.transaction(() => {
			signal?.throwIfAborted();
			this.assertSource(current, identity, revision);
			this.assertCanon(bases);
			if (stableStoryId(JSON.stringify(this.bible.listSeries())) !== membershipRevision)
				throw new Error('Series membership changed during continuity recheck; retry');
			for (const analysis of prepared) analysis.publish();
			const findings = id
				? [this.store.get<ContinuityFinding>(FINDINGS, id)!]
				: this.list({ includeResolved: true });
			return findings.map((finding) => {
				if (!finding) throw new Error('Continuity finding disappeared while rechecking');
				finding.stale = states.get(finding.id) ?? finding.stale;
				finding.checkedAt = new Date().toISOString();
				this.store.put(FINDINGS, finding.id, finding);
				return finding;
			});
		});
	}

	private sourceIdentity(): string {
		return stableStoryId(this.source.projectId, this.source.projectPath);
	}

	private sourceRevision(documents: readonly SourceDocument[]): string {
		return stableStoryId(
			...documents.map((document) =>
				stableStoryId(
					document.projectId,
					document.documentId,
					document.revision,
					document.text,
					document.title,
					document.path,
					String(document.order),
					JSON.stringify(
						Object.entries(document.metadata).sort(([left], [right]) =>
							left.localeCompare(right)
						)
					)
				)
			)
		);
	}

	private async validateForeignSources(bases: CanonBasis[], signal?: AbortSignal): Promise<void> {
		await setTimeout(0);
		signal?.throwIfAborted();
		for (const basis of bases) {
			const foreign = basis.states.filter(
				(item) => item.source.projectId !== this.source.projectId
			);
			if (!foreign.length) continue;
			const current = await this.bible.checkPassages(
				basis.scope,
				foreign.map((item) => item.source)
			);
			signal?.throwIfAborted();
			if (current.some((item, index) => item.state !== foreign[index].state))
				throw new Error('Series source changed during continuity analysis; retry');
		}
	}

	private assertSource(current: SourceDocument[], identity: string, revision: string): void {
		if (
			this.sourceIdentity() !== identity ||
			current.some((document) => document.projectId !== this.source.projectId) ||
			this.sourceRevision(current) !== revision
		)
			throw new Error(
				'Saved manuscript or binder scope changed during continuity analysis; retry'
			);
	}

	private assertCanon(bases: CanonBasis[]): void {
		for (const basis of bases)
			if (this.bible.scopeRevision(basis.scope) !== basis.revision)
				throw new Error(
					'Canon facts or series membership changed during continuity analysis; retry'
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
