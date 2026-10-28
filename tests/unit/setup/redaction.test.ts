import { homedir } from 'node:os';
import { redactDiagnostics } from '../../../src/setup/redaction.js';

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
