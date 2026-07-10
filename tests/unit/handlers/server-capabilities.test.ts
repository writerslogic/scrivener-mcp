import { describe, it, expect } from '@jest/globals';
import { SERVER_CAPABILITIES } from '../../../src/handlers/server-capabilities.js';

/**
 * Regression guard for the progressive tool-disclosure failure: after a skill
 * activates (e.g. documents on open_project), its tools are registered
 * server-side but only surface in the client if the server advertised
 * tools.listChanged. Without it, create_document returns "No such tool
 * available" no matter how often the skill is re-activated.
 */
describe('server capabilities', () => {
	it('advertises tools.listChanged so clients refresh after a skill activates', () => {
		expect(SERVER_CAPABILITIES.tools.listChanged).toBe(true);
	});
});
