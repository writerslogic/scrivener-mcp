/**
 * Locks the Error-serialization fix: logging `{ error }` used to emit
 * `{"error":{}}` because Error.message/stack are non-enumerable, hiding the
 * failure. The logger now surfaces name/message/stack (and any cause chain).
 */

import { getLogger } from '../../../src/core/logger.js';

describe('logger error serialization', () => {
	let writes: string[];
	let spy: jest.SpyInstance;

	beforeEach(() => {
		writes = [];
		spy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		});
	});

	afterEach(() => {
		spy.mockRestore();
	});

	it('serializes an Error message and stack, not an empty object', () => {
		getLogger('test-logger').error('operation failed', {
			error: new Error('the real reason'),
		});
		const out = writes.join('');
		expect(out).toContain('the real reason');
		expect(out).toContain('stack');
		expect(out).not.toContain('"error":{}');
	});

	it('preserves the cause chain of a wrapped error', () => {
		const cause = new Error('root cause');
		getLogger('test-logger').error('wrapper failed', {
			error: new Error('outer', { cause }),
		});
		const out = writes.join('');
		expect(out).toContain('outer');
		expect(out).toContain('root cause');
	});

	it('leaves non-error context untouched', () => {
		getLogger('test-logger').error('plain', { documentId: 'abc', count: 3 });
		const out = writes.join('');
		expect(out).toContain('abc');
		expect(out).toContain('3');
	});

	it('redacts manuscript payload fields and credentials without losing operational context', () => {
		getLogger('test-private-logger').error(
			'operation failed for sk-ant-private-fixture-token',
			{
				documentId: 'safe-identity',
				content: 'A private manuscript passage',
				prompt: 'Private provider prompt',
				query: 'A private passage query',
				apiKey: 'sk-ant-secret-fixture-token',
				error: new Error(
					'Authorization Bearer private-token-fixture at https://user:password@example.test'
				),
			}
		);
		const out = writes.join('');
		for (const value of [
			'A private manuscript passage',
			'Private provider prompt',
			'A private passage query',
			'sk-ant-private-fixture-token',
			'sk-ant-secret-fixture-token',
			'private-token-fixture',
			'user:password',
		])
			expect(out).not.toContain(value);
		expect(out).toContain('safe-identity');
		expect(out).toContain('[redacted]');
	});
});
