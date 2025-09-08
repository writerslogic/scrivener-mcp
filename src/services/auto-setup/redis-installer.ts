/**
 * Redis auto-installer for BullMQ support
 * Handles Redis installation and configuration across platforms
 */

import { execSync, spawn } from 'child_process';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';
import { getLogger } from '../../core/logger.js';
import { createError, ErrorCode } from '../../core/errors.js';

const logger = getLogger('redis-installer');

export interface RedisConfig {
	host: string;
	port: number;
	password?: string;
	maxRetries?: number;
	enableOfflineQueue?: boolean;
}

export class RedisInstaller {
	private platform = platform();
	private redisDir = join(homedir(), '.scrivener-mcp', 'redis');
	private redisConfigPath = join(this.redisDir, 'redis.conf');
	private redisPidPath = join(this.redisDir, 'redis.pid');
	private redisLogPath = join(this.redisDir, 'redis.log');

	/**
	 * Check if Redis is already installed
	 */
	isRedisInstalled(): boolean {
		try {
			execSync('redis-cli --version', { stdio: 'ignore' });
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Check if Redis is running
	 */
	async isRedisRunning(port: number = 6379): Promise<boolean> {
		try {
			execSync(`redis-cli -p ${port} ping`, { stdio: 'ignore' });
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Install Redis based on platform
	 */
	async installRedis(): Promise<void> {
		logger.info(`Installing Redis for ${this.platform}`);

		try {
			switch (this.platform) {
				case 'darwin':
					await this.installRedisMacOS();
					break;
				case 'linux':
					await this.installRedisLinux();
					break;
				case 'win32':
					await this.installRedisWindows();
					break;
				default:
					throw createError(
						ErrorCode.VALIDATION_ERROR,
						null,
						`Unsupported platform: ${this.platform}`
					);
			}
		} catch (error) {
			logger.error('Failed to install Redis', { error });
			throw error;
		}
	}

	/**
	 * Install Redis on macOS using Homebrew
	 */
	private async installRedisMacOS(): Promise<void> {
		// Check if Homebrew is installed
		try {
			execSync('brew --version', { stdio: 'ignore' });
		} catch {
			logger.info('Installing Homebrew first...');
			execSync(
				'/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
				{ stdio: 'inherit' }
			);
		}

		// Install Redis via Homebrew
		logger.info('Installing Redis via Homebrew...');
		execSync('brew install redis', { stdio: 'inherit' });
		
		// Start Redis service
		execSync('brew services start redis', { stdio: 'inherit' });
		logger.info('Redis installed and started successfully');
	}

	/**
	 * Install Redis on Linux
	 */
	private async installRedisLinux(): Promise<void> {
		// Detect Linux distribution
		let distro = 'unknown';
		try {
			const osRelease = execSync('cat /etc/os-release').toString();
			if (osRelease.includes('Ubuntu') || osRelease.includes('Debian')) {
				distro = 'debian';
			} else if (osRelease.includes('Red Hat') || osRelease.includes('CentOS') || osRelease.includes('Fedora')) {
				distro = 'redhat';
			}
		} catch {
			// Fallback to generic installation
		}

		if (distro === 'debian') {
			logger.info('Installing Redis on Debian/Ubuntu...');
			execSync('sudo apt-get update', { stdio: 'inherit' });
			execSync('sudo apt-get install -y redis-server', { stdio: 'inherit' });
			execSync('sudo systemctl start redis-server', { stdio: 'inherit' });
			execSync('sudo systemctl enable redis-server', { stdio: 'inherit' });
		} else if (distro === 'redhat') {
			logger.info('Installing Redis on RedHat/CentOS/Fedora...');
			execSync('sudo yum install -y epel-release', { stdio: 'inherit' });
			execSync('sudo yum install -y redis', { stdio: 'inherit' });
			execSync('sudo systemctl start redis', { stdio: 'inherit' });
			execSync('sudo systemctl enable redis', { stdio: 'inherit' });
		} else {
			// Generic installation from source
			logger.info('Installing Redis from source...');
			await this.installRedisFromSource();
		}

		logger.info('Redis installed successfully');
	}

	/**
	 * Install Redis on Windows
	 */
	private async installRedisWindows(): Promise<void> {
		logger.info('Setting up Redis for Windows...');

		// Check if WSL is available
		try {
			execSync('wsl --version', { stdio: 'ignore' });
			logger.info('WSL detected, installing Redis in WSL...');
			execSync('wsl sudo apt-get update', { stdio: 'inherit' });
			execSync('wsl sudo apt-get install -y redis-server', { stdio: 'inherit' });
			execSync('wsl sudo service redis-server start', { stdio: 'inherit' });
		} catch {
			// Use Docker as fallback
			logger.info('WSL not available, using Docker for Redis...');
			await this.setupRedisDocker();
		}
	}

	/**
	 * Install Redis from source
	 */
	private async installRedisFromSource(): Promise<void> {
		const tmpDir = '/tmp/redis-install';
		
		execSync(`mkdir -p ${tmpDir}`, { stdio: 'inherit' });
		execSync(`cd ${tmpDir} && wget https://download.redis.io/redis-stable.tar.gz`, { stdio: 'inherit' });
		execSync(`cd ${tmpDir} && tar xzf redis-stable.tar.gz`, { stdio: 'inherit' });
		execSync(`cd ${tmpDir}/redis-stable && make`, { stdio: 'inherit' });
		execSync(`cd ${tmpDir}/redis-stable && sudo make install`, { stdio: 'inherit' });
		execSync(`rm -rf ${tmpDir}`, { stdio: 'inherit' });
	}

	/**
	 * Setup Redis using Docker
	 */
	async setupRedisDocker(): Promise<void> {
		// Check if Docker is installed
		try {
			execSync('docker --version', { stdio: 'ignore' });
		} catch {
			throw createError(
				ErrorCode.CONNECTION_ERROR,
				null,
				'Docker is required but not installed. Please install Docker Desktop.'
			);
		}

		logger.info('Starting Redis container...');
		
		// Stop any existing Redis container
		try {
			execSync('docker stop scrivener-redis', { stdio: 'ignore' });
			execSync('docker rm scrivener-redis', { stdio: 'ignore' });
		} catch {
			// Container doesn't exist, that's fine
		}

		// Start Redis container
		execSync(
			'docker run -d --name scrivener-redis -p 6379:6379 redis:alpine',
			{ stdio: 'inherit' }
		);

		logger.info('Redis container started successfully');
	}

	/**
	 * Create Redis configuration file
	 */
	createRedisConfig(config: Partial<RedisConfig> = {}): void {
		// Ensure directory exists
		if (!existsSync(this.redisDir)) {
			mkdirSync(this.redisDir, { recursive: true });
		}

		const redisConf = `
# Redis configuration for Scrivener MCP
bind 127.0.0.1
port ${config.port || 6379}
daemonize yes
pidfile ${this.redisPidPath}
logfile ${this.redisLogPath}
dir ${this.redisDir}
maxmemory 256mb
maxmemory-policy allkeys-lru
save 900 1
save 300 10
save 60 10000
${config.password ? `requirepass ${config.password}` : ''}
`;

		writeFileSync(this.redisConfigPath, redisConf);
		logger.info('Redis configuration created');
	}

	/**
	 * Start Redis server with custom configuration
	 */
	async startRedis(config: Partial<RedisConfig> = {}): Promise<void> {
		const port = config.port || 6379;

		// Check if already running
		if (await this.isRedisRunning(port)) {
			logger.info('Redis is already running');
			return;
		}

		// Create configuration
		this.createRedisConfig(config);

		// Start Redis
		if (this.platform === 'win32') {
			// Use Docker or WSL
			try {
				execSync('wsl redis-server ' + this.redisConfigPath, { stdio: 'inherit' });
			} catch {
				await this.setupRedisDocker();
			}
		} else {
			// Start with configuration file
			const redis = spawn('redis-server', [this.redisConfigPath], {
				detached: true,
				stdio: 'ignore',
			});
			redis.unref();
		}

		// Wait for Redis to start
		let attempts = 0;
		while (attempts < 10) {
			if (await this.isRedisRunning(port)) {
				logger.info(`Redis started successfully on port ${port}`);
				return;
			}
			await new Promise(resolve => setTimeout(resolve, 1000));
			attempts++;
		}

		throw createError(
			ErrorCode.CONNECTION_ERROR,
			null,
			'Failed to start Redis server'
		);
	}

	/**
	 * Stop Redis server
	 */
	async stopRedis(): Promise<void> {
		if (this.platform === 'win32') {
			try {
				execSync('docker stop scrivener-redis', { stdio: 'ignore' });
			} catch {
				execSync('wsl sudo service redis-server stop', { stdio: 'ignore' });
			}
		} else if (this.platform === 'darwin') {
			execSync('brew services stop redis', { stdio: 'ignore' });
		} else {
			try {
				execSync('sudo systemctl stop redis-server', { stdio: 'ignore' });
			} catch {
				// Try to kill using PID file
				if (existsSync(this.redisPidPath)) {
					const pid = execSync(`cat ${this.redisPidPath}`).toString().trim();
					execSync(`kill ${pid}`, { stdio: 'ignore' });
				}
			}
		}

		logger.info('Redis stopped');
	}

	/**
	 * Get Redis connection URL
	 */
	getRedisUrl(config: Partial<RedisConfig> = {}): string {
		const host = config.host || 'localhost';
		const port = config.port || 6379;
		const password = config.password;

		if (password) {
			return `redis://:${password}@${host}:${port}`;
		}
		return `redis://${host}:${port}`;
	}

	/**
	 * Test Redis connection
	 */
	async testConnection(config: Partial<RedisConfig> = {}): Promise<boolean> {
		const port = config.port || 6379;
		const password = config.password;

		try {
			const authCmd = password ? `-a ${password}` : '';
			execSync(`redis-cli -p ${port} ${authCmd} ping`, { stdio: 'ignore' });
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Full auto-setup process
	 */
	async autoSetup(config: Partial<RedisConfig> = {}): Promise<string> {
		logger.info('Starting Redis auto-setup...');

		// Check if Redis is already running
		if (await this.isRedisRunning(config.port || 6379)) {
			logger.info('Redis is already running');
			return this.getRedisUrl(config);
		}

		// Install Redis if not present
		if (!this.isRedisInstalled()) {
			logger.info('Redis not found, installing...');
			await this.installRedis();
		}

		// Start Redis
		await this.startRedis(config);

		// Test connection
		if (await this.testConnection(config)) {
			const url = this.getRedisUrl(config);
			logger.info('Redis setup complete', { url });
			return url;
		}

		throw createError(
			ErrorCode.CONNECTION_ERROR,
			null,
			'Failed to connect to Redis after setup'
		);
	}
}