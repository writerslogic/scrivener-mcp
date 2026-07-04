/**
 * PersonalizationService tests. The directive mapping is pure; persistence and
 * insights run against an in-memory fake of DatabaseService, so no real SQLite
 * or AI provider is exercised.
 */

import { PersonalizationService } from '../../../../src/services/personalization/personalization-service.js';
import { DEFAULT_PREFERENCES } from '../../../../src/services/personalization/types.js';
import type {
	FeedbackInput,
	FeedbackRecord,
	WritingPreferences,
} from '../../../../src/services/personalization/types.js';
import type { DatabaseService } from '../../../../src/handlers/database/database-service.js';

class FakeDb {
	prefs: WritingPreferences | null = null;
	feedback: FeedbackRecord[] = [];
	private counter = 0;

	async getWritingPreferences(): Promise<WritingPreferences> {
		return this.prefs ? { ...this.prefs } : { ...DEFAULT_PREFERENCES };
	}
	async saveWritingPreferences(prefs: WritingPreferences): Promise<WritingPreferences> {
		this.prefs = { ...prefs, updatedAt: '2026-07-04T00:00:00Z' };
		return { ...this.prefs };
	}
	async recordFeedback(input: FeedbackInput): Promise<FeedbackRecord> {
		const record: FeedbackRecord = {
			id: `f${++this.counter}`,
			operation: input.operation,
			rating: input.rating,
			accepted: input.accepted,
			comment: input.comment,
			createdAt: `2026-07-04T00:00:0${this.counter}Z`,
		};
		this.feedback.push(record);
		return record;
	}
	async getFeedbackRecords(): Promise<FeedbackRecord[]> {
		return [...this.feedback].reverse();
	}
}

function svc(db: FakeDb | null): PersonalizationService {
	return new PersonalizationService(db as unknown as DatabaseService | null);
}

describe('PersonalizationService.directiveFor', () => {
	it('returns empty for the default (all-neutral, enabled) profile', () => {
		expect(PersonalizationService.directiveFor(DEFAULT_PREFERENCES)).toBe('');
	});

	it('returns empty when disabled, even with active preferences', () => {
		expect(
			PersonalizationService.directiveFor({
				...DEFAULT_PREFERENCES,
				enabled: false,
				tone: 'formal',
			})
		).toBe('');
	});

	it('composes a directive from every active dimension', () => {
		const directive = PersonalizationService.directiveFor({
			enabled: true,
			tone: 'formal',
			complexity: 'advanced',
			length: 'concise',
			pointOfView: 'third-person limited',
			styleGuides: ['Chicago', 'AP'],
			customInstructions: 'Avoid clichés.',
		});
		expect(directive).toContain('formal');
		expect(directive).toContain('advanced reader');
		expect(directive).toContain('concision');
		expect(directive).toContain('third-person limited');
		expect(directive).toContain('Chicago and AP');
		expect(directive).toContain('Avoid clichés.');
	});
});

describe('PersonalizationService.getPreferences', () => {
	it('returns defaults when no database is available', async () => {
		await expect(svc(null).getPreferences()).resolves.toEqual(DEFAULT_PREFERENCES);
	});

	it('reflects persisted preferences', async () => {
		const db = new FakeDb();
		await svc(db).setPreferences({ tone: 'casual' });
		await expect(svc(db).getPreferences()).resolves.toMatchObject({ tone: 'casual' });
	});
});

describe('PersonalizationService.setPreferences', () => {
	it('merges a partial update onto the current profile', async () => {
		const db = new FakeDb();
		const s = svc(db);
		await s.setPreferences({ tone: 'formal' });
		const saved = await s.setPreferences({ length: 'concise' });
		expect(saved.tone).toBe('formal');
		expect(saved.length).toBe('concise');
	});

	it('rejects an invalid tone', async () => {
		await expect(
			svc(new FakeDb()).setPreferences({ tone: 'sarcastic' as never })
		).rejects.toThrow(/Invalid tone/);
	});

	it('trims and drops empty style guides', async () => {
		const saved = await svc(new FakeDb()).setPreferences({
			styleGuides: [' Chicago ', '', '   '],
		});
		expect(saved.styleGuides).toEqual(['Chicago']);
	});

	it('throws when no project database is available', async () => {
		await expect(svc(null).setPreferences({ tone: 'formal' })).rejects.toThrow(
			/No project is open/
		);
	});
});

describe('PersonalizationService.recordFeedback', () => {
	it('persists a valid feedback event', async () => {
		const db = new FakeDb();
		const record = await svc(db).recordFeedback({ operation: 'enhance_content', rating: 4 });
		expect(record.operation).toBe('enhance_content');
		expect(db.feedback).toHaveLength(1);
	});

	it('rejects an out-of-range rating', async () => {
		await expect(
			svc(new FakeDb()).recordFeedback({ operation: 'enhance_content', rating: 9 })
		).rejects.toThrow(/rating must be/);
	});

	it('throws when no project database is available', async () => {
		await expect(svc(null).recordFeedback({ operation: 'x' })).rejects.toThrow(
			/No project is open/
		);
	});
});

describe('PersonalizationService.getInsights', () => {
	it('returns an empty view with no feedback', async () => {
		const insights = await svc(new FakeDb()).getInsights();
		expect(insights.totalFeedback).toBe(0);
		expect(insights.byOperation).toEqual([]);
	});

	it('aggregates ratings and acceptance per operation', async () => {
		const db = new FakeDb();
		const s = svc(db);
		await s.recordFeedback({ operation: 'enhance_content', rating: 2, accepted: false });
		await s.recordFeedback({ operation: 'enhance_content', rating: 2, accepted: false });
		await s.recordFeedback({ operation: 'enhance_content', rating: 2, accepted: true });

		const insights = await s.getInsights();
		expect(insights.totalFeedback).toBe(3);
		const op = insights.byOperation.find((o) => o.operation === 'enhance_content');
		expect(op?.count).toBe(3);
		expect(op?.averageRating).toBeCloseTo(2);
		expect(op?.acceptanceRate).toBeCloseTo(1 / 3);
	});

	it('suggests a change when satisfaction is low over enough samples', async () => {
		const db = new FakeDb();
		const s = svc(db);
		for (let i = 0; i < 3; i++) {
			await s.recordFeedback({ operation: 'enhance_content', rating: 1 });
		}
		const insights = await s.getInsights();
		expect(insights.suggestions.some((t) => t.includes('enhance_content'))).toBe(true);
	});
});
