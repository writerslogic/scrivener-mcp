/**
 * Environment Configuration Utilities
 * Robust parsing and validation of environment variables
 */

import { getLogger } from '../core/logger.js';

const logger = getLogger('env-config');

export interface EnvConfig {
	keydbUrl?: string;
	redisUrl?: string;
	redisHost: string;
	redisPort: number;
	openaiApiKey?: string;
	scrivenerQuiet: boolean;
	scrivenerSkipSetup: boolean;
}

/**
 * Safely parse integer environment variable
 */
export function parseEnvInt(value: string | undefined, defaultValue: number, name: string): number {
	if (!value) return defaultValue;

	const parsed = parseInt(value, 10);
	if (isNaN(parsed)) {
		logger.warn(`Invalid integer for ${name}: "${value}", using default ${defaultValue}`);
		return defaultValue;
	}

	if (parsed < 0 || parsed > 65535) {
		logger.warn(`Port ${name} out of range: ${parsed}, using default ${defaultValue}`);
		return defaultValue;
	}

	return parsed;
}

/**
 * Safely parse boolean environment variable
 */
export function parseEnvBool(value: string | undefined, defaultValue: boolean): boolean {
	if (!value) return defaultValue;

	const lower = value.toLowerCase().trim();
	if (['true', '1', 'yes', 'on'].includes(lower)) return true;
	if (['false', '0', 'no', 'off'].includes(lower)) return false;

	logger.warn(`Invalid boolean value: "${value}", using default ${defaultValue}`);
	return defaultValue;
}

/**
 * Validate URL format
 */
export function validateUrl(url: string | undefined, name: string): string | undefined {
	if (!url) return undefined;

	try {
		const parsed = new URL(url);
		if (!['redis:', 'rediss:', 'http:', 'https:'].includes(parsed.protocol)) {
			logger.warn(`Invalid protocol for ${name}: ${parsed.protocol}`);
			return undefined;
		}
		return url;
	} catch {
		logger.warn(`Invalid URL for ${name}: "${url}"`);
		return undefined;
	}
}

/**
 * Get validated environment configuration
 */
export function getEnvConfig(): EnvConfig {
	const config: EnvConfig = {
		keydbUrl: validateUrl(process.env.KEYDB_URL, 'KEYDB_URL'),
		redisUrl: validateUrl(process.env.REDIS_URL, 'REDIS_URL'),
		redisHost: process.env.REDIS_HOST || 'localhost',
		redisPort: parseEnvInt(process.env.REDIS_PORT, 6379, 'REDIS_PORT'),
		openaiApiKey: process.env.OPENAI_API_KEY?.trim(),
		scrivenerQuiet: parseEnvBool(process.env.SCRIVENER_QUIET, false),
		scrivenerSkipSetup: parseEnvBool(process.env.SCRIVENER_SKIP_SETUP, false),
	};

	// Validate Redis host is not empty
	if (!config.redisHost.trim()) {
		logger.warn('REDIS_HOST is empty, using localhost');
		config.redisHost = 'localhost';
	}

	// Log configuration (without sensitive data)
	logger.debug('Environment configuration loaded', {
		hasKeydbUrl: !!config.keydbUrl,
		hasRedisUrl: !!config.redisUrl,
		redisHost: config.redisHost,
		redisPort: config.redisPort,
		hasOpenaiKey: !!config.openaiApiKey,
		quiet: config.scrivenerQuiet,
		skipSetup: config.scrivenerSkipSetup,
	});

	return config;
}

/**
 * Platform detection with container and architecture support
 */
export interface PlatformInfo {
	platform: NodeJS.Platform;
	isContainer: boolean;
	isWsl: boolean;
	architecture: string;
	packageManagers: string[];
	sudoRequired: boolean;
	[key: string]: unknown;
}

export async function detectPlatform(): Promise<PlatformInfo> {
	const platform = process.platform;
	const arch = process.arch;

	// Detect container environment
	const isContainer = await detectContainer();

	// Detect WSL
	const isWsl =
		platform === 'linux' &&
		(process.env.WSL_DISTRO_NAME !== undefined ||
			(await checkFileExists('/proc/version', 'Microsoft')) ||
			(await checkFileExists('/proc/version', 'microsoft')));

	// Detect available package managers
	const packageManagers = await detectPackageManagers();

	// Determine if sudo is required
	const sudoRequired = await checkSudoRequired();

	const info: PlatformInfo = {
		platform,
		isContainer,
		isWsl,
		architecture: arch,
		packageManagers,
		sudoRequired,
	};

	logger.info('Platform detected', info);
	return info;
}

async function detectContainer(): Promise<boolean> {
	try {
		// Check for container indicators
		const indicators = [
			'/.dockerenv',
			'/run/.containerenv', // Podman
		];

		for (const indicator of indicators) {
			if (await checkFileExists(indicator)) {
				return true;
			}
		}

		// Check cgroups
		if (
			(await checkFileExists('/proc/1/cgroup', 'docker')) ||
			(await checkFileExists('/proc/1/cgroup', 'lxc')) ||
			(await checkFileExists('/proc/1/cgroup', 'kubepods'))
		) {
			return true;
		}

		// Check environment variables
		if (process.env.KUBERNETES_SERVICE_HOST || process.env.container) {
			return true;
		}

		return false;
	} catch {
		return false;
	}
}

async function checkFileExists(filePath: string, content?: string): Promise<boolean> {
	try {
		const fs = await import('fs/promises');
		if (content) {
			const fileContent = await fs.readFile(filePath, 'utf-8');
			return fileContent.includes(content);
		} else {
			await fs.access(filePath);
			return true;
		}
	} catch {
		return false;
	}
}

async function detectPackageManagers(): Promise<string[]> {
	const managers = ['brew', 'apt-get', 'yum', 'dnf', 'zypper', 'pacman', 'apk', 'docker'];
	const available: string[] = [];

	const { exec } = await import('child_process');
	const { promisify } = await import('util');
	const execAsync = promisify(exec);

	// Use Promise.allSettled for better error handling and parallelization
	const results = await Promise.allSettled(
		managers.map(async (manager) => {
			try {
				await execAsync(`which ${manager}`, { timeout: 2000 });
				return manager;
			} catch {
				return null;
			}
		})
	);

	// Collect successful results
	for (const result of results) {
		if (result.status === 'fulfilled' && result.value) {
			available.push(result.value);
		}
	}

	return available;
}

async function checkSudoRequired(): Promise<boolean> {
	try {
		// Check if we're root
		if (process.getuid && process.getuid() === 0) {
			return false;
		}

		// Check if sudo is available
		const { exec } = await import('child_process');
		const { promisify } = await import('util');
		const execAsync = promisify(exec);

		await execAsync('which sudo', { timeout: 2000 });
		return true;
	} catch {
		return false;
	}
}
