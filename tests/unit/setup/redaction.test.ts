import { homedir } from 'node:os';
import { redactDiagnostics } from '../../../src/setup/redaction.js';
import { getLogger, LogLevel } from '../../../src/core/logger.js';

it('redacts credentials and manuscript fields while retaining actionable diagnostic checks', () => {
	const secret = 'sk-ant-private-fixture-value';
	const result = JSON.stringify(
		redactDiagnostics({
			ok: false,
			command: `${homedir()}/node`,
			apiKey: secret,
			nested: {
				content: 'private manuscript passage',
				error: `Failed at https://user:pass@example.test; ${secret}`,
			},
			checks: { manuscriptUnchanged: true },
		})
	);
	expect(result).not.toContain(secret);
	expect(result).not.toContain('private manuscript passage');
	expect(result).not.toContain('user:pass');
	expect(result).not.toContain(homedir());
	expect(JSON.parse(result).checks.manuscriptUnchanged).toBe(true);
});

it('redacts authorization and non-HTTP connection credentials without hiding the host', () => {
	const result = redactDiagnostics({
		authorization: 'opaque-header-value',
		cookie: 'session=opaque-cookie-value',
		error: 'Connect redis://author:private-pass@localhost:6379 failed; Bearer opaque-token; Basic cHJpdmF0ZTpwYXNz',
	}) as { authorization: string; cookie: string; error: string };
	for (const secret of [
		'opaque-header-value',
		'opaque-cookie-value',
		'private-pass',
		'opaque-token',
		'cHJpdmF0ZTpwYXNz',
	])
		expect(JSON.stringify(result)).not.toContain(secret);
	expect(result.error).toContain('redis://[redacted]@localhost:6379');
	expect(redactDiagnostics(result)).toEqual(result);
});

it('uses the same credential protection in real logger output and nested errors', () => {
	const output: string[] = [];
	const write = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
		output.push(String(chunk));
		return true;
	});
	try {
		const logger = getLogger('credential-boundary-test');
		logger.setLevel(LogLevel.ERROR);
		logger.error('Cannot authenticate Basic Zml4dHVyZTpwYXNz', {
			endpoint: 'redis://writer:fixture-password@localhost:6379',
			error: new Error('Bearer fixture-opaque-token'),
		});
		const text = output.join('');
		for (const secret of ['Zml4dHVyZTpwYXNz', 'fixture-password', 'fixture-opaque-token'])
			expect(text).not.toContain(secret);
		expect(text).toContain('localhost:6379');
		expect(text).toContain('[redacted]');
	} finally {
		write.mockRestore();
	}
});
