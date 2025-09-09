/**
 * KeyDB Auto-Installer
 * Automatically detects and installs KeyDB based on the operating system
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import { getLogger } from '../../core/logger.js';
import { detectConnection } from '../queue/keydb-detector.js';
import { AppError, ErrorCode, handleError, withErrorHandling, retry } from '../../utils/common.js';
import { detectPlatform, type PlatformInfo } from '../../utils/env-config.js';
import { PermissionManager, withPermissionHandling } from '../../utils/permission-manager.js';
import { AdaptiveTimeout, ProgressIndicators } from '../../utils/adaptive-timeout.js';
import { waitForServiceReady, waitForDockerContainer } from '../../utils/condition-waiter.js';

const execAsync = promisify(exec);
const logger = getLogger('keydb-installer');

export interface InstallationResult {
	success: boolean;
	message: string;
	method?: 'homebrew' | 'docker' | 'apt' | 'yum' | 'manual' | 'existing';
	version?: string;
	port?: number;
}

export class KeyDBInstaller {
	private static instance: KeyDBInstaller | null = null;
	private static instancePromise: Promise<KeyDBInstaller> | null = null;
	private installationPromise: Promise<InstallationResult> | null = null;
	private platformInfo: PlatformInfo | null = null;

	public static async getInstance(): Promise<KeyDBInstaller> {
		if (KeyDBInstaller.instance) {
			return KeyDBInstaller.instance;
		}

		if (KeyDBInstaller.instancePromise) {
			return KeyDBInstaller.instancePromise;
		}

		KeyDBInstaller.instancePromise = (async () => {
			try {
				KeyDBInstaller.instance = new KeyDBInstaller();
				return KeyDBInstaller.instance;
			} catch (error) {
				// Reset promise on error so next call can retry
				KeyDBInstaller.instancePromise = null;
				throw error;
			}
		})();

		return KeyDBInstaller.instancePromise;
	}

	/**
	 * Check if KeyDB is already available
	 */
	async checkAvailability(): Promise<{
		installed: boolean;
		running: boolean;
		version?: string;
		port?: number;
	}> {
		try {
			// Check if KeyDB/Redis is running
			const connectionInfo = await detectConnection();

			if (connectionInfo.isAvailable) {
				logger.info('KeyDB/Redis detected and running', {
					type: connectionInfo.type,
					version: connectionInfo.version,
				});

				return {
					installed: true,
					running: true,
					version: connectionInfo.version,
					port: 6379,
				};
			}

			// Check if KeyDB is installed but not running
			const installed = await this.isKeyDBInstalled();

			return {
				installed,
				running: false,
				version: installed ? await this.getInstalledVersion() : undefined,
			};
		} catch (error) {
			logger.debug('KeyDB availability check failed', { error });
			return { installed: false, running: false };
		}
	}

	/**
	 * Auto-install KeyDB based on the operating system
	 */
	async autoInstall(
		options: {
			method?: 'auto' | 'homebrew' | 'docker' | 'apt' | 'yum';
			startService?: boolean;
		} = {}
	): Promise<InstallationResult> {
		// Use promise-based locking to prevent race conditions
		if (this.installationPromise) {
			logger.debug('Installation already in progress, waiting for completion');
			return this.installationPromise;
		}

		this.installationPromise = this._performInstallation(options);

		try {
			const result = await this.installationPromise;
			return result;
		} finally {
			this.installationPromise = null;
		}
	}

	private async _performInstallation(options: {
		method?: 'auto' | 'homebrew' | 'docker' | 'apt' | 'yum';
		startService?: boolean;
	}): Promise<InstallationResult> {
		try {
			// Check if already available
			const status = await this.checkAvailability();
			if (status.running) {
				return {
					success: true,
					message: `KeyDB/Redis is already running (version ${status.version})`,
					method: 'existing',
					version: status.version,
				};
			}

			if (status.installed && options.startService !== false) {
				// Try to start existing installation
				const started = await this.startKeyDB();
				if (started) {
					return {
						success: true,
						message: 'Started existing KeyDB installation',
						method: 'existing',
						version: status.version,
					};
				}
			}

			// Determine installation method
			const method =
				options.method === 'auto'
					? await this.detectBestInstallMethod()
					: options.method || (await this.detectBestInstallMethod());

			logger.info(`Installing KeyDB using method: ${method}`);

			let result: InstallationResult;

			switch (method) {
				case 'homebrew':
					result = await this.installViaHomebrew();
					break;
				case 'docker':
					result = await this.installViaDocker();
					break;
				case 'apt':
					result = await this.installViaApt();
					break;
				case 'yum':
					result = await this.installViaYum();
					break;
				default:
					result = {
						success: false,
						message: `Unsupported installation method: ${method}`,
					};
			}

			// Start service if installation was successful
			if (result.success && options.startService !== false) {
				const started = await this.startKeyDB();
				if (!started) {
					result.message += ' (Warning: Failed to start service automatically)';
				}
			}

			return result;
		} catch (error) {
			const appError = handleError(error, 'KeyDB installation');
			logger.error('KeyDB installation failed', { error: appError });
			return {
				success: false,
				message: `Installation failed: ${appError.message}`,
			};
		}
	}

	/**
	 * Start KeyDB service with retry logic
	 */
	async startKeyDB(): Promise<boolean> {
		return withErrorHandling(async () => {
			// Try different methods to start KeyDB
			const methods = [
				'keydb-server --daemonize yes',
				'redis-server --daemonize yes',
				'brew services start keydb',
				'systemctl start keydb',
				'service keydb start',
			];

			for (const cmd of methods) {
				try {
					// Use retry for each start command
					await retry(() => execAsync(cmd, { timeout: 10000 }), {
						maxAttempts: 2,
						initialDelay: 1000,
					});

					// Wait and test connection with intelligent monitoring
					// Wait for service to actually be ready instead of fixed delay
					await waitForServiceReady('localhost', 6379, 15000);

					logger.info(`KeyDB started successfully using: ${cmd}`);
					return true;
				} catch (error) {
					logger.debug(`Start method failed: ${cmd}`, { error });
					// Try next method
					continue;
				}
			}

			return false;
		}, 'KeyDB start')();
	}

	/**
	 * Detect the best installation method for the current system
	 */
	private async detectBestInstallMethod(): Promise<string> {
		if (!this.platformInfo) {
			this.platformInfo = await detectPlatform();
		}

		const { platform, isContainer, packageManagers, sudoRequired } = this.platformInfo;

		// In containers, prefer pre-installed Redis or Docker
		if (isContainer) {
			if (packageManagers.includes('docker')) {
				return 'docker';
			}
			// In containers, we might not have package managers available
			logger.warn('Running in container without Docker access');
		}

		switch (platform) {
			case 'darwin': // macOS
				if (packageManagers.includes('brew')) {
					return 'homebrew';
				}
				if (packageManagers.includes('docker')) {
					return 'docker';
				}
				throw new AppError(
					'Neither Homebrew nor Docker found on macOS',
					ErrorCode.DEPENDENCY_ERROR,
					{ availableManagers: packageManagers }
				);

			case 'linux':
				// Prefer package managers that don't require sudo if possible
				if (!sudoRequired && packageManagers.includes('docker')) {
					return 'docker';
				}
				if (packageManagers.includes('apt-get')) {
					return 'apt';
				}
				if (packageManagers.includes('yum') || packageManagers.includes('dnf')) {
					return packageManagers.includes('dnf') ? 'dnf' : 'yum';
				}
				if (packageManagers.includes('docker')) {
					return 'docker';
				}
				throw new AppError(
					'No supported package manager found on Linux',
					ErrorCode.DEPENDENCY_ERROR,
					{ availableManagers: packageManagers, sudoRequired }
				);

			case 'win32': // Windows
				if (packageManagers.includes('docker')) {
					return 'docker';
				}
				throw new AppError(
					'Docker is required for Windows installation',
					ErrorCode.DEPENDENCY_ERROR,
					{ availableManagers: packageManagers }
				);

			default:
				throw new AppError(
					`Unsupported platform: ${platform}`,
					ErrorCode.UNSUPPORTED_OPERATION,
					{ platform, architecture: this.platformInfo.architecture }
				);
		}
	}

	/**
	 * Install KeyDB via Homebrew (macOS)
	 */
	private async installViaHomebrew(): Promise<InstallationResult> {
		try {
			logger.info('Installing KeyDB via Homebrew...');

			// Update Homebrew first with adaptive timeout
			await this.executeWithAdaptiveTimeout(
				'brew update',
				'Homebrew update',
				30000, // base timeout
				120000 // max timeout
			);

			// Install KeyDB with progress monitoring
			const lastOutput = { value: '' };
			const installProcess = this.executeWithProgressCapture(
				'brew install keydb',
				lastOutput
			);

			const timeout = new AdaptiveTimeout({
				operation: 'KeyDB installation via Homebrew',
				baseTimeout: 120000, // 2 minutes base
				maxTimeout: 600000, // 10 minutes max
				stallTimeout: 60000, // 1 minute without progress
				progressIndicators: [
					ProgressIndicators.outputProgress(lastOutput),
					// Check if KeyDB binary appears
					{
						type: 'completion_check',
						description: 'KeyDB binary availability',
						check: async () => {
							try {
								await execAsync('which keydb-server', { timeout: 2000 });
								return true;
							} catch {
								return false;
							}
						},
					},
				],
				onProgress: (progress) => {
					logger.debug('Homebrew installation progress', progress);
				},
			});

			await timeout.wait(installProcess);

			// Get version
			const version = await this.getInstalledVersion();

			return {
				success: true,
				message: 'KeyDB installed successfully via Homebrew',
				method: 'homebrew',
				version,
			};
		} catch (error) {
			return {
				success: false,
				message: `Homebrew installation failed: ${(error as Error).message}`,
			};
		}
	}

	/**
	 * Install KeyDB via Docker
	 */
	private async installViaDocker(): Promise<InstallationResult> {
		try {
			logger.info('Setting up KeyDB via Docker...');

			// Check if container already exists
			try {
				const { stdout } = await execAsync(
					'docker ps -a --filter name=scrivener-keydb --format "{{.Names}}"'
				);
				if (stdout.trim()) {
					// Container exists, try to start it
					await execAsync('docker start scrivener-keydb');
					return {
						success: true,
						message: 'Existing KeyDB Docker container started',
						method: 'docker',
					};
				}
			} catch (error) {
				// Container doesn't exist, continue with creation
			}

			// Create and start new KeyDB container
			const dockerCmd = [
				'docker run -d',
				'--name scrivener-keydb',
				'-p 6379:6379',
				'--restart unless-stopped',
				'eqalpha/keydb:latest',
			].join(' ');

			await execAsync(dockerCmd, { timeout: 120000 });

			// Wait for container to actually be healthy instead of fixed delay
			await waitForDockerContainer('scrivener-keydb', 30000);

			return {
				success: true,
				message: 'KeyDB Docker container created and started',
				method: 'docker',
				port: 6379,
			};
		} catch (error) {
			return {
				success: false,
				message: `Docker installation failed: ${(error as Error).message}`,
			};
		}
	}

	/**
	 * Install KeyDB via APT (Debian/Ubuntu)
	 */
	private async installViaApt(): Promise<InstallationResult> {
		const installWithPermissions = withPermissionHandling(
			this._performAptInstallation.bind(this),
			'KeyDB APT installation'
		);

		return installWithPermissions();
	}

	private async _performAptInstallation(): Promise<InstallationResult> {
		try {
			logger.info('Installing KeyDB via APT...');

			// Check permissions first
			const permissions = await PermissionManager.checkSystemPermissions();
			if (!permissions.hasPermission && permissions.needsSudo) {
				throw new AppError(
					'APT installation requires sudo privileges',
					ErrorCode.PERMISSION_DENIED,
					{
						alternatives: PermissionManager.getAlternatives(
							'KeyDB installation',
							this.platformInfo
						),
						suggestion: 'Use Docker installation instead',
					}
				);
			}

			// Try KeyDB installation with permission-aware commands
			await PermissionManager.executeWithPermissions(
				'curl -s https://download.keydb.dev/keydb-latest-ubuntu.tar.gz | tar -xzf - -C /tmp',
				{ operation: 'Download KeyDB package' }
			);

			await PermissionManager.executeWithPermissions('dpkg -i /tmp/keydb-*_amd64.deb', {
				operation: 'Install KeyDB package',
			});

			await PermissionManager.executeWithPermissions('apt-get update', {
				operation: 'Update package list',
			});

			await PermissionManager.executeWithPermissions('apt-get install -f -y', {
				operation: 'Fix package dependencies',
			});

			const version = await this.getInstalledVersion();

			return {
				success: true,
				message: 'KeyDB installed successfully via APT',
				method: 'apt',
				version,
			};
		} catch (error) {
			// Fallback to Redis if KeyDB fails
			logger.warn('KeyDB installation failed, trying Redis fallback', {
				error: (error as Error).message,
			});

			try {
				await PermissionManager.executeWithPermissions('apt-get update', {
					operation: 'Update package list for Redis',
				});

				await PermissionManager.executeWithPermissions('apt-get install -y redis-server', {
					operation: 'Install Redis server',
				});

				return {
					success: true,
					message: 'Redis installed successfully as KeyDB alternative',
					method: 'apt',
					version: await this.getInstalledVersion(),
				};
			} catch (fallbackError) {
				logger.error('Both KeyDB and Redis installation failed', {
					keydbError: (error as Error).message,
					redisError: (fallbackError as Error).message,
				});

				return {
					success: false,
					message: `APT installation failed: ${(error as Error).message}. Redis fallback also failed: ${(fallbackError as Error).message}`,
				};
			}
		}
	}

	/**
	 * Install KeyDB via YUM (RHEL/CentOS/Fedora)
	 */
	private async installViaYum(): Promise<InstallationResult> {
		const installWithPermissions = withPermissionHandling(
			this._performYumInstallation.bind(this),
			'KeyDB YUM installation'
		);

		return installWithPermissions();
	}

	private async _performYumInstallation(): Promise<InstallationResult> {
		try {
			logger.info('Installing Redis via YUM (KeyDB packages not available)...');

			// Check permissions first
			const permissions = await PermissionManager.checkSystemPermissions();
			if (!permissions.hasPermission && permissions.needsSudo) {
				throw new AppError(
					'YUM installation requires sudo privileges',
					ErrorCode.PERMISSION_DENIED,
					{
						alternatives: PermissionManager.getAlternatives(
							'Redis installation',
							this.platformInfo
						),
						suggestion: 'Use Docker installation instead',
					}
				);
			}

			// Install EPEL repository first
			await PermissionManager.executeWithPermissions('yum install -y epel-release', {
				operation: 'Install EPEL repository',
			});

			// Try to install Redis (KeyDB packages might not be available)
			await PermissionManager.executeWithPermissions('yum install -y redis', {
				operation: 'Install Redis server',
			});

			await PermissionManager.executeWithPermissions('systemctl enable redis', {
				operation: 'Enable Redis service',
			});

			const version = await this.getInstalledVersion();

			return {
				success: true,
				message: 'Redis installed successfully via YUM',
				method: 'yum',
				version,
			};
		} catch (error) {
			logger.error('YUM installation failed', { error: (error as Error).message });

			return {
				success: false,
				message: `YUM installation failed: ${(error as Error).message}`,
			};
		}
	}

	/**
	 * Check if KeyDB is installed
	 */
	private async isKeyDBInstalled(): Promise<boolean> {
		try {
			await execAsync('which keydb-server');
			return true;
		} catch {
			try {
				await execAsync('which redis-server');
				return true;
			} catch {
				return false;
			}
		}
	}

	/**
	 * Get installed KeyDB version
	 */
	private async getInstalledVersion(): Promise<string | undefined> {
		try {
			const { stdout } = await execAsync('keydb-server --version');
			const match = stdout.match(/KeyDB server v=([^\s]+)/);
			return match ? match[1] : undefined;
		} catch {
			try {
				const { stdout } = await execAsync('redis-server --version');
				const match = stdout.match(/Redis server v=([^\s]+)/);
				return match ? match[1] : undefined;
			} catch {
				return undefined;
			}
		}
	}

	/**
	 * Execute command with adaptive timeout
	 */
	private async executeWithAdaptiveTimeout(
		command: string,
		operation: string,
		baseTimeout: number,
		maxTimeout: number
	): Promise<{ stdout: string; stderr: string }> {
		const lastOutput = { value: '' };
		const commandPromise = this.executeWithProgressCapture(command, lastOutput);

		const timeout = new AdaptiveTimeout({
			operation,
			baseTimeout,
			maxTimeout,
			stallTimeout: Math.min(baseTimeout, 30000),
			progressIndicators: [ProgressIndicators.outputProgress(lastOutput)],
			onProgress: (progress) => {
				logger.debug(`${operation} progress`, progress);
			},
		});

		return timeout.wait(commandPromise);
	}

	/**
	 * Execute command while capturing output for progress monitoring
	 */
	private async executeWithProgressCapture(
		command: string,
		outputCapture: { value: string }
	): Promise<{ stdout: string; stderr: string }> {
		return new Promise((resolve, reject) => {
			const child = exec(command, (error, stdout, stderr) => {
				if (error) {
					reject(error);
				} else {
					resolve({ stdout, stderr });
				}
			});

			// Capture output progressively
			child.stdout?.on('data', (data: string) => {
				outputCapture.value += data;
				logger.debug('Command stdout', { command, data: data.slice(0, 200) });
			});

			child.stderr?.on('data', (data: string) => {
				outputCapture.value += data;
				logger.debug('Command stderr', { command, data: data.slice(0, 200) });
			});
		});
	}

	/**
	 * Check if a command exists
	 */
	private async commandExists(command: string): Promise<boolean> {
		try {
			await execAsync(`which ${command}`);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Get installation instructions for manual setup
	 */
	getManualInstructions(): string {
		const platform = process.platform || os.platform();

		switch (platform) {
			case 'darwin':
				return `
Manual KeyDB Installation for macOS:
=====================================

Option 1: Homebrew (Recommended)
---------------------------------
1. Install Homebrew: https://brew.sh/
2. Run: brew install keydb
3. Start: keydb-server --daemonize yes

Option 2: Docker
----------------
1. Install Docker: https://docs.docker.com/docker-for-mac/install/
2. Run: docker run -d --name keydb -p 6379:6379 eqalpha/keydb:latest

Option 3: Manual Build
----------------------
1. Download from: https://github.com/Snapchat/KeyDB/releases
2. Follow compilation instructions
`;

			case 'linux':
				return `
Manual KeyDB Installation for Linux:
====================================

Option 1: Package Manager
--------------------------
Ubuntu/Debian: sudo apt-get install redis-server
RHEL/CentOS: sudo yum install redis

Option 2: Docker (Recommended)
-------------------------------
1. Install Docker: https://docs.docker.com/engine/install/
2. Run: docker run -d --name keydb -p 6379:6379 eqalpha/keydb:latest

Option 3: Manual Build
-----------------------
1. Download from: https://github.com/Snapchat/KeyDB/releases
2. Compile and install following the documentation
`;

			case 'win32':
				return `
Manual KeyDB Installation for Windows:
======================================

Option 1: Docker (Recommended)
-------------------------------
1. Install Docker Desktop: https://docs.docker.com/docker-for-windows/install/
2. Run: docker run -d --name keydb -p 6379:6379 eqalpha/keydb:latest

Option 2: WSL2 + Linux Method
------------------------------
1. Enable WSL2: https://docs.microsoft.com/en-us/windows/wsl/install
2. Install Ubuntu on WSL2
3. Follow Linux installation instructions
`;

			default:
				return 'Manual installation required - platform not directly supported.';
		}
	}
}
