import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { KeyDBInstaller } from '../../../src/services/auto-setup/keydb-installer.js';
import type { ConnectionInfo } from '../../../src/services/queue/keydb-detector.js';
import type { PlatformInfo } from '../../../src/utils/env-config.js';

interface Output { stdout: string; stderr: string }
const mockCommands: string[] = [];
const mockExecAsync = jest.fn<(command: string, options?: unknown) => Promise<Output>>();
const mockDetectConnection = jest.fn<() => Promise<ConnectionInfo>>();
const mockCommandExists = jest.fn<(command: string) => Promise<boolean>>();
const mockSafeExec = jest.fn<(command: string) => Promise<Output>>();
const mockDetectPlatform = jest.fn<() => Promise<PlatformInfo>>();
const mockServiceReady = jest.fn<() => Promise<void>>();
const mockDockerReady = jest.fn<() => Promise<void>>();
const mockPermissionCommands: string[] = [];
let mockHasPermission = false;

jest.mock('child_process', () => {
	const actual = jest.requireActual<typeof import('child_process')>('child_process');
	const exec = (command: string, optionsOrCallback: unknown, callback?: (error: Error | null, stdout: string, stderr: string) => void) => {
		const done = typeof optionsOrCallback === 'function' ? optionsOrCallback as typeof callback : callback;
		mockCommands.push(command);
		void mockExecAsync(command).then((value) => done?.(null, value.stdout, value.stderr), (error: Error) => done?.(error, '', ''));
		return {};
	};
	Object.defineProperty(exec, jest.requireActual<typeof import('util')>('util').promisify.custom, { value: (command: string, options?: unknown) => { mockCommands.push(command); return mockExecAsync(command, options); } });
	return { ...actual, exec };
});
jest.mock('../../../src/services/queue/keydb-detector.js', () => ({ detectConnection: () => mockDetectConnection() }));
jest.mock('../../../src/utils/shared-patterns.js', () => ({ ProcessUtils: { commandExists: (command: string) => mockCommandExists(command), safeExec: (command: string) => mockSafeExec(command) } }));
jest.mock('../../../src/utils/env-config.js', () => ({ detectPlatform: () => mockDetectPlatform() }));
jest.mock('../../../src/utils/condition-waiter.js', () => ({ waitForServiceReady: () => mockServiceReady(), waitForDockerContainer: () => mockDockerReady() }));
jest.mock('../../../src/utils/adaptive-timeout.js', () => ({ AdaptiveTimeout: class { async wait<T>(operation: Promise<T>): Promise<T> { return operation; } }, ProgressIndicators: { outputProgress: () => ({ type: 'output' }) } }));
jest.mock('../../../src/utils/permission-manager.js', () => ({
	PermissionManager: {
		checkSystemPermissions: async () => ({ hasPermission: mockHasPermission, needsSudo: !mockHasPermission, method: 'none' }),
		getAlternatives: () => ['Use the embedded queue'],
		executeWithPermissions: async (command: string) => { mockPermissionCommands.push(command); throw new Error('Permission denied'); },
	},
	withPermissionHandling: <T extends unknown[], R>(work: (...args: T) => Promise<R>) => work,
}));
jest.mock('../../../src/core/logger.js', () => ({ getLogger: () => ({ info: () => undefined, debug: () => undefined, warn: () => undefined, error: () => undefined }) }));

let installer: KeyDBInstaller;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(async () => {
	jest.clearAllMocks();
	mockCommands.length = 0;
	mockPermissionCommands.length = 0;
	mockHasPermission = false;
	mockDetectConnection.mockResolvedValue({ isAvailable: false, type: 'none', url: null });
	mockCommandExists.mockResolvedValue(false);
	mockSafeExec.mockRejectedValue(new Error('Command unavailable'));
	mockServiceReady.mockResolvedValue(undefined);
	mockDockerReady.mockResolvedValue(undefined);
	mockExecAsync.mockImplementation(async () => { throw new Error('Command unavailable'); });
	mockDetectPlatform.mockResolvedValue({ platform: 'win32', architecture: 'x64', packageManagers: [], isContainer: false, isWsl: false, sudoRequired: true });
	installer = await KeyDBInstaller.getInstance();
});
afterEach(() => { Object.defineProperty(process, 'platform', platformDescriptor); jest.restoreAllMocks(); });

describe('KeyDB discovery and isolated installation', () => {
	it.each(['keydb', 'redis'] as const)('uses an existing running %s service without launching installation commands', async (type) => {
		mockDetectConnection.mockResolvedValue({ isAvailable: true, type, url: 'redis://localhost:6379', version: '7.2.0' });
		expect(await installer.checkAvailability()).toEqual({ installed: true, running: true, version: '7.2.0', port: 6379 });
		expect(await installer.autoInstall()).toMatchObject({ success: true, method: 'existing', version: '7.2.0' });
		expect(mockCommands).toEqual([]);
	});

	it('distinguishes an installed stopped service from an unavailable installation', async () => {
		mockCommandExists.mockResolvedValue(true);
		mockSafeExec.mockResolvedValue({ stdout: 'KeyDB server v=6.3.4 sha=fixture', stderr: '' });
		expect(await installer.checkAvailability()).toEqual({ installed: true, running: false, version: '6.3.4' });
		mockCommandExists.mockResolvedValue(false);
		expect(await installer.checkAvailability()).toEqual({ installed: false, running: false, version: undefined });
	});

	it('reports discovery failure without launching a fallback installation during the availability check', async () => {
		mockDetectConnection.mockRejectedValue(new Error('Discovery unavailable'));
		expect(await installer.checkAvailability()).toEqual({ installed: false, running: false });
		expect(mockCommands).toEqual([]);
	});

	it('handles Homebrew completion and installation failure without starting an unrequested service', async () => {
		mockExecAsync.mockResolvedValue({ stdout: 'Installed', stderr: '' });
		mockSafeExec.mockResolvedValue({ stdout: 'KeyDB server v=6.3.4', stderr: '' });
		const installed = await installer.autoInstall({ method: 'homebrew', startService: false });
		expect(installed).toMatchObject({ success: true, method: 'homebrew', version: '6.3.4' });
		expect(mockCommands).toEqual(['brew update', 'brew install keydb']);
		mockExecAsync.mockRejectedValue(new Error('Package installation rejected'));
		const failed = await installer.autoInstall({ method: 'homebrew', startService: false });
		expect(failed.success).toBe(false);
		expect(failed.message).toMatch(/Homebrew installation failed/);
	});

	it('does not report a Docker installation as successful when container readiness fails', async () => {
		mockExecAsync.mockResolvedValue({ stdout: '', stderr: '' });
		mockDockerReady.mockRejectedValue(new Error('Container never became ready'));
		const failed = await installer.autoInstall({ method: 'docker', startService: false });
		expect(failed.success).toBe(false);
		expect(failed.message).toContain('Container never became ready');
		expect(mockCommands.filter((command) => command.startsWith('docker run'))).toHaveLength(1);
	});

	it('coalesces concurrent installs and permits a later retry after failure', async () => {
		let rejectRun!: (error: Error) => void;
		let started!: () => void;
		const running = new Promise<void>((resolve) => { started = resolve; });
		mockExecAsync.mockImplementation(async (command) => {
			if (command.startsWith('docker run')) {
				started();
				return new Promise<Output>((_resolve, reject) => { rejectRun = reject; });
			}
			return { stdout: '', stderr: '' };
		});
		const first = installer.autoInstall({ method: 'docker', startService: false });
		await running;
		const second = installer.autoInstall({ method: 'docker', startService: false });
		rejectRun(new Error('Container launch failed'));
		const results = await Promise.all([first, second]);
		expect(results.every((result) => !result.success)).toBe(true);
		expect(mockCommands.filter((command) => command.startsWith('docker run'))).toHaveLength(1);
		mockExecAsync.mockResolvedValue({ stdout: '', stderr: '' });
		expect((await installer.autoInstall({ method: 'docker', startService: false })).success).toBe(true);
		expect(mockCommands.filter((command) => command.startsWith('docker run'))).toHaveLength(2);
	});

	it('keeps denied package-manager operations behind the permission boundary', async () => {
		const failed = await installer.autoInstall({ method: 'apt', startService: false });
		expect(failed.success).toBe(false);
		expect(failed.message).toMatch(/sudo privileges.*fallback also failed.*Permission denied/);
		expect(mockPermissionCommands).toEqual(['apt-get update']);
		expect(mockCommands).toEqual([]);
	});
});

describe('KeyDB service startup and installation guidance', () => {
	it('falls through missing commands and an unready service before succeeding with an available method', async () => {
		mockExecAsync.mockImplementation(async (command) => {
			if (['which redis-server', 'redis-server --daemonize yes', 'which systemctl', 'systemctl start keydb'].includes(command)) return { stdout: '', stderr: '' };
			throw new Error('Command unavailable');
		});
		mockServiceReady.mockRejectedValueOnce(new Error('Not ready')).mockResolvedValueOnce(undefined);
		expect(await installer.startKeyDB()).toBe(true);
		expect(mockCommands.filter((command) => !command.startsWith('which '))).toEqual(['redis-server --daemonize yes', 'systemctl start keydb']);
	});

	it('reports failure when no startup method is present', async () => {
		expect(await installer.startKeyDB()).toBe(false);
		expect(mockCommands.every((command) => command.startsWith('which '))).toBe(true);
	});

	it.each([['darwin', ['macOS', 'Homebrew', 'Docker']], ['linux', ['Linux', 'apt-get', 'yum']], ['win32', ['Windows', 'Docker Desktop', 'WSL2']]] as const)('keeps %s manual instructions available', (platform, expected) => {
		Object.defineProperty(process, 'platform', { configurable: true, value: platform });
		for (const text of expected) expect(installer.getManualInstructions()).toContain(text);
	});
});
