/**
 * Main auto-setup orchestrator for BullMQ and LangChain
 * Coordinates installation and configuration of all components
 */

import { RedisInstaller } from './redis-installer.js';
import { AIConfigWizard } from './ai-config-wizard.js';
import { initializeAsyncServices } from '../../handlers/async-handlers.js';
import { getLogger } from '../../core/logger.js';
import { createError, ErrorCode } from '../../core/errors.js';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import chalk from 'chalk';

const logger = getLogger('auto-setup');

export interface SetupOptions {
	interactive?: boolean;
	skipRedis?: boolean;
	skipAI?: boolean;
	quickSetup?: boolean;
	openaiApiKey?: string;
	redisUrl?: string;
	force?: boolean;
}

export interface SetupResult {
	success: boolean;
	redisUrl?: string;
	aiConfigured?: boolean;
	warnings?: string[];
	errors?: string[];
}

export class AutoSetup {
	private redisInstaller: RedisInstaller;
	private aiWizard: AIConfigWizard;
	private setupPath = join(homedir(), '.scrivener-mcp', 'setup.json');

	constructor() {
		this.redisInstaller = new RedisInstaller();
		this.aiWizard = new AIConfigWizard();
	}

	/**
	 * Check if setup has been completed before
	 */
	isSetupComplete(): boolean {
		if (existsSync(this.setupPath)) {
			try {
				const setup = JSON.parse(readFileSync(this.setupPath, 'utf-8'));
				return setup.completed === true;
			} catch {
				return false;
			}
		}
		return false;
	}

	/**
	 * Save setup status
	 */
	private saveSetupStatus(status: any): void {
		const dir = join(homedir(), '.scrivener-mcp');
		if (!existsSync(dir)) {
			require('fs').mkdirSync(dir, { recursive: true });
		}
		writeFileSync(this.setupPath, JSON.stringify(status, null, 2));
	}

	/**
	 * Run health checks
	 */
	async runHealthChecks(): Promise<{
		redis: boolean;
		ai: boolean;
		overall: boolean;
		details: string[];
	}> {
		const details: string[] = [];
		let redisHealthy = false;
		let aiHealthy = false;

		// Check Redis
		try {
			redisHealthy = await this.redisInstaller.isRedisRunning();
			if (redisHealthy) {
				details.push('✅ Redis is running');
			} else {
				details.push('❌ Redis is not running');
			}
		} catch (error) {
			details.push(`❌ Redis check failed: ${error}`);
		}

		// Check AI configuration
		try {
			const aiConfig = this.aiWizard.getActiveConfig();
			aiHealthy = !!(aiConfig.openaiApiKey || aiConfig.anthropicApiKey || aiConfig.enableLocalModels);
			if (aiHealthy) {
				details.push('✅ AI services configured');
			} else {
				details.push('⚠️  No AI services configured');
			}
		} catch (error) {
			details.push(`❌ AI config check failed: ${error}`);
		}

		return {
			redis: redisHealthy,
			ai: aiHealthy,
			overall: redisHealthy && aiHealthy,
			details,
		};
	}

	/**
	 * Display setup banner
	 */
	private displayBanner(): void {
		console.log(chalk.cyan('\n╔═══════════════════════════════════════════════════════╗'));
		console.log(chalk.cyan('║') + chalk.white.bold('     Scrivener MCP - Advanced Features Setup          ') + chalk.cyan('║'));
		console.log(chalk.cyan('║') + chalk.gray('     BullMQ Job Queues + LangChain AI Integration     ') + chalk.cyan('║'));
		console.log(chalk.cyan('╚═══════════════════════════════════════════════════════╝\n'));
	}

	/**
	 * Display progress
	 */
	private displayProgress(step: string, status: 'pending' | 'running' | 'done' | 'error'): void {
		const icons = {
			pending: '⏳',
			running: '🔄',
			done: '✅',
			error: '❌',
		};

		const colors = {
			pending: chalk.gray,
			running: chalk.yellow,
			done: chalk.green,
			error: chalk.red,
		};

		console.log(colors[status](`${icons[status]} ${step}`));
	}

	/**
	 * Setup Redis
	 */
	private async setupRedis(options: SetupOptions): Promise<string | undefined> {
		if (options.skipRedis) {
			logger.info('Skipping Redis setup');
			return undefined;
		}

		this.displayProgress('Setting up Redis for job queuing', 'running');

		try {
			// Use provided URL or auto-setup
			let redisUrl: string;
			
			if (options.redisUrl) {
				redisUrl = options.redisUrl;
				logger.info('Using provided Redis URL');
			} else {
				redisUrl = await this.redisInstaller.autoSetup();
			}

			// Test connection
			if (await this.redisInstaller.testConnection()) {
				this.displayProgress('Redis setup complete', 'done');
				return redisUrl;
			} else {
				throw new Error('Redis connection test failed');
			}
		} catch (error) {
			this.displayProgress('Redis setup failed', 'error');
			logger.error('Redis setup error', { error });
			
			if (!options.interactive) {
				throw error;
			}

			console.log(chalk.yellow('\n⚠️  Redis setup failed. You can:'));
			console.log('  1. Install Redis manually and restart');
			console.log('  2. Use Docker: docker run -d -p 6379:6379 redis');
			console.log('  3. Continue without job queue features\n');

			return undefined;
		}
	}

	/**
	 * Setup AI configuration
	 */
	private async setupAI(options: SetupOptions): Promise<boolean> {
		if (options.skipAI) {
			logger.info('Skipping AI setup');
			return false;
		}

		this.displayProgress('Configuring AI services', 'running');

		try {
			if (options.quickSetup && options.openaiApiKey) {
				// Quick setup with provided key
				await this.aiWizard.quickSetup(options.openaiApiKey);
				this.displayProgress('AI configuration complete', 'done');
				return true;
			} else if (options.interactive) {
				// Run interactive wizard
				await this.aiWizard.runWizard();
				this.displayProgress('AI configuration complete', 'done');
				return true;
			} else {
				// Check for existing configuration
				const config = this.aiWizard.getActiveConfig();
				if (config.openaiApiKey || config.anthropicApiKey || config.enableLocalModels) {
					this.displayProgress('AI configuration found', 'done');
					return true;
				} else {
					this.displayProgress('No AI configuration found', 'error');
					return false;
				}
			}
		} catch (error) {
			this.displayProgress('AI setup failed', 'error');
			logger.error('AI setup error', { error });
			return false;
		}
	}

	/**
	 * Main auto-setup process
	 */
	async run(options: SetupOptions = {}): Promise<SetupResult> {
		const result: SetupResult = {
			success: false,
			warnings: [],
			errors: [],
		};

		// Check if already setup
		if (!options.force && this.isSetupComplete()) {
			logger.info('Setup already complete');
			const health = await this.runHealthChecks();
			
			if (health.overall) {
				console.log(chalk.green('\n✅ All services are running correctly!\n'));
				result.success = true;
				return result;
			} else {
				console.log(chalk.yellow('\n⚠️  Some services need attention:\n'));
				health.details.forEach(d => console.log('  ' + d));
				console.log('\nRe-running setup...\n');
			}
		}

		// Display banner
		if (options.interactive) {
			this.displayBanner();
		}

		logger.info('Starting auto-setup process', { options });

		try {
			// Step 1: Setup Redis
			const redisUrl = await this.setupRedis(options);
			if (redisUrl) {
				result.redisUrl = redisUrl;
			} else if (!options.skipRedis) {
				result.warnings?.push('Redis setup skipped - job queue features will be unavailable');
			}

			// Step 2: Setup AI Configuration
			const aiConfigured = await this.setupAI(options);
			if (aiConfigured) {
				result.aiConfigured = true;
			} else if (!options.skipAI) {
				result.warnings?.push('AI setup skipped - LangChain features will be unavailable');
			}

			// Step 3: Initialize services
			this.displayProgress('Initializing async services', 'running');
			
			try {
				await initializeAsyncServices({
					redisUrl: result.redisUrl,
					openaiApiKey: this.aiWizard.getActiveConfig().openaiApiKey,
				});
				this.displayProgress('Services initialized', 'done');
			} catch (error) {
				this.displayProgress('Service initialization failed', 'error');
				result.warnings?.push('Some services failed to initialize');
			}

			// Step 4: Run health checks
			const health = await this.runHealthChecks();
			
			if (options.interactive) {
				console.log(chalk.cyan('\n━━━ Health Check Results ━━━'));
				health.details.forEach(d => console.log('  ' + d));
			}

			// Save setup status
			this.saveSetupStatus({
				completed: true,
				timestamp: new Date().toISOString(),
				redisConfigured: !!result.redisUrl,
				aiConfigured: result.aiConfigured,
				health: health,
			});

			result.success = health.overall || (result.warnings?.length || 0) > 0;

			// Display summary
			if (options.interactive) {
				this.displaySummary(result);
			}

		} catch (error) {
			logger.error('Setup failed', { error });
			result.errors?.push(error instanceof Error ? error.message : 'Unknown error');
			result.success = false;
		}

		return result;
	}

	/**
	 * Display setup summary
	 */
	private displaySummary(result: SetupResult): void {
		console.log(chalk.cyan('\n╔═══════════════════════════════════════════════════════╗'));
		console.log(chalk.cyan('║') + chalk.white.bold('                   Setup Summary                       ') + chalk.cyan('║'));
		console.log(chalk.cyan('╚═══════════════════════════════════════════════════════╝\n'));

		if (result.success) {
			console.log(chalk.green.bold('✅ Setup completed successfully!\n'));
		} else {
			console.log(chalk.red.bold('❌ Setup completed with errors\n'));
		}

		if (result.redisUrl) {
			console.log(chalk.green(`  ✓ Redis: ${result.redisUrl}`));
		}

		if (result.aiConfigured) {
			console.log(chalk.green('  ✓ AI Services: Configured'));
		}

		if (result.warnings && result.warnings.length > 0) {
			console.log(chalk.yellow('\nWarnings:'));
			result.warnings.forEach(w => console.log(chalk.yellow(`  ⚠️  ${w}`)));
		}

		if (result.errors && result.errors.length > 0) {
			console.log(chalk.red('\nErrors:'));
			result.errors.forEach(e => console.log(chalk.red(`  ❌ ${e}`)));
		}

		console.log(chalk.cyan('\n━━━ Next Steps ━━━'));
		console.log('  1. Start the MCP server: npm start');
		console.log('  2. Use the new tools in your MCP client');
		console.log('  3. Check the documentation: LANGCHAIN_BULLMQ_USAGE.md\n');
	}

	/**
	 * CLI entry point
	 */
	static async cli(args: string[] = []): Promise<void> {
		const setup = new AutoSetup();
		
		// Parse CLI arguments
		const options: SetupOptions = {
			interactive: true,
			quickSetup: args.includes('--quick'),
			skipRedis: args.includes('--skip-redis'),
			skipAI: args.includes('--skip-ai'),
			force: args.includes('--force'),
		};

		// Look for API key in args
		const apiKeyIndex = args.indexOf('--openai-key');
		if (apiKeyIndex !== -1 && args[apiKeyIndex + 1]) {
			options.openaiApiKey = args[apiKeyIndex + 1];
		}

		// Look for Redis URL in args
		const redisIndex = args.indexOf('--redis-url');
		if (redisIndex !== -1 && args[redisIndex + 1]) {
			options.redisUrl = args[redisIndex + 1];
		}

		// Run setup
		const result = await setup.run(options);
		
		// Exit with appropriate code
		process.exit(result.success ? 0 : 1);
	}
}

// Export for CLI usage
export default AutoSetup;