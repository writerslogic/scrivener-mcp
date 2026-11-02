/**
 * Automated Database Installation System
 * Handles automatic installation and configuration of Neo4j
 */

import { exec, execFile, spawn } from 'child_process';
import { createWriteStream } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline/promises';
import { promisify } from 'util';
import { AdaptiveTimeout } from '../../utils/adaptive-timeout.js';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { waitForServiceReady } from '../../utils/condition-waiter.js';
import { AppError, ErrorCode, ensureDir, safeReadFile, safeWriteFile } from '../../utils/common.js';
import { getLogger } from '../../core/logger.js';
import { PermissionManager } from '../../utils/permission-manager.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const logger = getLogger('auto-installer');

interface SystemInfo {
	platform: NodeJS.Platform;
	arch: string;
	dockerAvailable: boolean;
	dockerRunning: boolean;
	homebrewAvailable: boolean;
	neo4jInstalled: boolean;
	java11Available: boolean;
}

interface Neo4jCredentials {
	uri: string;
	user: string;
	password: string;
	database: string;
}

export interface InstallOptions {
	method: 'docker' | 'native' | 'homebrew' | 'auto';
	interactive: boolean;
	projectPath: string;
	autoStart: boolean;
	version?: string;
	bindAddress?: string;
}

export interface InstallResult {
	success: boolean;
	method: string;
	credentials?: Neo4jCredentials;
	message: string;
}

export class Neo4jAutoInstaller {
	private static readonly NEO4J_VERSION = '5.15.0';

	/**
	 * Main installation entry point
	 */
	static async install(options: InstallOptions): Promise<InstallResult> {
		logger.info('Neo4j Auto-Installation Starting');

		const systemInfo = await this.checkSystemCapabilities();

		let method = options.method;
		if (method === 'auto') {
			method = await this.determineOptimalMethod(systemInfo);
		}

		if (options.interactive) {
			const confirmed = await this.getUserConfirmation(method, systemInfo);
			if (!confirmed) {
				return {
					success: false,
					method: 'none',
					message: 'Installation cancelled by user',
				};
			}
		}

		// Perform installation
		let result: InstallResult;
		switch (method) {
			case 'docker':
				result = await this.installViaDocker(options);
				break;
			case 'homebrew':
				result = await this.installViaHomebrew(options);
				break;
			case 'native':
				result = await this.installNative(options);
				break;
			default:
				throw new AppError(
					`Unsupported installation method: ${method}`,
					ErrorCode.CONFIGURATION_ERROR
				);
		}

		if (result.success && result.credentials) {
			await this.saveCredentials(options.projectPath, result.credentials);
		}

		return result;
	}

	private static async checkSystemCapabilities(): Promise<SystemInfo> {
		const info: SystemInfo = {
			platform: os.platform(),
			arch: os.arch(),
			dockerAvailable: false,
			dockerRunning: false,
			homebrewAvailable: false,
			neo4jInstalled: false,
			java11Available: false,
		};

		try {
			await execAsync('docker --version');
			info.dockerAvailable = true;

			await execAsync('docker ps');
			info.dockerRunning = true;
		} catch {
			// Docker not available or not running
		}

		if (info.platform === 'darwin' || info.platform === 'linux') {
			try {
				await execAsync('brew --version');
				info.homebrewAvailable = true;
			} catch {
				// Homebrew not available
			}
		}

		try {
			await execAsync('neo4j version');
			info.neo4jInstalled = true;
		} catch {
			// Neo4j not installed
		}

		try {
			const javaVersion = await execAsync('java -version 2>&1');
			if (javaVersion.stdout.includes('11') || javaVersion.stdout.includes('17')) {
				info.java11Available = true;
			}
		} catch {
			// Java not available
		}

		return info;
	}

	private static async determineOptimalMethod(
		systemInfo: SystemInfo
	): Promise<'docker' | 'homebrew' | 'native'> {
		// Prefer Docker if available and running
		if (systemInfo.dockerAvailable && systemInfo.dockerRunning) {
			return 'docker';
		}

		// Use Homebrew on macOS if available
		if (systemInfo.platform === 'darwin' && systemInfo.homebrewAvailable) {
			return 'homebrew';
		}

		// Try to start Docker if available but not running
		if (systemInfo.dockerAvailable && !systemInfo.dockerRunning) {
			logger.info('Docker is installed but not running. Attempting to start...');
			try {
				if (systemInfo.platform === 'darwin') {
					await PermissionManager.executeWithPermissions('open -a Docker', {
						operation: 'start-docker',
						timeout: 10000,
					});
					await this.waitForDocker(30);
					return 'docker';
				} else if (systemInfo.platform === 'linux') {
					await PermissionManager.executeWithPermissions('systemctl start docker', {
						operation: 'start-docker-daemon',
						timeout: 15000,
					});
					await this.waitForDocker(10);
					return 'docker';
				}
			} catch (error) {
				logger.warn('Could not start Docker automatically', {
					error: (error as Error).message,
				});
			}
		}

		// Fall back to native installation
		return 'native';
	}

	private static async getUserConfirmation(
		method: string,
		systemInfo: SystemInfo
	): Promise<boolean> {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});

		console.error('\n📋 Installation Plan:');
		console.error(`   Method: ${method}`);
		console.error(`   Platform: ${systemInfo.platform}`);
		console.error(`   Architecture: ${systemInfo.arch}`);

		if (method === 'docker') {
			console.error('\n   Docker will be used to run Neo4j in a container.');
			console.error('   This is the recommended approach - clean and isolated.');
		} else if (method === 'homebrew') {
			console.error('\n   Homebrew will be used to install Neo4j.');
			console.error('   This will install Neo4j as a system service.');
		} else {
			console.error('\n   Native installation will download and configure Neo4j.');
			console.error('   Java will be required (will be installed if missing).');
		}

		console.error("\n   ✅ Benefits you'll get with Neo4j:");
		console.error('      • Character relationship visualization');
		console.error('      • Story structure analysis');
		console.error('      • Plot complexity tracking');
		console.error('      • Advanced writing analytics');

		const answer = await rl.question(
			'\n❓ Do you want to proceed with installation? (yes/no): '
		);
		rl.close();

		return answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y';
	}

	/**
	 * Install Neo4j via Docker
	 */
	private static async installViaDocker(options: InstallOptions): Promise<InstallResult> {
		try {
			const version = options.version ?? this.NEO4J_VERSION;
			const address = options.bindAddress ?? '127.0.0.1';
			if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version) || !isIP(address))
				throw new Error('Invalid Docker version or bind address');
			const existing = await execFileAsync('docker', [
				'ps',
				'--all',
				'--filter',
				'name=^/scrivener-neo4j$',
				'--format',
				'{{.ID}}',
			]);
			if (existing.stdout.trim())
				return {
					success: false,
					method: 'docker',
					message:
						'The scrivener-neo4j container already exists; its data and credentials were preserved.',
				};
			const { DatabaseSetup } = await import('./database-setup.js');
			const connectionHost =
				address === '0.0.0.0' ? '127.0.0.1' : address === '::' ? '::1' : address;
			const connectionUri = `bolt://${isIP(connectionHost) === 6 ? `[${connectionHost}]` : connectionHost}:7687`;
			const prior = await DatabaseSetup.getCredentials({ projectPath: options.projectPath });
			if (
				prior.neo4j.password &&
				((prior.neo4j.uri !== connectionUri &&
					prior.neo4j.uri !== 'bolt://localhost:7687') ||
					prior.neo4j.user !== 'neo4j' ||
					prior.neo4j.password.length < 32)
			)
				throw new Error('Existing credentials require explicit migration');
			const password = prior.neo4j.password || randomBytes(32).toString('base64url');
			const credentials = { uri: connectionUri, user: 'neo4j', password, database: 'neo4j' };
			await this.saveCredentials(options.projectPath, credentials);
			await execFileAsync('docker', ['pull', `neo4j:${version}`]);
			await execFileAsync('docker', ['volume', 'create', 'scrivener-neo4j-data']);
			const host = isIP(address) === 6 ? `[${address}]` : address;
			await execFileAsync(
				'docker',
				[
					'run',
					'-d',
					'--name',
					'scrivener-neo4j',
					'--restart',
					'unless-stopped',
					'-p',
					`${host}:7474:7474`,
					'-p',
					`${host}:7687:7687`,
					'--env',
					'NEO4J_AUTH',
					'--env',
					'NEO4J_PLUGINS=["apoc-core", "graph-data-science"]',
					'--env',
					'NEO4J_dbms_memory_heap_initial__size=512m',
					'--env',
					'NEO4J_dbms_memory_heap_max__size=2G',
					'-v',
					'scrivener-neo4j-data:/data',
					`neo4j:${version}`,
				],
				{ env: { ...process.env, NEO4J_AUTH: `neo4j/${password}` } }
			);
			await this.waitForNeo4j(password, 30, connectionHost);
			return {
				success: true,
				method: 'docker',
				credentials,
				message: 'Neo4j installed; credentials are stored in the project credential file.',
			};
		} catch {
			return {
				success: false,
				method: 'docker',
				message:
					'Neo4j Docker setup failed. Check Docker availability, existing credentials, image version and port availability; any generated credentials were retained privately.',
			};
		}
	}

	/**
	 * Install Neo4j via Homebrew (macOS/Linux)
	 */
	private static async installViaHomebrew(options: InstallOptions): Promise<InstallResult> {
		try {
			console.error('\n🍺 Installing Neo4j via Homebrew...');

			console.error('📥 Updating Homebrew...');
			await PermissionManager.executeWithPermissions('brew update', {
				operation: 'update-homebrew',
				timeout: 30000,
			});

			// Install Neo4j
			console.error('📦 Installing Neo4j...');
			await PermissionManager.executeWithPermissions('brew install neo4j', {
				operation: 'install-neo4j',
				timeout: 60000,
			});

			// Configure Neo4j
			const password = randomBytes(32).toString('base64url');

			console.error('🔐 Setting initial password...');
			await execFileAsync('neo4j-admin', ['set-initial-password', password], {
				timeout: 10000,
			});

			if (options.autoStart) {
				console.error('🚀 Starting Neo4j service...');
				await PermissionManager.executeWithPermissions('brew services start neo4j', {
					operation: 'start-neo4j-service',
					timeout: 20000,
				});

				// Wait for Neo4j to start
				console.error('⏳ Waiting for Neo4j to start...');
				await this.waitForNeo4j(password);
			}

			console.error('✅ Neo4j installed successfully via Homebrew!');
			console.error('📝 To manage Neo4j:');
			console.error('   Start: brew services start neo4j');
			console.error('   Stop:  brew services stop neo4j');
			console.error('   Status: brew services list');

			return {
				success: true,
				method: 'homebrew',
				credentials: {
					uri: 'bolt://localhost:7687',
					user: 'neo4j',
					password,
					database: 'neo4j',
				},
				message: 'Neo4j installed via Homebrew. Use "brew services" to manage.',
			};
		} catch (error) {
			console.error('❌ Homebrew installation failed:', error);
			return {
				success: false,
				method: 'homebrew',
				message: `Homebrew installation failed: ${(error as Error).message}`,
			};
		}
	}

	/**
	 * Native installation (download and extract)
	 */
	private static async installNative(options: InstallOptions): Promise<InstallResult> {
		try {
			console.error('\n📦 Installing Neo4j natively...');

			const javaVersion = await this.checkJava();
			if (!javaVersion) {
				console.error('☕ Java is required for Neo4j. Installing Java...');
				await this.installJava();
			}

			const platform = os.platform();
			const downloadUrl = this.getNeo4jDownloadUrl(platform);

			const installDir = path.join(os.homedir(), '.scrivener-mcp', 'neo4j');
			await ensureDir(installDir);

			// Download Neo4j
			console.error('📥 Downloading Neo4j...');
			const filename = path.basename(downloadUrl);
			const downloadPath = path.join(installDir, filename);
			await this.downloadFile(downloadUrl, downloadPath);

			console.error('📂 Extracting Neo4j...');
			await this.extractArchive(downloadPath, installDir);

			const dirs = await fs.readdir(installDir);
			const neo4jDir = dirs.find((d) => d.startsWith('neo4j-'));
			if (!neo4jDir) {
				throw new AppError(
					'Neo4j directory not found after extraction',
					ErrorCode.INITIALIZATION_ERROR
				);
			}

			const neo4jHome = path.join(installDir, neo4jDir);

			// Configure Neo4j
			const password = randomBytes(32).toString('base64url');
			console.error('🔐 Configuring Neo4j...');
			await this.configureNeo4j(neo4jHome, password);

			await this.createStartScript(neo4jHome, options.projectPath);

			if (options.autoStart) {
				console.error('🚀 Starting Neo4j...');
				await this.startNeo4j(neo4jHome);

				console.error('⏳ Waiting for Neo4j to start...');
				await this.waitForNeo4j(password);
			}

			console.error('✅ Neo4j installed successfully!');
			console.error(`📂 Installation directory: ${neo4jHome}`);
			console.error(`📝 Start script: ${path.join(options.projectPath, 'start-neo4j.sh')}`);

			return {
				success: true,
				method: 'native',
				credentials: {
					uri: 'bolt://localhost:7687',
					user: 'neo4j',
					password,
					database: 'neo4j',
				},
				message: `Neo4j installed at ${neo4jHome}`,
			};
		} catch (error) {
			console.error('❌ Native installation failed:', error);
			return {
				success: false,
				method: 'native',
				message: `Native installation failed: ${(error as Error).message}`,
			};
		}
	}

	private static async checkJava(): Promise<string | null> {
		try {
			const { stdout } = await execAsync('java -version 2>&1');
			return stdout;
		} catch {
			return null;
		}
	}

	/**
	 * Install Java
	 */
	private static async installJava(): Promise<void> {
		const platform = os.platform();

		if (platform === 'darwin') {
			// macOS
			try {
				await execAsync('brew install openjdk@17');
			} catch {
				throw new AppError(
					'Please install Java 17 manually: https://adoptium.net/',
					ErrorCode.INITIALIZATION_ERROR
				);
			}
		} else if (platform === 'linux') {
			// Linux
			try {
				await execAsync('sudo apt-get update && sudo apt-get install -y openjdk-17-jdk');
			} catch {
				try {
					await execAsync('sudo yum install -y java-17-openjdk');
				} catch {
					throw new AppError(
						'Please install Java 17 manually: https://adoptium.net/',
						ErrorCode.INITIALIZATION_ERROR
					);
				}
			}
		} else {
			// Windows
			throw new AppError(
				'Please install Java 17 from: https://adoptium.net/',
				ErrorCode.INITIALIZATION_ERROR
			);
		}
	}

	private static getNeo4jDownloadUrl(platform: string): string {
		const version = this.NEO4J_VERSION;
		const baseUrl = 'https://neo4j.com/artifact.php';

		if (platform === 'darwin') {
			return `${baseUrl}?name=neo4j-community-${version}-unix.tar.gz`;
		} else if (platform === 'linux') {
			return `${baseUrl}?name=neo4j-community-${version}-unix.tar.gz`;
		} else {
			return `${baseUrl}?name=neo4j-community-${version}-windows.zip`;
		}
	}

	/**
	 * Download file from URL
	 */
	private static async downloadFile(url: string, destination: string): Promise<void> {
		const https = await import('https');
		const http = await import('http');
		const protocol = url.startsWith('https') ? https : http;

		return new Promise((resolve, reject) => {
			const file = createWriteStream(destination);

			protocol
				.get(url, (response) => {
					if (response.statusCode === 302 || response.statusCode === 301) {
						const redirectUrl = response.headers.location;
						if (redirectUrl) {
							this.downloadFile(redirectUrl, destination).then(resolve).catch(reject);
							return;
						}
					}

					response.pipe(file);
					file.on('finish', () => {
						file.close();
						resolve();
					});
				})
				.on('error', (err) => {
					fs.unlink(destination).catch((err) =>
						logger.debug('Failed to cleanup download', { destination, error: err })
					);
					reject(err);
				});
		});
	}

	private static async extractArchive(archivePath: string, destination: string): Promise<void> {
		if (archivePath.endsWith('.tar.gz')) {
			await execAsync(`tar -xzf "${archivePath}" -C "${destination}"`);
		} else if (archivePath.endsWith('.zip')) {
			await execAsync(`unzip -q "${archivePath}" -d "${destination}"`);
		} else {
			throw new AppError('Unsupported archive format', ErrorCode.INVALID_INPUT);
		}
	}

	/**
	 * Configure Neo4j
	 */
	private static async configureNeo4j(neo4jHome: string, password: string): Promise<void> {
		const configPath = path.join(neo4jHome, 'conf', 'neo4j.conf');

		const adminCmd = path.join(neo4jHome, 'bin', 'neo4j-admin');
		await execFileAsync(adminCmd, ['set-initial-password', password]);

		let config = await safeReadFile(configPath);

		// Enable APOC procedures
		config += '\n# Scrivener MCP Configuration\n';
		config += 'dbms.security.procedures.unrestricted=apoc.*\n';
		config += 'dbms.security.procedures.allowlist=apoc.*\n';

		await safeWriteFile(configPath, config);
	}

	private static async createStartScript(neo4jHome: string, projectPath: string): Promise<void> {
		const scriptPath = path.join(projectPath, 'start-neo4j.sh');
		const script = `#!/bin/bash
# Start Neo4j for Scrivener MCP
"${neo4jHome}/bin/neo4j" console
`;

		await safeWriteFile(scriptPath, script);
		await fs.chmod(scriptPath, 0o755);
	}

	private static async startNeo4j(neo4jHome: string): Promise<void> {
		const neo4jBin = path.join(neo4jHome, 'bin', 'neo4j');

		spawn(neo4jBin, ['start'], {
			detached: true,
			stdio: 'ignore',
		}).unref();
	}

	/**
	 * Wait for Docker to be ready with adaptive timeout
	 */
	private static async waitForDocker(maxSeconds: number = 30): Promise<void> {
		const timeout = new AdaptiveTimeout({
			operation: 'Docker startup',
			baseTimeout: maxSeconds * 1000,
			maxTimeout: maxSeconds * 1000,
			stallTimeout: 10000,
			progressIndicators: [
				{
					type: 'completion_check',
					description: 'Docker availability',
					check: async () => {
						try {
							await execAsync('docker ps', { timeout: 5000 });
							return true;
						} catch {
							return false;
						}
					},
				},
			],
		});

		await timeout.wait(
			new Promise<void>((resolve) => {
				const checkDocker = async () => {
					try {
						await execAsync('docker ps', { timeout: 5000 });
						resolve();
					} catch {
						// Let adaptive timeout handle the completion check
						setTimeout(checkDocker, 100);
					}
				};
				checkDocker();
			})
		);
	}

	/**
	 * Wait for Neo4j to be ready with adaptive timeout
	 */
	private static async waitForNeo4j(
		password: string,
		maxAttempts: number = 30,
		host = 'localhost'
	): Promise<void> {
		await waitForServiceReady(host, 7687, maxAttempts * 1000);
		const neo4j = await import('neo4j-driver');
		const driver = neo4j.default.driver(
			`bolt://${isIP(host) === 6 ? `[${host}]` : host}:7687`,
			neo4j.default.auth.basic('neo4j', password),
			{ connectionTimeout: 5000 }
		);
		try {
			await driver.verifyConnectivity();
		} finally {
			await driver.close();
		}
	}

	private static async saveCredentials(
		projectPath: string,
		credentials: Neo4jCredentials
	): Promise<void> {
		const { DatabaseSetup } = await import('./database-setup.js');
		await DatabaseSetup.saveCredentials(projectPath, { neo4j: credentials });
	}
}
