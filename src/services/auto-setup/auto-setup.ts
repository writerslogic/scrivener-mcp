/**
 * Main auto-setup orchestrator for AI services
 * Coordinates configuration of AI components (LangChain, etc.)
 * Note: Queue system now uses embedded storage, no Redis setup needed
 */

import { AIConfigWizard } from './ai-config-wizard.js';
import { initializeAsyncServices } from '../../handlers/async-handlers.js';
import { getLogger } from '../../core/logger.js';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import chalk from 'chalk';
import { readJSON, writeJSON } from '../../utils/common.js';

const logger = getLogger('auto-setup');

export interface SetupOptions {
	interactive?: boolean;
	skipAI?: boolean;
	quickSetup?: boolean;
	openaiApiKey?: string;
	anthropicApiKey?: string;
	force?: boolean;
}

export interface SetupResult {
	success: boolean;
	aiConfigured?: boolean;
	warnings?: string[];
	errors?: string[];
}

export class AutoSetup {
	private aiWizard: AIConfigWizard;
	private setupPath = join(homedir(), '.scrivener-mcp', 'setup.json');

	constructor() {
		this.aiWizard = new AIConfigWizard();
	}

	/**
	 * Check if setup has been completed before
	 */
	async isSetupComplete(): Promise<boolean> {
		if (existsSync(this.setupPath)) {
			try {
				const setup = await readJSON(this.setupPath, { completed: false });
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
	private async saveSetupStatus(status: Record<string, unknown>): Promise<void> {
		const dir = join(homedir(), '.scrivener-mcp');
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		await writeJSON(this.setupPath, status);
	}

	/**
	 * Run health checks
	 */
	async runHealthChecks(): Promise<{
		queue: boolean;
		ai: boolean;
		overall: boolean;
		details: string[];
	}> {
		const details: string[] = [];
		const queueHealthy = true; // Embedded queue is always available
		let aiHealthy = false;

		// Queue is always healthy with embedded system
		details.push('✅ Embedded queue system is ready');

		// Check AI configuration
		try {
			const aiConfig = this.aiWizard.getActiveConfig();
			aiHealthy = !!(
				aiConfig.openaiApiKey ||
				aiConfig.anthropicApiKey ||
				aiConfig.enableLocalModels
			);
			if (aiHealthy) {
				const providers = [];
				if (aiConfig.openaiApiKey) providers.push('OpenAI');
				if (aiConfig.anthropicApiKey) providers.push('Anthropic');
				if (aiConfig.enableLocalModels) providers.push('Local Models');
				details.push(`✅ AI configured: ${providers.join(', ')}`);
			} else {
				details.push('⚠️  AI services not configured (optional)');
			}
		} catch (error) {
			details.push(`⚠️  AI check failed: ${error}`);
		}

		return {
			queue: queueHealthy,
			ai: aiHealthy,
			overall: queueHealthy, // Queue is the only required component
			details,
		};
	}

	/**
	 * Run the auto-setup process
	 */
	async run(options: SetupOptions = {}): Promise<SetupResult> {
		const result: SetupResult = {
			success: true,
			warnings: [],
			errors: [],
		};

		logger.info('Starting auto-setup', { options });

		// Check if already completed and not forcing
		if ((await this.isSetupComplete()) && !options.force) {
			logger.info('Setup already completed, skipping');
			result.warnings?.push('Setup was already completed. Use --force to re-run.');
			return result;
		}

		try {
			// Step 1: Queue system is now embedded, no setup needed
			logger.info(chalk.green('✅ Queue system ready (embedded, no setup required)'));

			// Step 2: Configure AI services (optional)
			if (!options.skipAI) {
				logger.info(chalk.cyan('\n📊 Configuring AI services...'));

				if (options.quickSetup && options.openaiApiKey) {
					// Quick setup with provided key
					await this.aiWizard.quickSetup(options.openaiApiKey);
					result.aiConfigured = true;
					logger.info(chalk.green('✅ AI services configured with OpenAI'));
				} else if (options.interactive) {
					// Interactive wizard
					const aiConfig = await this.aiWizard.runWizard();
					result.aiConfigured = !!aiConfig;
					if (result.aiConfigured) {
						logger.info(chalk.green('✅ AI services configured'));
					}
				} else {
					// Check for existing configuration
					const existingConfig = this.aiWizard.getActiveConfig();
					if (existingConfig.openaiApiKey || existingConfig.anthropicApiKey) {
						result.aiConfigured = true;
						logger.info(chalk.green('✅ AI services already configured'));
					} else {
						result.warnings?.push(
							'AI services not configured. Run with --interactive to configure.'
						);
						logger.info(chalk.yellow('⚠️  AI services not configured (optional)'));
					}
				}
			}

			// Step 3: Initialize async services
			logger.info(chalk.cyan('\n🚀 Initializing services...'));
			await initializeAsyncServices({
				openaiApiKey: options.openaiApiKey,
			});
			logger.info(chalk.green('✅ Services initialized'));

			// Save setup status
			await this.saveSetupStatus({
				completed: true,
				timestamp: new Date().toISOString(),
				aiConfigured: result.aiConfigured,
			});

			// Final summary
			logger.info(chalk.green('\n✨ Setup completed successfully!'));
			logger.info(chalk.gray('\nYou can now use Scrivener MCP with:'));
			logger.info(chalk.cyan('  • Embedded queue system for async processing'));
			if (result.aiConfigured) {
				logger.info(chalk.cyan('  • AI-powered content analysis and generation'));
			}
			logger.info(chalk.gray('\nNo external services required!'));
		} catch (error) {
			logger.error('Setup failed', { error });
			result.success = false;
			result.errors?.push(`Setup failed: ${error}`);
			logger.info(chalk.red(`\n❌ Setup failed: ${error}`));
		}

		return result;
	}

	/**
	 * CLI entry point
	 */
	static async cli(args: string[] = []): Promise<void> {
		const setup = new AutoSetup();

		// Parse basic CLI arguments
		const options: SetupOptions = {
			interactive: args.includes('--interactive') || args.includes('-i'),
			skipAI: args.includes('--skip-ai'),
			quickSetup: args.includes('--quick'),
			force: args.includes('--force'),
		};

		// Look for API key in args
		const apiKeyIndex = args.findIndex((arg) => arg.startsWith('--openai-key='));
		if (apiKeyIndex >= 0) {
			options.openaiApiKey = args[apiKeyIndex].split('=')[1];
		}

		// Run setup
		const result = await setup.run(options);

		// Exit with appropriate code
		process.exit(result.success ? 0 : 1);
	}
}

// CLI execution
if (require.main === module) {
	AutoSetup.cli(process.argv.slice(2));
}
