import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workflow = readFileSync(
	resolve(__dirname, '../../../.github/workflows/ci.yml'),
	'utf8'
).replace(/\r\n/g, '\n');
const gate = workflow.split('\n  release-gate:\n')[1];
const block = gate?.split('        run: |\n')[1];
if (!block) throw new Error('Release verification shell step was not found');
const script = block
	.split('\n')
	.filter((line) => line.startsWith('          '))
	.map((line) => line.slice(10))
	.join('\n');

const successful = {
	MATRIX_RESULT: 'success',
	SECURITY_RESULT: 'success',
	REBUILD_RESULT: 'success',
	DEPENDENCY_RESULT: 'success',
	EVENT_NAME: 'pull_request',
};

function evaluate(overrides: Partial<typeof successful> = {}) {
	const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-c', script], {
		env: { ...successful, ...overrides },
		encoding: 'utf8',
		timeout: 1000,
	});
	if (result.error) throw result.error;
	if (result.signal) throw new Error(`Release gate shell terminated: ${result.signal}`);
	if (result.status === null) throw new Error('Release gate shell returned no exit status');
	return result.status;
}

const linuxShellSuite = process.platform === 'win32' ? describe.skip : describe;
linuxShellSuite('the Ubuntu release verification shell', () => {
	test('accepts successful pull-request checks', () => {
		expect(evaluate()).toBe(0);
	});

	test.each(['push', 'workflow_dispatch', 'schedule'])(
		'accepts skipped dependency review only outside pull requests: %s',
		(EVENT_NAME) => {
			expect(evaluate({ EVENT_NAME, DEPENDENCY_RESULT: 'skipped' })).toBe(0);
			expect(evaluate({ EVENT_NAME, DEPENDENCY_RESULT: 'failure' })).not.toBe(0);
		}
	);

	test.each(['MATRIX_RESULT', 'SECURITY_RESULT', 'REBUILD_RESULT'] as const)(
		'rejects every unsuccessful required result even when later checks pass: %s',
		(key) => {
			for (const value of ['failure', 'cancelled', 'skipped', '']) {
				expect(evaluate({ [key]: value })).not.toBe(0);
			}
		}
	);

	test('requires successful dependency review for a pull request', () => {
		expect(evaluate({ DEPENDENCY_RESULT: 'skipped' })).not.toBe(0);
	});
});
