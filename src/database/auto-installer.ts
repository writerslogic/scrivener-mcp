/**
 * Automated Database Installation System
 * Handles automatic installation and configuration of Neo4j
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { createWriteStream } from 'fs';
import * as readline from 'readline/promises';
import {
	AppError,
	ErrorCode,
	ensureDir,
	safeStringify,
	safeReadFile,
	safeWriteFile,
} from '../utils/common.js';
import { AdaptiveTimeout, ProgressIndicators } from '../utils/adaptive-timeout.js';

const execAsync = promisify(exec);

export interface InstallOptions {
	method: 'docker' | 'native' | 'homebrew' | 'auto';
	interactive: boolean;
	projectPath: string;
	autoStart: boolean;
	version?: string;
}

export interface InstallResult {
	success: boolean;
	method: string;
	credentials?: {
		uri: string;
		user: string;
		password: string;
		database: string;
	};
	message: string;
}

export class Neo4jAutoInstaller {
	private static readonly DEFAULT_PASSWORD = `scrivener-${Math.random().toString(36).substring(2, 15)}`;
	private static readonly NEO4J_VERSION = '5.15.0';

	/**
	 * Main installation entry point
	 */
	static async install(options: InstallOptions): Promise<InstallResult> {
		console.log('\n🚀 Neo4j Auto-Installation Starting...\n');

		// Check what's available on the system
		const systemInfo = await this.checkSystemCapabilities();

		// Determine installation method
		let method = options.method;
		if (method === 'auto') {
			method = await this.determineOptimalMethod(systemInfo);
		}

		// Get user confirmation if interactive
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

		// Save credentials if successful
		if (result.success && result.credentials) {
			await this.saveCredentials(options.projectPath, result.credentials);
		}

		return result;
	}

	/**
	 * Check system capabilities
	 */
	private static async checkSystemCapabilities(): Promise<{
		platform: string;
		arch: string;
		dockerAvailable: boolean;
		dockerRunning: boolean;
		homebrewAvailable: boolean;
		hasInternet: boolean;
		hasSudo: boolean;
	}> {
		const info = {
			platform: os.platform(),
			arch: os.arch(),
			dockerAvailable: false,
			dockerRunning: false,
			homebrewAvailable: false,
			hasInternet: false,
			hasSudo: false,
		};

		// Check Docker
		try {
			await execAsync('docker --version');
			info.dockerAvailable = true;

			// Check if Docker daemon is running
			await execAsync('docker ps');
			info.dockerRunning = true;
		} catch {
			// Docker not available or not running
		}

		// Check Homebrew (macOS/Linux)
		if (info.platform === 'darwin' || info.platform === 'linux') {
			try {
				await execAsync('brew --version');
				info.homebrewAvailable = true;
			} catch {
				// Homebrew not available
			}
		}

		// Check internet connectivity
		try {
			await execAsync(
				'ping -c 1 -t 1 neo4j.com 2>/dev/null || ping -n 1 -w 1000 neo4j.com 2>nul'
			);
			info.hasInternet = true;
		} catch {
			// No internet or ping blocked
			info.hasInternet = true; // Assume true as ping might be blocked
		}

		// Check sudo availability (Unix-like systems)
		if (info.platform !== 'win32') {
			try {
				await execAsync('sudo -n true 2>/dev/null');
				info.hasSudo = true;
			} catch {
				// Sudo not available or requires password
			}
		}

		return info;
	}

	/**
	 * Determine optimal installation method
	 */
	private static async determineOptimalMethod(
		systemInfo: any
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
			console.log('Docker is installed but not running. Attempting to start...');
			try {
				if (systemInfo.platform === 'darwin') {
					await execAsync('open -a Docker');
					await this.waitForDocker(30);
					return 'docker';
				} else if (systemInfo.platform === 'linux') {
					await execAsync('sudo systemctl start docker');
					await this.waitForDocker(10);
					return 'docker';
				}
			} catch {
				console.log('Could not start Docker automatically.');
			}
		}

		// Fall back to native installation
		return 'native';
	}

	/**
	 * Get user confirmation for installation
	 */
	private static async getUserConfirmation(method: string, systemInfo: any): Promise<boolean> {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});

		console.log('\n📋 Installation Plan:');
		console.log(`   Method: ${method}`);
		console.log(`   Platform: ${systemInfo.platform}`);
		console.log(`   Architecture: ${systemInfo.arch}`);

		if (method === 'docker') {
			console.log('\n   Docker will be used to run Neo4j in a container.');
			console.log('   This is the recommended approach - clean and isolated.');
		} else if (method === 'homebrew') {
			console.log('\n   Homebrew will be used to install Neo4j.');
			console.log('   This will install Neo4j as a system service.');
		} else {
			console.log('\n   Native installation will download and configure Neo4j.');
			console.log('   Java will be required (will be installed if missing).');
		}

		console.log("\n   ✅ Benefits you'll get with Neo4j:");
		console.log('      • Character relationship visualization');
		console.log('      • Story structure analysis');
		console.log('      • Plot complexity tracking');
		console.log('      • Advanced writing analytics');

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
			console.log('\n🐳 Installing Neo4j via Docker...');

			// Pull Neo4j image
			console.log('📥 Downloading Neo4j Docker image...');
			await execAsync(`docker pull neo4j:${options.version || this.NEO4J_VERSION}`);

			// Check if container already exists
			try {
				await execAsync('docker rm -f scrivener-neo4j 2>/dev/null');
			} catch {
				// Container doesn't exist, that's fine
			}

			// Create data volume
			console.log('💾 Creating data volume...');
			await execAsync('docker volume create scrivener-neo4j-data');

			// Run Neo4j container
			console.log('🚀 Starting Neo4j container...');
			const password = this.DEFAULT_PASSWORD;
			const runCommand = [
				'docker run -d',
				'--name scrivener-neo4j',
				'--restart unless-stopped',
				'-p 7474:7474',
				'-p 7687:7687',
				`-e NEO4J_AUTH=neo4j/${password}`,
				'-e NEO4J_PLUGINS=\'["apoc-core", "graph-data-science"]\'',
				'-e NEO4J_dbms_memory_heap_initial__size=512m',
				'-e NEO4J_dbms_memory_heap_max__size=2G',
				'-v scrivener-neo4j-data:/data',
				`neo4j:${options.version || this.NEO4J_VERSION}`,
			].join(' ');

			await execAsync(runCommand);

			// Wait for Neo4j to start
			console.log('⏳ Waiting for Neo4j to start...');
			await this.waitForNeo4j(password);

			console.log('✅ Neo4j installed successfully via Docker!');

			return {
				success: true,
				method: 'docker',
				credentials: {
					uri: 'bolt://localhost:7687',
					user: 'neo4j',
					password,
					database: 'neo4j',
				},
				message: 'Neo4j installed and running in Docker container "scrivener-neo4j"',
			};
		} catch (error) {
			console.error('❌ Docker installation failed:', error);

			// Try to install Docker if not available
			if ((error as any).message?.includes('docker: command not found')) {
				console.log('\n📦 Docker is not installed. Would you like to install it?');
				console.log('Visit: https://docs.docker.com/get-docker/');
			}

			return {
				success: false,
				method: 'docker',
				message: `Docker installation failed: ${(error as Error).message}`,
			};
		}
	}

	/**
	 * Install Neo4j via Homebrew (macOS/Linux)
	 */
	private static async installViaHomebrew(options: InstallOptions): Promise<InstallResult> {
		try {
			console.log('\n🍺 Installing Neo4j via Homebrew...');

			// Update Homebrew
			console.log('📥 Updating Homebrew...');
			await execAsync('brew update');

			// Install Neo4j
			console.log('📦 Installing Neo4j...');
			await execAsync('brew install neo4j');

			// Configure Neo4j
			const password = this.DEFAULT_PASSWORD;
			const neo4jHome = (await execAsync('brew --prefix neo4j')).stdout.trim();
			const _configPath = path.join(neo4jHome, 'libexec', 'conf', 'neo4j.conf');

			// Set initial password
			console.log('🔐 Setting initial password...');
			await execAsync(`neo4j-admin set-initial-password ${password}`);

			// Start Neo4j service
			if (options.autoStart) {
				console.log('🚀 Starting Neo4j service...');
				await execAsync('brew services start neo4j');

				// Wait for Neo4j to start
				console.log('⏳ Waiting for Neo4j to start...');
				await this.waitForNeo4j(password);
			}

			console.log('✅ Neo4j installed successfully via Homebrew!');
			console.log('📝 To manage Neo4j:');
			console.log('   Start: brew services start neo4j');
			console.log('   Stop:  brew services stop neo4j');
			console.log('   Status: brew services list');

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
			console.log('\n📦 Installing Neo4j natively...');

			// Check Java availability
			const javaVersion = await this.checkJava();
			if (!javaVersion) {
				console.log('☕ Java is required for Neo4j. Installing Java...');
				await this.installJava();
			}

			// Determine download URL
			const platform = os.platform();
			const downloadUrl = this.getNeo4jDownloadUrl(platform);

			// Create installation directory
			const installDir = path.join(os.homedir(), '.scrivener-mcp', 'neo4j');
			await ensureDir(installDir);

			// Download Neo4j
			console.log('📥 Downloading Neo4j...');
			const filename = path.basename(downloadUrl);
			const downloadPath = path.join(installDir, filename);
			await this.downloadFile(downloadUrl, downloadPath);

			// Extract Neo4j
			console.log('📂 Extracting Neo4j...');
			await this.extractArchive(downloadPath, installDir);

			// Find Neo4j directory
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
			const password = this.DEFAULT_PASSWORD;
			console.log('🔐 Configuring Neo4j...');
			await this.configureNeo4j(neo4jHome, password);

			// Create start script
			await this.createStartScript(neo4jHome, options.projectPath);

			// Start Neo4j if requested
			if (options.autoStart) {
				console.log('🚀 Starting Neo4j...');
				await this.startNeo4j(neo4jHome);

				console.log('⏳ Waiting for Neo4j to start...');
				await this.waitForNeo4j(password);
			}

			console.log('✅ Neo4j installed successfully!');
			console.log(`📂 Installation directory: ${neo4jHome}`);
			console.log(`📝 Start script: ${path.join(options.projectPath, 'start-neo4j.sh')}`);

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

	/**
	 * Check if Java is installed
	 */
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

	/**
	 * Get Neo4j download URL for platform
	 */
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
						// Handle redirect
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
					fs.unlink(destination).catch(() => {});
					reject(err);
				});
		});
	}

	/**
	 * Extract archive
	 */
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

		// Set initial password
		const adminCmd = path.join(neo4jHome, 'bin', 'neo4j-admin');
		await execAsync(`"${adminCmd}" set-initial-password ${password}`);

		// Update configuration
		let config = await safeReadFile(configPath);

		// Enable APOC procedures
		config += '\n# Scrivener MCP Configuration\n';
		config += 'dbms.security.procedures.unrestricted=apoc.*\n';
		config += 'dbms.security.procedures.allowlist=apoc.*\n';

		await safeWriteFile(configPath, config);
	}

	/**
	 * Create start script
	 */
	private static async createStartScript(neo4jHome: string, projectPath: string): Promise<void> {
		const scriptPath = path.join(projectPath, 'start-neo4j.sh');
		const script = `#!/bin/bash
# Start Neo4j for Scrivener MCP
"${neo4jHome}/bin/neo4j" console
`;

		await safeWriteFile(scriptPath, script);
		await fs.chmod(scriptPath, 0o755);
	}

	/**
	 * Start Neo4j
	 */
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
			new Promise<void>((resolve, _reject) => {
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
	private static async waitForNeo4j(password: string, maxAttempts: number = 30): Promise<void> {
		const neo4j = await import('neo4j-driver');

		const timeout = new AdaptiveTimeout({
			operation: 'Neo4j startup',
			baseTimeout: maxAttempts * 1000,
			maxTimeout: maxAttempts * 1500, // Allow some extra time
			stallTimeout: 15000, // Neo4j can take longer to start
			progressIndicators: [
				ProgressIndicators.networkProgress('localhost', 7687),
				{
					type: 'completion_check',
					description: 'Neo4j connectivity',
					check: async () => {
						try {
							const driver = neo4j.default.driver(
								'bolt://localhost:7687',
								neo4j.default.auth.basic('neo4j', password)
							);
							await driver.verifyConnectivity();
							await driver.close();
							return true;
						} catch {
							return false;
						}
					},
				},
			],
			onProgress: (progress) => {
				if (progress.message?.includes('connectivity')) {
					process.stdout.write('.');
				}
			},
		});

		await timeout.wait(
			new Promise<void>((resolve, _reject) => {
				const checkNeo4j = async () => {
					try {
						const driver = neo4j.default.driver(
							'bolt://localhost:7687',
							neo4j.default.auth.basic('neo4j', password)
						);
						await driver.verifyConnectivity();
						await driver.close();
						resolve();
					} catch {
						// Let adaptive timeout handle the completion check
						setTimeout(checkNeo4j, 200);
					}
				};
				checkNeo4j();
			})
		);
		// Note: If timeout.wait() rejects due to timeout, it will throw an appropriate error
	}

	/**
	 * Save credentials to project
	 */
	private static async saveCredentials(projectPath: string, credentials: any): Promise<void> {
		const configDir = path.join(projectPath, '.scrivener-databases');
		await ensureDir(configDir);

		const configPath = path.join(configDir, 'credentials.json');
		await safeWriteFile(
			configPath,
			safeStringify({ neo4j: credentials, createdAt: new Date().toISOString() }),
			{ mode: 0o600 }
		);

		// Also create .env file if it doesn't exist
		const envPath = path.join(projectPath, '.env');
		try {
			await fs.access(envPath);
		} catch {
			const envContent = `# Neo4j Configuration (auto-generated)
NEO4J_URI=${credentials.uri}
NEO4J_USER=${credentials.user}
NEO4J_PASSWORD=${credentials.password}
NEO4J_DATABASE=${credentials.database}
`;
			await safeWriteFile(envPath, envContent);
		}
	}
}
