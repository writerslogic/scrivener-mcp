import { describe, it, expect } from '@jest/globals';
import {
	resolveProjectNames,
	detectOpenScrivenerProjects,
} from '../../../src/utils/scrivener-app.js';

describe('resolveProjectNames', () => {
	const paths = [
		'/Users/me/Documents/NECESSARY.scriv',
		'/Users/me/Documents/_Books/My Novel.scriv',
		'/Users/me/Desktop/Untitled.scriv',
		'/Users/me/Documents/archive/Untitled.scriv',
	];

	it('matches a window name to its .scriv path by basename', () => {
		const { resolved, unresolved } = resolveProjectNames(['NECESSARY'], paths);
		expect(unresolved).toEqual([]);
		expect(resolved).toEqual([
			{ name: 'NECESSARY', path: '/Users/me/Documents/NECESSARY.scriv' },
		]);
	});

	it('matches names that contain spaces', () => {
		const { resolved } = resolveProjectNames(['My Novel'], paths);
		expect(resolved).toEqual([
			{ name: 'My Novel', path: '/Users/me/Documents/_Books/My Novel.scriv' },
		]);
	});

	it('returns every candidate when identically named projects exist', () => {
		const { resolved, unresolved } = resolveProjectNames(['Untitled'], paths);
		expect(unresolved).toEqual([]);
		expect(resolved).toHaveLength(2);
		expect(resolved.map((r) => r.path)).toEqual([
			'/Users/me/Desktop/Untitled.scriv',
			'/Users/me/Documents/archive/Untitled.scriv',
		]);
	});

	it('reports names with no matching .scriv folder as unresolved', () => {
		const { resolved, unresolved } = resolveProjectNames(['Ghost Project'], paths);
		expect(resolved).toEqual([]);
		expect(unresolved).toEqual(['Ghost Project']);
	});

	it('handles a mix of resolved and unresolved names', () => {
		const { resolved, unresolved } = resolveProjectNames(['NECESSARY', 'Ghost'], paths);
		expect(resolved.map((r) => r.name)).toEqual(['NECESSARY']);
		expect(unresolved).toEqual(['Ghost']);
	});

	it('returns empty results for an empty name list', () => {
		expect(resolveProjectNames([], paths)).toEqual({ resolved: [], unresolved: [] });
	});
});

describe('detectOpenScrivenerProjects', () => {
	it('reports unsupported without throwing on non-macOS platforms', async () => {
		if (process.platform === 'darwin') {
			// On macOS the probe talks to the OS; only assert it resolves to a
			// well-formed result and never throws.
			const result = await detectOpenScrivenerProjects();
			expect(result.supported).toBe(true);
			expect(Array.isArray(result.names)).toBe(true);
			return;
		}
		const result = await detectOpenScrivenerProjects();
		expect(result).toEqual({
			supported: false,
			running: false,
			names: [],
			permissionDenied: false,
			timedOut: false,
		});
	});
});
