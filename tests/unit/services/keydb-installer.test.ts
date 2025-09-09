/**
 * Tests for KeyDB Auto-Installer
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { KeyDBInstaller } from '../../../src/services/auto-setup/keydb-installer';
import * as child_process from 'child_process';
import * as os from 'os';

// Mock child_process
jest.mock('child_process');
jest.mock('../../../src/services/queue/keydb-detector', () => ({
	detectConnection: jest.fn(),
}));

describe('KeyDBInstaller', () => {
	let installer: KeyDBInstaller;
	let mockExec: any;
	let detectConnectionMock: any;

	beforeEach(async () => {
		installer = await KeyDBInstaller.getInstance();
		mockExec = child_process.exec as any;
		
		// Import the mocked module
		const keydbDetector = require('../../../src/services/queue/keydb-detector');
		detectConnectionMock = keydbDetector.detectConnection;
		
		// Clear all mocks
		jest.clearAllMocks();
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	describe('getInstance', () => {
		it('should return singleton instance', async () => {
			const instance1 = await KeyDBInstaller.getInstance();
			const instance2 = await KeyDBInstaller.getInstance();
			expect(instance1).toBe(instance2);
		});
	});

	describe('checkAvailability', () => {
		it('should detect running KeyDB/Redis', async () => {
			detectConnectionMock.mockResolvedValue({
				isAvailable: true,
				type: 'keydb',
				version: '6.3.4',
				url: 'redis://localhost:6379',
			});

			const status = await installer.checkAvailability();

			expect(status).toEqual({
				installed: true,
				running: true,
				version: '6.3.4',
				port: 6379,
			});
		});

		it('should detect not running KeyDB', async () => {
			detectConnectionMock.mockResolvedValue({
				isAvailable: false,
				type: 'none',
				url: null,
			});

			// Mock 'which keydb-server' to indicate installed
			mockExec.mockImplementation((cmd: string, callback: any) => {
				if (typeof callback === 'function') {
					if (cmd === 'which keydb-server') {
						callback(null, '/usr/local/bin/keydb-server', '');
					} else if (cmd === 'keydb-server --version') {
						callback(null, 'KeyDB server v=6.3.4', '');
					} else {
						callback(new Error('Command not found'), '', '');
					}
				}
				return {} as any;
			});

			const status = await installer.checkAvailability();

			expect(status.installed).toBe(true);
			expect(status.running).toBe(false);
		});

		it('should detect not installed KeyDB', async () => {
			detectConnectionMock.mockResolvedValue({
				isAvailable: false,
				type: 'none',
				url: null,
			});

			mockExec.mockImplementation((cmd: string, callback: any) => {
				if (typeof callback === 'function') {
					callback(new Error('Command not found'), '', '');
				}
				return {} as any;
			});

			const status = await installer.checkAvailability();

			expect(status).toEqual({
				installed: false,
				running: false,
			});
		});
	});

	describe('autoInstall', () => {
		it('should skip installation if already running', async () => {
			detectConnectionMock.mockResolvedValue({
				isAvailable: true,
				type: 'redis',
				version: '6.3.4',
				url: 'redis://localhost:6379',
			});

			const result = await installer.autoInstall();

			expect(result).toEqual({
				success: true,
				message: expect.stringContaining('already running'),
				method: 'existing',
				version: '6.3.4',
			});
		});

		it('should install via Homebrew on macOS', async () => {
			// Set platform to Darwin
			Object.defineProperty(process, 'platform', {
				value: 'darwin'
			});

			detectConnectionMock.mockResolvedValue({
				isAvailable: false,
				type: 'none',
				url: null,
			});

			mockExec.mockImplementation((cmd: string, options: any, callback?: any) => {
				const cb = typeof options === 'function' ? options : callback;
				if (typeof cb === 'function') {
					if (cmd === 'which brew') {
						cb(null, '/opt/homebrew/bin/brew', '');
					} else if (cmd === 'brew update') {
						cb(null, 'Updated Homebrew', '');
					} else if (cmd === 'brew install keydb') {
						cb(null, 'Installed KeyDB', '');
					} else if (cmd.includes('keydb-server --version')) {
						cb(null, 'KeyDB server v=6.3.4', '');
					} else {
						cb(new Error('Command not found'), '', '');
					}
				}
				return {} as any;
			});

			const result = await installer.autoInstall({ method: 'homebrew' });

			expect(result.success).toBe(true);
			expect(result.method).toBe('homebrew');
			expect(result.message).toContain('Homebrew');
		});

		it('should install via Docker as fallback', async () => {
			detectConnectionMock.mockResolvedValue({
				isAvailable: false,
				type: 'none',
				url: null,
			});

			mockExec.mockImplementation((cmd: string, options: any, callback?: any) => {
				const cb = typeof options === 'function' ? options : callback;
				if (typeof cb === 'function') {
					if (cmd === 'which docker') {
						cb(null, '/usr/local/bin/docker', '');
					} else if (cmd.includes('docker run')) {
						cb(null, 'Container started', '');
					} else if (cmd === 'which brew') {
						cb(new Error('brew not found'), '', '');
					} else {
						cb(new Error('Command not found'), '', '');
					}
				}
				return {} as any;
			});

			const result = await installer.autoInstall({ method: 'docker' });

			expect(result.success).toBe(true);
			expect(result.method).toBe('docker');
		}, 10000);

		it('should handle installation failure gracefully', async () => {
			detectConnectionMock.mockResolvedValue({
				isAvailable: false,
				type: 'none',
				url: null,
			});

			mockExec.mockImplementation((cmd: string, callback: any) => {
				if (typeof callback === 'function') {
					callback(new Error('Installation failed'), '', '');
				}
				return {} as any;
			});

			const result = await installer.autoInstall();

			expect(result.success).toBe(false);
			expect(result.message).toContain('failed');
		});
	});

	describe('startKeyDB', () => {
		it('should start KeyDB successfully', async () => {
			let startAttempt = 0;
			
			mockExec.mockImplementation((cmd: string, options: any, callback?: any) => {
				const cb = typeof options === 'function' ? options : callback;
				if (typeof cb === 'function') {
					if (cmd === 'keydb-server --daemonize yes') {
						cb(null, 'Started', '');
					} else {
						cb(new Error('Command failed'), '', '');
					}
				}
				return {} as any;
			});

			// Mock checkAvailability to return running after start
			jest.spyOn(installer, 'checkAvailability').mockImplementation(async () => {
				startAttempt++;
				return {
					installed: true,
					running: startAttempt > 0,
					version: '6.3.4',
					port: 6379,
				};
			});

			const started = await installer.startKeyDB();

			expect(started).toBe(true);
		});

		it('should try multiple start methods', async () => {
			const attemptedCommands: string[] = [];

			mockExec.mockImplementation((cmd: string, options: any, callback?: any) => {
				const cb = typeof options === 'function' ? options : callback;
				attemptedCommands.push(cmd);
				
				if (typeof cb === 'function') {
					// Fail all except systemctl
					if (cmd === 'systemctl start keydb') {
						cb(null, 'Started', '');
					} else {
						cb(new Error('Command failed'), '', '');
					}
				}
				return {} as any;
			});

			jest.spyOn(installer, 'checkAvailability').mockImplementation(async () => {
				// Return running only after systemctl command
				const systemctlCalled = attemptedCommands.includes('systemctl start keydb');
				return {
					installed: true,
					running: systemctlCalled,
					version: '6.3.4',
				};
			});

			const started = await installer.startKeyDB();

			expect(started).toBe(true);
			expect(attemptedCommands).toContain('keydb-server --daemonize yes');
			expect(attemptedCommands).toContain('systemctl start keydb');
		});
	});

	describe('getManualInstructions', () => {
		it('should provide platform-specific instructions for macOS', () => {
			Object.defineProperty(process, 'platform', {
				value: 'darwin',
				configurable: true
			});
			
			const instructions = installer.getManualInstructions();
			
			expect(instructions).toContain('macOS');
			expect(instructions).toContain('Homebrew');
			expect(instructions).toContain('Docker');
		});

		it('should provide platform-specific instructions for Linux', () => {
			Object.defineProperty(process, 'platform', {
				value: 'linux',
				configurable: true
			});
			
			const instructions = installer.getManualInstructions();
			
			expect(instructions).toContain('Linux');
			expect(instructions).toContain('apt-get');
			expect(instructions).toContain('yum');
		});

		it('should provide platform-specific instructions for Windows', () => {
			Object.defineProperty(process, 'platform', {
				value: 'win32',
				configurable: true
			});
			
			const instructions = installer.getManualInstructions();
			
			expect(instructions).toContain('Windows');
			expect(instructions).toContain('Docker Desktop');
			expect(instructions).toContain('WSL2');
		});
	});
});