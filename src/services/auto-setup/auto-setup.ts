/**
 * Main auto-setup orchestrator for AI services
 * Coordinates configuration of AI components
 * Note: Queue system now uses embedded storage, no Redis setup needed
 */

import { AIConfigWizard } from './ai-config-wizard.js';
import { initializeAsyncServices } from '../../handlers/async-handlers.js';
import { getLogger } from '../../core/logger.js';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { styleText } from 'node:util';
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

	private async saveSetupStatus(status: Record<string, unknown>): Promise<void> {
		const dir = join(homedir(), '.scrivener-mcp');
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		await writeJSON(this.setupPath, status);
	}

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

		try {
			const aiConfig = await this.aiWizard.getActiveConfig();
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
			logger.info(
				styleText('green', '✅ Queue system ready (embedded, no setup required)', {
					stream: process.stderr,
				})
			);

			// Step 2: Configure AI services (optional)
			if (!options.skipAI) {
				logger.info(
					styleText('cyan', '\n📊 Configuring AI services...', { stream: process.stderr })
				);

				if (options.quickSetup && options.openaiApiKey) {
					// Quick setup with provided key
					await this.aiWizard.quickSetup(options.openaiApiKey);
					result.aiConfigured = true;
					logger.info(
						styleText('green', '✅ AI services configured with OpenAI', {
							stream: process.stderr,
						})
					);
				} else if (options.interactive) {
					// Interactive wizard
					const aiConfig = await this.aiWizard.runWizard();
					result.aiConfigured = !!aiConfig;
					if (result.aiConfigured) {
						logger.info(
							styleText('green', '✅ AI services configured', {
								stream: process.stderr,
							})
						);
					}
				} else {
					const existingConfig = await this.aiWizard.getActiveConfig();
					if (existingConfig.openaiApiKey || existingConfig.anthropicApiKey) {
						result.aiConfigured = true;
						logger.info(
							styleText('green', '✅ AI services already configured', {
								stream: process.stderr,
							})
						);
					} else {
						result.warnings?.push(
							'AI services not configured. Run with --interactive to configure.'
						);
						logger.info(
							styleText('yellow', '⚠️  AI services not configured (optional)', {
								stream: process.stderr,
							})
						);
					}
				}
			}

			// Step 3: Initialize async services
			logger.info(
				styleText('cyan', '\n🚀 Initializing services...', { stream: process.stderr })
			);
			await initializeAsyncServices({
				openaiApiKey: options.openaiApiKey,
			});
			logger.info(styleText('green', '✅ Services initialized', { stream: process.stderr }));

			await this.saveSetupStatus({
				completed: true,
				timestamp: new Date().toISOString(),
				aiConfigured: result.aiConfigured,
			});

			// Final summary
			logger.info(
				styleText('green', '\n✨ Setup completed successfully!', { stream: process.stderr })
			);
			logger.info(
				styleText('gray', '\nYou can now use Scrivener MCP with:', {
					stream: process.stderr,
				})
			);
			logger.info(
				styleText('cyan', '  • Embedded queue system for async processing', {
					stream: process.stderr,
				})
			);
			if (result.aiConfigured) {
				logger.info(
					styleText('cyan', '  • AI-powered content analysis and generation', {
						stream: process.stderr,
					})
				);
			}
			logger.info(
				styleText('gray', '\nNo external services required!', { stream: process.stderr })
			);
		} catch (error) {
			logger.error('Setup failed', { error });
			result.success = false;
			result.errors?.push(`Setup failed: ${error}`);
			logger.info(
				styleText('red', `\n❌ Setup failed: ${error}`, { stream: process.stderr })
			);
		}

		return result;
	}

	/**
	 * CLI entry point
	 */
	static async cli(args: string[] = []): Promise<void> {
		const setup = new AutoSetup();

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

		const result = await setup.run(options);

		// Exit with appropriate code
		process.exit(result.success ? 0 : 1);
	}
}
