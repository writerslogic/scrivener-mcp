import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSetup } from '../../../../src/handlers/database/database-setup.js';
import { Neo4jAutoInstaller } from '../../../../src/handlers/database/auto-installer.js';

const mockExecFile = jest.fn();
const mockVerify = jest.fn();
const mockClose = jest.fn();
jest.mock('child_process', () => {
	const actual = jest.requireActual('child_process');
	const custom = jest.requireActual('util').promisify.custom;
	const exec = () => {
		throw new Error('Unexpected callback command');
	};
	const execFile = () => {
		throw new Error('Unexpected callback executable');
	};
	Object.defineProperty(exec, custom, { value: async () => ({ stdout: '', stderr: '' }) });
	Object.defineProperty(execFile, custom, {
		value: (...args: unknown[]) => mockExecFile(...args),
	});
	return {
		...actual,
		exec,
		execFile,
		spawn: () => {
			throw new Error('Unexpected process launch');
		},
	};
});
jest.mock('../../../../src/utils/condition-waiter.js', () => ({
	waitForServiceReady: async () => ({ success: true }),
}));
jest.mock('neo4j-driver', () => ({
	__esModule: true,
	default: {
		driver: () => ({ verifyConnectivity: mockVerify, close: mockClose }),
		auth: { basic: () => ({}) },
	},
}));

let root: string;
let previous: Record<string, string | undefined>;
beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), 'scrivener-neo4j-setup-')));
	previous = Object.fromEntries(
		['NEO4J_URI', 'NEO4J_USER', 'NEO4J_PASSWORD', 'NEO4J_DATABASE'].map((key) => [
			key,
			process.env[key],
		])
	);
	for (const key of Object.keys(previous)) delete process.env[key];
	mockExecFile.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
	mockVerify.mockReset().mockResolvedValue(undefined);
	mockClose.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
	for (const [key, value] of Object.entries(previous))
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	await rm(root, { recursive: true, force: true });
});

it('launches both setup routes on loopback with unique privately persisted credentials', async () => {
	const passwords: string[] = [];
	for (const direct of [false, true]) {
		const project = await mkdtemp(join(root, 'project-'));
		await writeFile(join(project, '.env'), 'UNRELATED=preserved\n');
		const success = direct
			? (
					await Neo4jAutoInstaller.install({
						method: 'docker',
						interactive: false,
						autoStart: true,
						projectPath: project,
					})
				).success
			: await DatabaseSetup.setupNeo4jWithDocker({ projectPath: project });
		expect(success).toBe(true);
		const stored = await DatabaseSetup.getCredentials({ projectPath: project });
		passwords.push(stored.neo4j.password);
		expect(stored.neo4j.password.length).toBeGreaterThanOrEqual(43);
		const launch = mockExecFile.mock.calls
			.filter(([, args]) => args[0] === 'run')
			.slice(-1)[0]!;
		expect(launch[1]).toEqual(
			expect.arrayContaining(['127.0.0.1:7474:7474', '127.0.0.1:7687:7687', 'NEO4J_AUTH'])
		);
		expect(JSON.stringify(launch[1]).includes(stored.neo4j.password)).toBe(false);
		expect(launch[2].env.NEO4J_AUTH === `neo4j/${stored.neo4j.password}`).toBe(true);
		expect(await readFile(join(project, '.env'), 'utf8')).toBe('UNRELATED=preserved\n');
		if (process.platform !== 'win32') {
			expect((await stat(join(project, '.scrivener-databases'))).mode & 0o777).toBe(0o700);
			expect(
				(await stat(join(project, '.scrivener-databases', 'credentials.json'))).mode & 0o777
			).toBe(0o600);
		}
	}
	expect(new Set(passwords).size).toBe(2);
});

it('allows a public bind only when explicitly selected and rejects non-IP bind values', async () => {
	expect(
		await DatabaseSetup.setupNeo4jWithDocker({ projectPath: root, bindAddress: '0.0.0.0' })
	).toBe(true);
	const launch = mockExecFile.mock.calls.find(([, args]) => args[0] === 'run')!;
	expect(launch[1]).toContain('0.0.0.0:7687:7687');
	mockExecFile.mockClear();
	expect(
		await DatabaseSetup.setupNeo4jWithDocker({
			projectPath: root,
			bindAddress: 'localhost; unsafe',
		})
	).toBe(false);
	expect(mockExecFile).not.toHaveBeenCalled();
});

it('preserves an existing container and retains credentials for recovery after authentication failure', async () => {
	mockExecFile.mockResolvedValueOnce({ stdout: 'existing-container', stderr: '' });
	expect(await DatabaseSetup.setupNeo4jWithDocker({ projectPath: root })).toBe(false);
	expect(
		mockExecFile.mock.calls.some(([, args]) => args.includes('rm') || args[0] === 'run')
	).toBe(false);
	mockVerify.mockRejectedValueOnce(new Error('Fixture authentication failure'));
	expect(await DatabaseSetup.setupNeo4jWithDocker({ projectPath: root })).toBe(false);
	expect(
		(await DatabaseSetup.getCredentials({ projectPath: root })).neo4j.password.length
	).toBeGreaterThanOrEqual(43);
	expect(mockClose).toHaveBeenCalledTimes(1);
});

it('refuses linked credential directories before pulling or launching a container', async () => {
	const outside = await mkdtemp(join(root, 'outside-'));
	await symlink(outside, join(root, '.scrivener-databases'), 'dir');
	expect(await DatabaseSetup.setupNeo4jWithDocker({ projectPath: root })).toBe(false);
	expect(
		mockExecFile.mock.calls.some(([, args]) => args[0] === 'pull' || args[0] === 'run')
	).toBe(false);
});
