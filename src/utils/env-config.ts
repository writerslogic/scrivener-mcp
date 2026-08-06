/**
 * Environment Configuration Utilities
 * Robust parsing and validation of environment variables
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { getLogger } from '../core/logger.js';
import { ValidationUtils, FileUtils, ProcessUtils } from './shared-patterns.js';

const logger = getLogger('env-config');

export interface EnvConfig {
	keydbUrl?: string;
	redisUrl?: string;
	redisHost: string;
	redisPort: number;
	openaiApiKey?: string;
	anthropicApiKey?: string;
	openrouterApiKey?: string;
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

	if (ValidationUtils.validateUrl(url, ['redis:', 'rediss:', 'http:', 'https:'])) {
		return url;
	} else {
		logger.warn(`Invalid URL for ${name}: "${url}"`);
		return undefined;
	}
}

interface KeyDiscoverySpec {
	/** Variable name expected in .env-style files, e.g. OPENAI_API_KEY. */
	envVar: string;
	/** Full-key validation pattern; anchored so one provider's key never matches another's. */
	keyPattern: RegExp;
	/** Files that contain just the key (no VAR= prefix). */
	bareKeyFiles: string[];
	/** macOS Keychain generic-password service name. */
	keychainService: string;
}

/**
 * Discover an API key from common dotfiles and macOS Keychain.
 * In multi-variable .env files the explicit `VAR=` prefix is required so a
 * neighbouring provider's key (e.g. ANTHROPIC_API_KEY next to OPENAI_API_KEY)
 * is never misattributed. Returns undefined if not found. Never throws.
 */
function discoverKey(spec: KeyDiscoverySpec, home: string): string | undefined {
	// Escape hatch for hermetic tests and users who want explicit env only:
	// discovery would otherwise pick up real keys from ~/.env or the Keychain.
	const disabled = process.env.SCRIVENER_DISABLE_KEY_DISCOVERY;
	if (disabled === '1' || disabled === 'true') return undefined;
	const envFiles = [path.join(home, '.env'), path.join(home, '.scrivener-mcp', '.env')];
	const prefixed = new RegExp(`^\\s*${spec.envVar}\\s*=\\s*["']?([A-Za-z0-9_-]+)["']?\\s*$`, 'm');

	for (const filepath of envFiles) {
		try {
			if (!fs.existsSync(filepath)) continue;
			const content = fs.readFileSync(filepath, 'utf-8');
			const match = content.match(prefixed);
			if (match && spec.keyPattern.test(match[1])) {
				logger.debug(`${spec.envVar} discovered from dotfile`, { source: filepath });
				return match[1];
			}
		} catch {
			continue;
		}
	}

	for (const filepath of spec.bareKeyFiles) {
		try {
			if (!fs.existsSync(filepath)) continue;
			const content = fs.readFileSync(filepath, 'utf-8').trim();
			if (spec.keyPattern.test(content)) {
				logger.debug(`${spec.envVar} discovered from key file`, { source: filepath });
				return content;
			}
		} catch {
			continue;
		}
	}

	if (process.platform === 'darwin') {
		try {
			const result = execFileSync(
				'security',
				['find-generic-password', '-s', spec.keychainService, '-w'],
				{ timeout: 3000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
			).trim();
			if (spec.keyPattern.test(result)) {
				logger.debug(`${spec.envVar} discovered from macOS Keychain`);
				return result;
			}
		} catch {
			// Not in keychain
		}
	}

	return undefined;
}

function discoverOpenAIKey(home: string = os.homedir()): string | undefined {
	return discoverKey(
		{
			envVar: 'OPENAI_API_KEY',
			// sk-ant- is an Anthropic key and sk-or- an OpenRouter key; exclude
			// both so a misplaced key file or keychain entry is never sent to OpenAI.
			keyPattern: /^sk-(?!ant-|or-)[a-zA-Z0-9_-]{20,}$/,
			bareKeyFiles: [
				path.join(home, '.config', 'openai', 'key'),
				path.join(home, '.openai', 'key'),
			],
			keychainService: 'openai-api-key',
		},
		home
	);
}

function discoverAnthropicKey(home: string = os.homedir()): string | undefined {
	return discoverKey(
		{
			envVar: 'ANTHROPIC_API_KEY',
			keyPattern: /^sk-ant-[a-zA-Z0-9_-]{20,}$/,
			bareKeyFiles: [
				path.join(home, '.config', 'anthropic', 'key'),
				path.join(home, '.anthropic', 'key'),
			],
			keychainService: 'anthropic-api-key',
		},
		home
	);
}

function discoverOpenRouterKey(home: string = os.homedir()): string | undefined {
	return discoverKey(
		{
			envVar: 'OPENROUTER_API_KEY',
			keyPattern: /^sk-or-[a-zA-Z0-9_-]{20,}$/,
			bareKeyFiles: [
				path.join(home, '.config', 'openrouter', 'key'),
				path.join(home, '.openrouter', 'key'),
			],
			keychainService: 'openrouter-api-key',
		},
		home
	);
}

/**
 * Discover AI provider keys from dotfiles and the macOS Keychain.
 * The homeDir parameter exists for tests; production callers use the default.
 */
export function discoverAIKeys(homeDir: string = os.homedir()): {
	openaiApiKey?: string;
	anthropicApiKey?: string;
	openrouterApiKey?: string;
} {
	return {
		openaiApiKey: discoverOpenAIKey(homeDir),
		anthropicApiKey: discoverAnthropicKey(homeDir),
		openrouterApiKey: discoverOpenRouterKey(homeDir),
	};
}

/**
 * Populate process.env with discovered AI keys so every AIClient construction
 * (handlers read process.env directly) sees them, not just consumers of
 * getEnvConfig(). Explicit environment variables always win; discovery only
 * fills gaps. Never throws.
 */
export function applyDiscoveredAIKeys(homeDir: string = os.homedir()): void {
	if (!process.env.ANTHROPIC_API_KEY?.trim()) {
		const key = discoverAnthropicKey(homeDir);
		if (key) process.env.ANTHROPIC_API_KEY = key;
	}
	if (!process.env.OPENAI_API_KEY?.trim()) {
		const key = discoverOpenAIKey(homeDir);
		if (key) process.env.OPENAI_API_KEY = key;
	}
	if (!process.env.OPENROUTER_API_KEY?.trim()) {
		const key = discoverOpenRouterKey(homeDir);
		if (key) process.env.OPENROUTER_API_KEY = key;
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
		openaiApiKey: process.env.OPENAI_API_KEY?.trim() || discoverOpenAIKey(),
		anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || discoverAnthropicKey(),
		openrouterApiKey: process.env.OPENROUTER_API_KEY?.trim() || discoverOpenRouterKey(),
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
		hasAnthropicKey: !!config.anthropicApiKey,
		hasOpenrouterKey: !!config.openrouterApiKey,
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
	return FileUtils.existsWithContent(filePath, content);
}

async function detectPackageManagers(): Promise<string[]> {
	const managers = ['brew', 'apt-get', 'yum', 'dnf', 'zypper', 'pacman', 'apk', 'docker'];
	const available: string[] = [];

	// Use Promise.allSettled for better error handling and parallelization
	const results = await Promise.allSettled(
		managers.map(async (manager) => {
			if (await ProcessUtils.commandExists(manager)) {
				return manager;
			} else {
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
		if (!(await ProcessUtils.commandExists('sudo'))) {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}
