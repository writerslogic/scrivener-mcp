/**
 * Goal handler tests. The progress math and input validation are pure/deterministic
 * here — the database is mocked, so sqlite itself is never exercised.
 */

import {
	computeGoalProgress,
	getWritingGoalsHandler,
	setWritingGoalHandler,
	type GoalProgress,
} from '../../../src/handlers/goals-handlers.js';
import type { WritingGoalRecord } from '../../../src/handlers/database/database-service.js';
import type { HandlerContext } from '../../../src/handlers/types.js';

function goal(overrides: Partial<WritingGoalRecord> = {}): WritingGoalRecord {
	return {
		id: 'g1',
		type: 'project',
		targetWords: 1000,
		targetDate: null,
		actualWords: 0,
		status: 'active',
		createdAt: '2026-01-01T00:00:00.000Z',
		completedAt: null,
		...overrides,
	};
}

function ctx(overrides: Partial<HandlerContext> = {}): HandlerContext {
	return overrides as HandlerContext;
}

describe('computeGoalProgress', () => {
	it('measures a project goal against the live project word count', () => {
		const p = computeGoalProgress(goal({ type: 'project', targetWords: 1000 }), 500);
		expect(p.achievedWords).toBe(500);
		expect(p.progressPercent).toBe(50);
		expect(p.wordsRemaining).toBe(500);
	});

	it('measures daily/weekly goals against the goal actualWords, ignoring project total', () => {
		const p = computeGoalProgress(
			goal({ type: 'daily', targetWords: 200, actualWords: 50 }),
			99999
		);
		expect(p.achievedWords).toBe(50);
		expect(p.progressPercent).toBe(25);
		expect(p.wordsRemaining).toBe(150);
	});

	it('clamps progress to 100 and floors words remaining at 0 when over target', () => {
		const p = computeGoalProgress(goal({ type: 'project', targetWords: 1000 }), 1500);
		expect(p.progressPercent).toBe(100);
		expect(p.wordsRemaining).toBe(0);
		expect(p.onTrack).toBe(true);
	});

	it('returns 0% and not on track for a zero target', () => {
		const p = computeGoalProgress(goal({ targetWords: 0 }), 0);
		expect(p.progressPercent).toBe(0);
		expect(p.onTrack).toBe(false);
	});

	it('treats an open-ended unmet goal as not on track', () => {
		const p = computeGoalProgress(goal({ targetWords: 1000, targetDate: null }), 100);
		expect(p.onTrack).toBe(false);
	});

	it('is on track when achieved words meet the elapsed share of the target', () => {
		const g = goal({
			type: 'project',
			targetWords: 1000,
			createdAt: '2026-01-01T00:00:00.000Z',
			targetDate: '2026-01-11T00:00:00.000Z',
		});
		// Halfway through the window: 500 words is exactly on pace.
		const now = Date.parse('2026-01-06T00:00:00.000Z');
		expect(computeGoalProgress(g, 500, now).onTrack).toBe(true);
		expect(computeGoalProgress(g, 400, now).onTrack).toBe(false);
	});
});

describe('set_writing_goal', () => {
	it('degrades with an actionable error when the database is unavailable', async () => {
		const result = await setWritingGoalHandler.handler(
			{ type: 'daily', targetWords: 500 },
			ctx()
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/project database/i);
	});

	it('rejects an unknown goal type', async () => {
		const databaseService = { setWritingGoal: jest.fn() };
		await expect(
			setWritingGoalHandler.handler(
				{ type: 'monthly', targetWords: 500 },
				ctx({ databaseService: databaseService as never })
			)
		).rejects.toThrow(/goal type/i);
		expect(databaseService.setWritingGoal).not.toHaveBeenCalled();
	});

	it('rejects a non-positive or fractional target', async () => {
		const databaseService = { setWritingGoal: jest.fn() };
		const context = ctx({ databaseService: databaseService as never });
		await expect(
			setWritingGoalHandler.handler({ type: 'daily', targetWords: 0 }, context)
		).rejects.toThrow(/positive whole number/i);
		await expect(
			setWritingGoalHandler.handler({ type: 'daily', targetWords: 12.5 }, context)
		).rejects.toThrow(/positive whole number/i);
	});

	it('rejects an unparseable target date', async () => {
		const databaseService = { setWritingGoal: jest.fn() };
		await expect(
			setWritingGoalHandler.handler(
				{ type: 'project', targetWords: 80000, targetDate: 'someday' },
				ctx({ databaseService: databaseService as never })
			)
		).rejects.toThrow(/ISO date/i);
	});

	it('persists a valid goal and returns the stored record', async () => {
		const saved = goal({ type: 'project', targetWords: 80000, targetDate: '2026-12-31' });
		const setWritingGoal = jest.fn().mockResolvedValue(saved);
		const result = await setWritingGoalHandler.handler(
			{ type: 'project', targetWords: 80000, targetDate: '2026-12-31' },
			ctx({ databaseService: { setWritingGoal } as never })
		);
		expect(setWritingGoal).toHaveBeenCalledWith({
			type: 'project',
			targetWords: 80000,
			targetDate: '2026-12-31',
		});
		expect(result.isError).toBeUndefined();
		expect(result.content[0].text).toContain('Goal saved');
		expect(result.content[0].text).toContain('80000');
	});
});

describe('get_writing_goals', () => {
	it('degrades with an actionable error when the database is unavailable', async () => {
		const result = await getWritingGoalsHandler.handler({}, ctx());
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/project database/i);
	});

	it('lists goals with computed progress against the current project word count', async () => {
		const getWritingGoals = jest
			.fn()
			.mockResolvedValue([goal({ type: 'project', targetWords: 1000 })]);
		const project = { getTotalWordCount: jest.fn().mockResolvedValue(250) };
		const result = await getWritingGoalsHandler.handler(
			{},
			ctx({
				databaseService: { getWritingGoals } as never,
				project: project as never,
			})
		);
		expect(getWritingGoals).toHaveBeenCalledWith(undefined);
		const json = result.content[0].text!.split('\n')[1];
		const parsed = JSON.parse(json) as GoalProgress[];
		expect(parsed).toHaveLength(1);
		expect(parsed[0].achievedWords).toBe(250);
		expect(parsed[0].progressPercent).toBe(25);
		expect(parsed[0].wordsRemaining).toBe(750);
	});

	it('passes a status filter through to the database', async () => {
		const getWritingGoals = jest.fn().mockResolvedValue([]);
		const project = { getTotalWordCount: jest.fn().mockResolvedValue(0) };
		await getWritingGoalsHandler.handler(
			{ status: 'active' },
			ctx({
				databaseService: { getWritingGoals } as never,
				project: project as never,
			})
		);
		expect(getWritingGoals).toHaveBeenCalledWith('active');
	});
});
