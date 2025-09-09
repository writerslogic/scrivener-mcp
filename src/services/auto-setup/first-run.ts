/**
 * First-run detection and initialization
 * Automatically prompts for setup on first use if not configured
 */

import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getLogger } from '../../core/logger.js';
import { AutoSetup } from './auto-setup.js';
import { readJSON } from '../../utils/common.js';

const logger = getLogger('first-run');

export interface FirstRunConfig {
	skipSetup?: boolean;
	quietMode?: boolean;
	useDefaults?: boolean;
}

export class FirstRunManager {
	private configDir = join(homedir(), '.scrivener-mcp');
	private setupPath = join(this.configDir, 'setup.json');
	private firstRunPath = join(this.configDir, '.first-run-complete');

	/**
	 * Check if this is the first run
	 */
	isFirstRun(): boolean {
		return !existsSync(this.firstRunPath);
	}

	/**
	 * Check if setup has been completed
	 */
	async isSetupComplete(): Promise<boolean> {
		if (!existsSync(this.setupPath)) {
			return false;
		}

		try {
			const setup = (await readJSON(this.setupPath, {})) as any;
			return setup.completed === true && setup.features;
		} catch {
			return false;
		}
	}

	/**
	 * Get current feature status
	 */
	getFeatureStatus(): {
		basic: boolean;
		neo4j: boolean;
		redis: boolean;
		ai: boolean;
	} {
		const defaultStatus = {
			basic: true,
			neo4j: false,
			redis: false,
			ai: false,
		};

		if (!existsSync(this.setupPath)) {
			return defaultStatus;
		}

		try {
			const setup = JSON.parse(readFileSync(this.setupPath, 'utf-8'));
			return {
				basic: true,
				neo4j: setup.features?.neo4j || false,
				redis: setup.features?.redis || false,
				ai: setup.features?.ai || false,
			};
		} catch {
			return defaultStatus;
		}
	}

	/**
	 * Initialize on first run
	 */
	async initialize(config: FirstRunConfig = {}): Promise<void> {
		// Skip if explicitly disabled
		if (config.skipSetup || process.env.SCRIVENER_SKIP_SETUP === 'true') {
			logger.info('Skipping first-run setup');
			return;
		}

		// Check if this is first run
		if (!this.isFirstRun()) {
			// Not first run, but check if features are missing
			const status = this.getFeatureStatus();

			if (!status.redis && !status.ai) {
				logger.info('Advanced features not configured');

				if (!config.quietMode) {
					console.log('\n💡 Tip: Run "npm run setup" to enable advanced features:');
					console.log('   • Redis job queuing for async processing');
					console.log('   • AI-powered writing assistance');
					console.log('   • Semantic search across manuscripts\n');
				}
			}
			return;
		}

		logger.info('First run detected');

		// If in quiet mode or using defaults, do minimal setup
		if (config.quietMode || config.useDefaults) {
			await this.minimalSetup();
			return;
		}

		// Check if we're in an interactive terminal
		if (!process.stdin.isTTY) {
			logger.info('Non-interactive environment, skipping setup prompt');
			await this.minimalSetup();
			return;
		}

		// Prompt for setup
		console.log('\n🎉 Welcome to Scrivener MCP!');
		console.log('─'.repeat(40));
		console.log('\nThis appears to be your first time running the application.');
		console.log('Would you like to set up advanced features?\n');
		console.log('Available features:');
		console.log('  • Neo4j graph database for relationships');
		console.log('  • Redis + BullMQ for background processing');
		console.log('  • LangChain AI integration for writing assistance\n');

		// Import readline for prompt
		const readline = await import('readline/promises');
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});

		try {
			const answer = await rl.question('Set up advanced features now? (yes/no): ');
			rl.close();

			if (answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y') {
				// Run auto-setup
				const autoSetup = new AutoSetup();
				await autoSetup.run({
					interactive: true,
					quickSetup: false,
				});
			} else {
				console.log('\n✓ Basic features enabled.');
				console.log('You can run "npm run setup" anytime to add advanced features.\n');
				await this.minimalSetup();
			}
		} catch (error) {
			logger.error('Setup prompt failed', { error });
			rl.close();
			await this.minimalSetup();
		}

		// Mark first run as complete
		this.markFirstRunComplete();
	}

	/**
	 * Minimal setup for non-interactive environments
	 */
	private async minimalSetup(): Promise<void> {
		logger.info('Performing minimal setup');

		// Create config directory if needed
		if (!existsSync(this.configDir)) {
			const { mkdirSync } = await import('fs');
			mkdirSync(this.configDir, { recursive: true });
		}

		// Create minimal setup.json
		if (!existsSync(this.setupPath)) {
			const { writeFileSync } = await import('fs');
			const minimalSetup = {
				version: '0.3.2',
				timestamp: new Date().toISOString(),
				setupType: 'minimal',
				completed: true,
				features: {
					sqlite: true,
					neo4j: false,
					redis: false,
					ai: false,
				},
			};
			// Using sync version for compatibility
			writeFileSync(this.setupPath, JSON.stringify(minimalSetup, null, 2));
		}

		this.markFirstRunComplete();
	}

	/**
	 * Mark first run as complete
	 */
	private markFirstRunComplete(): void {
		writeFileSync(this.firstRunPath, new Date().toISOString());
		logger.info('First run complete');
	}

	/**
	 * Reset first run status (for testing)
	 */
	resetFirstRun(): void {
		if (existsSync(this.firstRunPath)) {
			unlinkSync(this.firstRunPath);
		}

		logger.info('First run status reset');
	}
}
