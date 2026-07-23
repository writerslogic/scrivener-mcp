/**
 * Verifies progressive tool disclosure and, in particular, that a tool call for
 * a not-yet-active skill auto-activates that skill (rather than dead-ending on
 * "unknown tool"), while hidden and genuinely-unknown tools stay non-dispatchable.
 */

import {
	initializeSkillRegistry,
	activateSkillForTool,
	isSkillActive,
	getRegisteredTools,
} from '../../../src/handlers/skill-registry.js';

function toolNames(): string[] {
	return getRegisteredTools().map((t) => t.name);
}

describe('skill-registry auto-activation', () => {
	beforeAll(() => {
		delete process.env.SCRIVENER_MCP_EAGER_TOOLS;
		initializeSkillRegistry();
	});

	it('starts with only the project skill active (progressive disclosure)', () => {
		expect(isSkillActive('project')).toBe(true);
		expect(isSkillActive('analysis')).toBe(false);
		expect(toolNames()).not.toContain('analyze_document');
	});

	it('activates a tool’s skill on first call and makes it dispatchable', () => {
		expect(activateSkillForTool('analyze_document')).toBe(true);
		expect(isSkillActive('analysis')).toBe(true);
		expect(toolNames()).toContain('analyze_document');
	});

	it('is idempotent once the skill is active', () => {
		expect(activateSkillForTool('analyze_document')).toBe(false);
	});

	it('does not activate for a hidden tool', () => {
		expect(activateSkillForTool('find_analogies')).toBe(false);
		expect(toolNames()).not.toContain('find_analogies');
	});

	it('does not activate for a genuinely unknown tool', () => {
		expect(activateSkillForTool('no_such_tool')).toBe(false);
	});

	it('returns false for an already-registered meta-tool', () => {
		expect(activateSkillForTool('list_skills')).toBe(false);
	});
});
