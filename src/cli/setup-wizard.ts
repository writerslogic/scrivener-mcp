#!/usr/bin/env node
/**
 * Interactive Setup Wizard
 * Guides users through database installation and configuration
 */

import chalk from 'chalk';
import * as readline from 'readline/promises';
import { Neo4jAutoInstaller } from '../database/auto-installer.js';
import { DatabaseSetup } from '../database/database-setup.js';
import { AutoSetup } from '../services/auto-setup/auto-setup.js';
import { KeyDBInstaller } from '../services/auto-setup/keydb-installer.js';

export class SetupWizard {
	private rl: readline.Interface;

	constructor() {
		this.rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});
	}

	/**
	 * Run the setup wizard
	 */
	async run(): Promise<void> {
		console.clear();
		this.printBanner();

		// Offer setup options
		console.log(chalk.yellow('\nChoose setup type:'));
		console.log(chalk.cyan('  1. Quick Setup (All features with auto-detection)'));
		console.log(chalk.cyan('  2. Basic Setup (Neo4j database only)'));
		console.log(chalk.cyan('  3. KeyDB Setup (High-performance queues)'));
		console.log(chalk.cyan('  4. Advanced Setup (Custom configuration)'));
		console.log(chalk.cyan('  5. Check system health'));
		console.log(chalk.cyan('  6. Exit'));

		const choice = await this.askQuestion('\nSelect option (1-6): ');

		switch (choice) {
			case '1':
				await this.runQuickSetup();
				break;
			case '2':
				await this.runBasicSetup();
				break;
			case '3':
				await this.runKeyDBSetup();
				break;
			case '4':
				await this.runAdvancedSetup();
				break;
			case '5':
				await this.checkHealth();
				break;
			case '6':
			default:
				console.log(chalk.gray('\nSetup cancelled.'));
				this.rl.close();
				return;
		}

		this.rl.close();
	}

	/**
	 * Run quick setup with all features
	 */
	private async runQuickSetup(): Promise<void> {
		console.log(chalk.bold.cyan('\n🚀 Quick Setup - All Features\n'));

		console.log('This will automatically install and configure:');
		console.log(chalk.cyan('  • KeyDB (high-performance job queues)'));
		console.log(chalk.cyan('  • Neo4j (graph database for relationships)'));
		console.log(chalk.cyan('  • All required dependencies'));
		console.log(chalk.cyan('  • Optimal configuration settings\n'));

		const proceed = await this.askYesNo('Continue with automatic setup?');
		if (!proceed) {
			console.log(chalk.gray('\nSetup cancelled.'));
			return;
		}

		// Install KeyDB first
		console.log(chalk.blue('\n📦 Installing KeyDB...\n'));
		const keydbInstaller = await KeyDBInstaller.getInstance();
		const keydbResult = await keydbInstaller.autoInstall({ startService: true });

		if (keydbResult.success) {
			console.log(chalk.green(`✅ ${keydbResult.message}`));
		} else {
			console.log(chalk.yellow(`⚠️ KeyDB installation: ${keydbResult.message}`));
			console.log(chalk.gray('   Scrivener MCP will use embedded queue as fallback'));
		}

		// Install Neo4j
		console.log(chalk.blue('\n📦 Installing Neo4j...\n'));
		const neo4jResult = await Neo4jAutoInstaller.install({
			method: 'auto',
			interactive: false,
			projectPath: './data',
			autoStart: true,
		});

		if (neo4jResult.success) {
			console.log(chalk.green(`✅ ${neo4jResult.message}`));
		} else {
			console.log(chalk.yellow(`⚠️ Neo4j installation: ${neo4jResult.message}`));
			console.log(chalk.gray('   Scrivener MCP will use SQLite-only mode'));
		}

		// Summary
		console.log(chalk.bold.green('\n🎉 Quick Setup Complete!\n'));
		console.log('Your Scrivener MCP installation includes:');
		if (keydbResult.success) {
			console.log(chalk.green('  ✅ KeyDB - High-performance job processing'));
		} else {
			console.log(chalk.yellow('  ⚪ Embedded queue - Basic job processing'));
		}
		if (neo4jResult.success) {
			console.log(chalk.green('  ✅ Neo4j - Advanced graph analytics'));
		} else {
			console.log(chalk.yellow('  ⚪ SQLite - Basic data storage'));
		}
		console.log(chalk.green('  ✅ All core features ready\n'));

		console.log(chalk.cyan('Start using Scrivener MCP with: npm start'));
	}

	/**
	 * Run KeyDB-specific setup
	 */
	private async runKeyDBSetup(): Promise<void> {
		console.log(chalk.bold.cyan('\n🚀 KeyDB Setup - High-Performance Queues\n'));

		console.log('KeyDB provides:');
		console.log(chalk.cyan('  • Multi-threaded Redis-compatible server (2-5x faster)'));
		console.log(chalk.cyan('  • Advanced job queue processing with BullMQ'));
		console.log(chalk.cyan('  • Intelligent query caching for SQLite'));
		console.log(chalk.cyan('  • Seamless fallback if unavailable\n'));

		const keydbInstaller = await KeyDBInstaller.getInstance();

		// Check current status
		const status = await keydbInstaller.checkAvailability();

		if (status.running) {
			console.log(chalk.green('✅ KeyDB is already running!'));
			console.log(
				chalk.gray(`   Version: ${status.version}, Port: ${status.port || 6379}\n`)
			);
			console.log(chalk.cyan('Your Scrivener MCP is ready for high-performance operations.'));
			return;
		}

		if (status.installed) {
			console.log(chalk.yellow('⚪ KeyDB is installed but not running.'));
			const start = await this.askYesNo('Would you like to start KeyDB now?');

			if (start) {
				console.log(chalk.blue('Starting KeyDB service...\n'));
				const started = await keydbInstaller.startKeyDB();

				if (started) {
					console.log(chalk.green('✅ KeyDB started successfully!'));
				} else {
					console.log(chalk.red('❌ Failed to start KeyDB automatically.'));
					console.log(chalk.gray('Try running manually: keydb-server --daemonize yes'));
				}
				return;
			}
		}

		// Installation needed
		console.log(chalk.yellow('⚠️ KeyDB is not installed.\n'));

		const install = await this.askYesNo('Would you like to install KeyDB now?');

		if (!install) {
			console.log(chalk.gray('\nKeyDB setup cancelled.'));
			console.log(chalk.gray('Scrivener MCP will use embedded queue as fallback.'));
			return;
		}

		// Choose installation method
		console.log(chalk.yellow('\nChoose installation method:'));
		console.log(chalk.cyan('  1. Automatic (recommended)'));
		console.log(chalk.cyan('  2. Homebrew (macOS)'));
		console.log(chalk.cyan('  3. Docker (cross-platform)'));
		console.log(chalk.cyan('  4. Show manual instructions'));

		const method = await this.askQuestion('Select method (1-4): ');

		switch (method) {
			case '1':
			case '':
				console.log(chalk.blue('\n📦 Installing KeyDB automatically...\n'));
				const result = await keydbInstaller.autoInstall({ startService: true });

				if (result.success) {
					console.log(chalk.green(`✅ ${result.message}`));
					console.log(chalk.green(`   Method: ${result.method}`));
					if (result.version) {
						console.log(chalk.green(`   Version: ${result.version}`));
					}
				} else {
					console.log(chalk.red(`❌ Installation failed: ${result.message}`));
					console.log(chalk.yellow('\nTry manual installation or use embedded queue.'));
				}
				break;

			case '2':
				console.log(chalk.blue('\n📦 Installing via Homebrew...\n'));
				const homebrewResult = await keydbInstaller.autoInstall({
					method: 'homebrew',
					startService: true,
				});
				console.log(
					homebrewResult.success
						? chalk.green(`✅ ${homebrewResult.message}`)
						: chalk.red(`❌ ${homebrewResult.message}`)
				);
				break;

			case '3':
				console.log(chalk.blue('\n📦 Installing via Docker...\n'));
				const dockerResult = await keydbInstaller.autoInstall({
					method: 'docker',
					startService: true,
				});
				console.log(
					dockerResult.success
						? chalk.green(`✅ ${dockerResult.message}`)
						: chalk.red(`❌ ${dockerResult.message}`)
				);
				break;

			case '4':
				console.log(chalk.blue('\n📋 Manual Installation Instructions:'));
				console.log(chalk.gray(keydbInstaller.getManualInstructions()));
				break;

			default:
				console.log(chalk.gray('\nInvalid selection. Setup cancelled.'));
		}
	}

	/**
	 * Run basic Neo4j setup
	 */
	private async runBasicSetup(): Promise<void> {
		// Check current status
		const status = await DatabaseSetup.checkNeo4jAvailability();

		if (status.running) {
			console.log(chalk.green('\n✅ Neo4j is already installed and running!'));
			console.log(chalk.gray('You can start using Scrivener MCP with full features.\n'));
			return;
		}

		// Offer installation options
		console.log(chalk.yellow('\n⚠️  Neo4j is not currently running.'));
		console.log('\nNeo4j provides advanced features like:');
		console.log(chalk.cyan('  • Character relationship visualization'));
		console.log(chalk.cyan('  • Story structure analysis'));
		console.log(chalk.cyan('  • Plot complexity tracking'));
		console.log(chalk.cyan('  • Writing productivity analytics'));

		const install = await this.askYesNo('\nWould you like to install Neo4j now?');

		if (!install) {
			console.log(
				chalk.gray('\nYou can run this setup again anytime with: npx scrivener-setup')
			);
			this.rl.close();
			return;
		}

		// Choose installation method
		const method = await this.chooseInstallMethod(status);

		// Get project path
		const projectPath = await this.askQuestion(
			'Enter your Scrivener project path (or press Enter for current directory): ',
			process.cwd()
		);

		// Perform installation
		console.log(chalk.blue('\n🚀 Starting installation...\n'));

		const result = await Neo4jAutoInstaller.install({
			method,
			interactive: false,
			projectPath,
			autoStart: true,
		});

		if (result.success) {
			console.log(chalk.green('\n✅ Installation completed successfully!'));
			console.log(chalk.gray('\nNeo4j credentials have been saved to your project.'));
			console.log(chalk.gray('You can now use Scrivener MCP with full features.\n'));

			// Offer to test connection
			const test = await this.askYesNo('Would you like to test the Neo4j connection?');
			if (test) {
				await this.testConnection(result.credentials!);
			}
		} else {
			console.log(chalk.red('\n❌ Installation failed.'));
			console.log(chalk.gray(result.message));
			console.log(chalk.gray('\nYou can try manual installation:'));
			console.log(DatabaseSetup.getSetupInstructions());
		}

		this.rl.close();
	}

	/**
	 * Print welcome banner
	 */
	private printBanner(): void {
		console.log(chalk.bold.blue('╔════════════════════════════════════════╗'));
		console.log(chalk.bold.blue('║     Scrivener MCP Setup Wizard         ║'));
		console.log(chalk.bold.blue('╚════════════════════════════════════════╝'));
		console.log(chalk.gray('Version 1.0.0'));
	}

	/**
	 * Ask a yes/no question
	 */
	private async askYesNo(question: string): Promise<boolean> {
		const answer = await this.rl.question(chalk.yellow(`${question} (yes/no): `));
		return answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y';
	}

	/**
	 * Ask a question with optional default
	 */
	private async askQuestion(question: string, defaultValue?: string): Promise<string> {
		const answer = await this.rl.question(chalk.yellow(question));
		return answer || defaultValue || '';
	}

	/**
	 * Choose installation method
	 */
	private async chooseInstallMethod(
		status: any
	): Promise<'docker' | 'homebrew' | 'native' | 'auto'> {
		const options: string[] = ['auto (recommended)'];

		if (status.dockerAvailable) {
			options.push('docker');
		}
		if (status.homebrewAvailable) {
			options.push('homebrew');
		}
		options.push('native');

		console.log(chalk.yellow('\nAvailable installation methods:'));
		options.forEach((opt, i) => {
			console.log(chalk.cyan(`  ${i + 1}. ${opt}`));
		});

		const choice = await this.askQuestion(`\nSelect method (1-${options.length}): `);
		const index = parseInt(choice) - 1;

		if (index >= 0 && index < options.length) {
			const selected = options[index];
			if (selected.startsWith('auto')) return 'auto';
			return selected as any;
		}

		return 'auto';
	}

	/**
	 * Run advanced setup with AI services
	 */
	private async runAdvancedSetup(): Promise<void> {
		console.log(chalk.bold.cyan('\n🚀 Advanced Setup - AI Integration\n'));

		console.log('This will set up:');
		console.log(chalk.cyan('  • Embedded queue system (automatic)'));
		console.log(chalk.cyan('  • AI services configuration (LangChain)'));
		console.log(chalk.cyan('  • Neo4j graph database'));
		console.log(chalk.cyan('  • All required dependencies\n'));

		const confirm = await this.askYesNo('Continue with advanced setup?');
		if (!confirm) {
			console.log(chalk.gray('\nSetup cancelled.'));
			return;
		}

		// Run the auto-setup
		const autoSetup = new AutoSetup();
		const result = await autoSetup.run({
			interactive: true,
			quickSetup: false,
			force: false,
		});

		if (result.success) {
			console.log(chalk.green('\n✅ Advanced setup completed successfully!'));
			console.log(chalk.gray('All features are now available.\n'));
		} else {
			console.log(chalk.red('\n⚠️  Setup completed with some issues.'));
			if (result.warnings && result.warnings.length > 0) {
				console.log(chalk.yellow('\nWarnings:'));
				result.warnings.forEach((w) => console.log(chalk.yellow(`  • ${w}`)));
			}
			if (result.errors && result.errors.length > 0) {
				console.log(chalk.red('\nErrors:'));
				result.errors.forEach((e) => console.log(chalk.red(`  • ${e}`)));
			}
		}
	}

	/**
	 * Check system health
	 */
	private async checkHealth(): Promise<void> {
		console.log(chalk.bold.cyan('\n🔍 System Health Check\n'));

		// Check Neo4j
		const neo4jStatus = await DatabaseSetup.checkNeo4jAvailability();
		if (neo4jStatus.running) {
			console.log(chalk.green('✅ Neo4j: Running'));
		} else {
			console.log(chalk.red('❌ Neo4j: Not running'));
		}

		// Check queue and AI services
		const autoSetup = new AutoSetup();
		const health = await autoSetup.runHealthChecks();

		console.log(
			health.queue
				? chalk.green('✅ Queue: Ready (embedded)')
				: chalk.red('❌ Queue: Not ready')
		);
		console.log(
			health.ai
				? chalk.green('✅ AI Services: Configured')
				: chalk.yellow('⚠️  AI Services: Not configured')
		);

		// Overall status
		console.log(chalk.cyan('\n━━━ Overall Status ━━━'));
		if (neo4jStatus.running && health.overall) {
			console.log(chalk.green('All systems operational! 🎉'));
		} else if (neo4jStatus.running || health.queue) {
			console.log(
				chalk.yellow('Some services are running. Run setup to configure missing services.')
			);
		} else {
			console.log(chalk.red('No services are running. Run setup to get started.'));
		}

		console.log(chalk.gray('\nRun setup option 1 or 2 to configure missing services.'));
	}

	/**
	 * Test Neo4j connection
	 */
	private async testConnection(credentials: any): Promise<void> {
		try {
			console.log(chalk.blue('\n🔌 Testing connection...'));

			const neo4j = await import('neo4j-driver');
			const driver = neo4j.default.driver(
				credentials.uri,
				neo4j.default.auth.basic(credentials.user, credentials.password)
			);

			await driver.verifyConnectivity();
			const session = driver.session();
			const result = await session.run('RETURN "Connection successful!" as message');
			await session.close();
			await driver.close();

			console.log(chalk.green(`✅ ${result.records[0].get('message')}`));
		} catch (error) {
			console.log(chalk.red('❌ Connection test failed:'));
			console.log(chalk.gray((error as Error).message));
		}
	}
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
	const wizard = new SetupWizard();
	wizard.run().catch(console.error);
}
