#!/usr/bin/env node
/**
 * Interactive Setup Wizard
 * Guides users through database installation and configuration
 */

import { styleText } from 'node:util';
import * as path from 'path';
import * as readline from 'readline/promises';
import { Neo4jAutoInstaller } from '../handlers/database/auto-installer.js';
import { DatabaseSetup } from '../handlers/database/database-setup.js';
import { AutoSetup } from '../services/auto-setup/auto-setup.js';
import { KeyDBInstaller } from '../services/auto-setup/keydb-installer.js';
import {
	handleError,
	withErrorHandling,
	validateInput,
	sanitizePath,
	buildPath,
	pathExists,
	measureExecution,
	formatDuration,
	AppError,
	ErrorCode,
} from '../utils/common.js';
import { OperationMetricsTracker, measureAndTrackOperation } from '../utils/operation-metrics.js';

export class SetupWizard {
	private rl: readline.Interface;
	private metricsTracker: OperationMetricsTracker;

	constructor() {
		this.rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		this.metricsTracker = new OperationMetricsTracker((message, meta) => {
			console.log(styleText('gray', `[METRICS] ${message}`), meta);
		});
	}

	async run(): Promise<void> {
		const wrappedFunction = withErrorHandling(async () => {
			console.clear();
			this.printBanner();

			// Offer setup options
			console.log(styleText('yellow', '\nChoose setup type:'));
			console.log(styleText('cyan', '  1. Quick Setup (All features with auto-detection)'));
			console.log(styleText('cyan', '  2. Basic Setup (Neo4j database only)'));
			console.log(styleText('cyan', '  3. KeyDB Setup (High-performance queues)'));
			console.log(styleText('cyan', '  4. Advanced Setup (Custom configuration)'));
			console.log(styleText('cyan', '  5. Check system health'));
			console.log(styleText('cyan', '  6. Exit'));

			const choice = await this.askQuestion(
				'\nSelect option (1-6): ',
				undefined,
				(input: string) => /^[1-6]$/.test(input),
				'Please enter a number between 1 and 6.'
			);

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
					console.log(styleText('gray', '\nSetup cancelled.'));
					this.rl.close();
					return;
			}

			// Show metrics summary
			this.showMetricsSummary();
			this.rl.close();
		}, 'SetupWizard.run');

		await wrappedFunction();
	}

	private async runQuickSetup(): Promise<void> {
		const wrappedFunction = withErrorHandling(async () => {
			return measureAndTrackOperation(
				'quickSetup',
				async () => {
					console.log(styleText(['bold', 'cyan'], '\n🚀 Quick Setup - All Features\n'));

					console.log('This will automatically install and configure:');
					console.log(styleText('cyan', '  • KeyDB (high-performance job queues)'));
					console.log(styleText('cyan', '  • Neo4j (graph database for relationships)'));
					console.log(styleText('cyan', '  • All required dependencies'));
					console.log(styleText('cyan', '  • Optimal configuration settings\n'));

					const proceed = await this.askYesNo('Continue with automatic setup?');
					if (!proceed) {
						console.log(styleText('gray', '\nSetup cancelled.'));
						return;
					}

					// Install KeyDB first
					console.log(styleText('blue', '\n📦 Installing KeyDB...\n'));
					const keydbInstaller = await KeyDBInstaller.getInstance();
					const keydbResult = await keydbInstaller.autoInstall({ startService: true });

					if (keydbResult.success) {
						console.log(styleText('green', `✅ ${keydbResult.message}`));
					} else {
						console.log(
							styleText('yellow', `⚠️ KeyDB installation: ${keydbResult.message}`)
						);
						console.log(
							styleText(
								'gray',
								'   Scrivener MCP will use embedded queue as fallback'
							)
						);
					}

					// Install Neo4j
					console.log(styleText('blue', '\n📦 Installing Neo4j...\n'));
					const neo4jResult = await Neo4jAutoInstaller.install({
						method: 'auto',
						interactive: false,
						projectPath: './data',
						autoStart: true,
					});

					if (neo4jResult.success) {
						console.log(styleText('green', `✅ ${neo4jResult.message}`));
					} else {
						console.log(
							styleText('yellow', `⚠️ Neo4j installation: ${neo4jResult.message}`)
						);
						console.log(
							styleText('gray', '   Scrivener MCP will use SQLite-only mode')
						);
					}

					// Summary
					console.log(styleText(['bold', 'green'], '\n🎉 Quick Setup Complete!\n'));
					console.log('Your Scrivener MCP installation includes:');
					if (keydbResult.success) {
						console.log(
							styleText('green', '  ✅ KeyDB - High-performance job processing')
						);
					} else {
						console.log(
							styleText('yellow', '  ⚪ Embedded queue - Basic job processing')
						);
					}
					if (neo4jResult.success) {
						console.log(styleText('green', '  ✅ Neo4j - Advanced graph analytics'));
					} else {
						console.log(styleText('yellow', '  ⚪ SQLite - Basic data storage'));
					}
					console.log(styleText('green', '  ✅ All core features ready\n'));

					console.log(styleText('cyan', 'Start using Scrivener MCP with: npm start'));
				},
				this.metricsTracker,
				'Setup'
			);
		}, 'SetupWizard.runQuickSetup');

		try {
			await wrappedFunction();
		} catch (error: unknown) {
			console.log(styleText('red', '❌ Quick setup failed:'));
			console.log(styleText('gray', (error as Error).message));
			throw error;
		}
	}

	private async runKeyDBSetup(): Promise<void> {
		console.log(styleText(['bold', 'cyan'], '\n🚀 KeyDB Setup - High-Performance Queues\n'));

		console.log('KeyDB provides:');
		console.log(styleText('cyan', '  • Multi-threaded Redis-compatible server (2-5x faster)'));
		console.log(styleText('cyan', '  • Advanced job queue processing with BullMQ'));
		console.log(styleText('cyan', '  • Intelligent query caching for SQLite'));
		console.log(styleText('cyan', '  • Seamless fallback if unavailable\n'));

		const keydbInstaller = await KeyDBInstaller.getInstance();

		const status = await keydbInstaller.checkAvailability();

		if (status.running) {
			console.log(styleText('green', '✅ KeyDB is already running!'));
			console.log(
				styleText('gray', `   Version: ${status.version}, Port: ${status.port || 6379}\n`)
			);
			console.log(
				styleText('cyan', 'Your Scrivener MCP is ready for high-performance operations.')
			);
			return;
		}

		if (status.installed) {
			console.log(styleText('yellow', '⚪ KeyDB is installed but not running.'));
			const start = await this.askYesNo('Would you like to start KeyDB now?');

			if (start) {
				console.log(styleText('blue', 'Starting KeyDB service...\n'));
				const started = await keydbInstaller.startKeyDB();

				if (started) {
					console.log(styleText('green', '✅ KeyDB started successfully!'));
				} else {
					console.log(styleText('red', '❌ Failed to start KeyDB automatically.'));
					console.log(
						styleText('gray', 'Try running manually: keydb-server --daemonize yes')
					);
				}
				return;
			}
		}

		// Installation needed
		console.log(styleText('yellow', '⚠️ KeyDB is not installed.\n'));

		const install = await this.askYesNo('Would you like to install KeyDB now?');

		if (!install) {
			console.log(styleText('gray', '\nKeyDB setup cancelled.'));
			console.log(styleText('gray', 'Scrivener MCP will use embedded queue as fallback.'));
			return;
		}

		// Choose installation method
		console.log(styleText('yellow', '\nChoose installation method:'));
		console.log(styleText('cyan', '  1. Automatic (recommended)'));
		console.log(styleText('cyan', '  2. Homebrew (macOS)'));
		console.log(styleText('cyan', '  3. Docker (cross-platform)'));
		console.log(styleText('cyan', '  4. Show manual instructions'));

		const method = await this.askQuestion('Select method (1-4): ');

		switch (method) {
			case '1':
			case '': {
				console.log(styleText('blue', '\n📦 Installing KeyDB automatically...\n'));
				const result = await keydbInstaller.autoInstall({ startService: true });

				if (result.success) {
					console.log(styleText('green', `✅ ${result.message}`));
					console.log(styleText('green', `   Method: ${result.method}`));
					if (result.version) {
						console.log(styleText('green', `   Version: ${result.version}`));
					}
				} else {
					console.log(styleText('red', `❌ Installation failed: ${result.message}`));
					console.log(
						styleText('yellow', '\nTry manual installation or use embedded queue.')
					);
				}
				break;
			}

			case '2': {
				console.log(styleText('blue', '\n📦 Installing via Homebrew...\n'));
				const homebrewResult = await keydbInstaller.autoInstall({
					method: 'homebrew',
					startService: true,
				});
				console.log(
					homebrewResult.success
						? styleText('green', `✅ ${homebrewResult.message}`)
						: styleText('red', `❌ ${homebrewResult.message}`)
				);
				break;
			}

			case '3': {
				console.log(styleText('blue', '\n📦 Installing via Docker...\n'));
				const dockerResult = await keydbInstaller.autoInstall({
					method: 'docker',
					startService: true,
				});
				console.log(
					dockerResult.success
						? styleText('green', `✅ ${dockerResult.message}`)
						: styleText('red', `❌ ${dockerResult.message}`)
				);
				break;
			}

			case '4':
				console.log(styleText('blue', '\n📋 Manual Installation Instructions:'));
				console.log(styleText('gray', keydbInstaller.getManualInstructions()));
				break;

			default:
				console.log(styleText('gray', '\nInvalid selection. Setup cancelled.'));
		}
	}

	private async runBasicSetup(): Promise<void> {
		const status = await DatabaseSetup.checkNeo4jAvailability();

		if (status.running) {
			console.log(styleText('green', '\n✅ Neo4j is already installed and running!'));
			console.log(
				styleText('gray', 'You can start using Scrivener MCP with full features.\n')
			);
			return;
		}

		// Offer installation options
		console.log(styleText('yellow', '\n⚠️  Neo4j is not currently running.'));
		console.log('\nNeo4j provides advanced features like:');
		console.log(styleText('cyan', '  • Character relationship visualization'));
		console.log(styleText('cyan', '  • Story structure analysis'));
		console.log(styleText('cyan', '  • Plot complexity tracking'));
		console.log(styleText('cyan', '  • Writing productivity analytics'));

		const install = await this.askYesNo('\nWould you like to install Neo4j now?');

		if (!install) {
			console.log(
				styleText(
					'gray',
					'\nYou can run this setup again anytime with: npx scrivener-setup'
				)
			);
			this.rl.close();
			return;
		}

		// Choose installation method
		const method = await this.chooseInstallMethod(status);

		const measureResult = await measureExecution(async () => {
			const inputPath = await this.askQuestion(
				'Enter your Scrivener project path (or press Enter for current directory): ',
				process.cwd(),
				async (path: string) => {
					try {
						const sanitized = sanitizePath(path);
						const fullPath = buildPath(sanitized);
						return await pathExists(fullPath);
					} catch (error) {
						handleError(error, 'SetupWizard.pathValidation');
						return false;
					}
				},
				'Path does not exist. Please enter a valid directory path.'
			);

			const fullPath = buildPath(sanitizePath(inputPath));
			const resolvedPath = path.resolve(fullPath);
			if (resolvedPath.includes('\0') || resolvedPath.includes('..')) {
				throw new AppError(
					'Invalid project path: path traversal is not allowed',
					ErrorCode.INVALID_INPUT
				);
			}
			if (!(await pathExists(resolvedPath))) {
				throw new AppError(
					`Project path does not exist: ${resolvedPath}`,
					ErrorCode.INVALID_INPUT
				);
			}

			return resolvedPath;
		});
		const projectPath = measureResult.result;

		// Perform installation
		console.log(styleText('blue', '\n🚀 Starting installation...\n'));

		const result = await Neo4jAutoInstaller.install({
			method,
			interactive: false,
			projectPath,
			autoStart: true,
		});

		if (result.success) {
			console.log(styleText('green', '\n✅ Installation completed successfully!'));
			console.log(styleText('gray', '\nNeo4j credentials have been saved to your project.'));
			console.log(styleText('gray', 'You can now use Scrivener MCP with full features.\n'));

			// Offer to test connection
			const test = await this.askYesNo('Would you like to test the Neo4j connection?');
			if (test) {
				await this.testConnection(result.credentials!);
			}
		} else {
			console.log(styleText('red', '\n❌ Installation failed.'));
			console.log(styleText('gray', result.message));
			console.log(styleText('gray', '\nYou can try manual installation:'));
			console.log(DatabaseSetup.getSetupInstructions());
		}

		this.rl.close();
	}

	/**
	 * Print welcome banner
	 */
	private printBanner(): void {
		console.log(styleText(['bold', 'blue'], '╔════════════════════════════════════════╗'));
		console.log(styleText(['bold', 'blue'], '║     Scrivener MCP Setup Wizard         ║'));
		console.log(styleText(['bold', 'blue'], '╚════════════════════════════════════════╝'));
		console.log(styleText('gray', 'Version 1.0.0'));
	}

	/**
	 * Ask a yes/no question
	 */
	private async askYesNo(question: string): Promise<boolean> {
		const answer = await this.rl.question(styleText('yellow', `${question} (yes/no): `));
		return answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y';
	}

	/**
	 * Ask a question with optional default and validation
	 */
	private async askQuestion(
		question: string,
		defaultValue?: string,
		validator?: (input: string) => boolean | Promise<boolean>,
		errorMessage?: string
	): Promise<string> {
		while (true) {
			const answer = await this.rl.question(styleText('yellow', question));
			const value = answer || defaultValue || '';

			if (validator && !(await validator(value))) {
				console.log(styleText('red', errorMessage || 'Invalid input. Please try again.'));
				continue;
			}

			return value;
		}
	}

	/**
	 * Choose installation method
	 */
	private async chooseInstallMethod(status: {
		installed: boolean;
		running: boolean;
		version?: string;
		dockerAvailable?: boolean;
		homebrewAvailable?: boolean;
	}): Promise<'docker' | 'homebrew' | 'native' | 'auto'> {
		const options: string[] = ['auto (recommended)'];

		if (status.dockerAvailable) {
			options.push('docker');
		}
		if (status.homebrewAvailable) {
			options.push('homebrew');
		}
		options.push('native');

		console.log(styleText('yellow', '\nAvailable installation methods:'));
		options.forEach((opt, i) => {
			console.log(styleText('cyan', `  ${i + 1}. ${opt}`));
		});

		const choice = await this.askQuestion(`\nSelect method (1-${options.length}): `);
		const index = parseInt(choice) - 1;

		if (index >= 0 && index < options.length) {
			const selected = options[index];
			if (selected.startsWith('auto')) return 'auto';
			return selected as 'docker' | 'homebrew' | 'native' | 'auto';
		}

		return 'auto';
	}

	private async runAdvancedSetup(): Promise<void> {
		console.log(styleText(['bold', 'cyan'], '\n🚀 Advanced Setup - AI Integration\n'));

		console.log('This will set up:');
		console.log(styleText('cyan', '  • Embedded queue system (automatic)'));
		console.log(styleText('cyan', '  • AI services configuration'));
		console.log(styleText('cyan', '  • Neo4j graph database'));
		console.log(styleText('cyan', '  • All required dependencies\n'));

		const confirm = await this.askYesNo('Continue with advanced setup?');
		if (!confirm) {
			console.log(styleText('gray', '\nSetup cancelled.'));
			return;
		}

		const autoSetup = new AutoSetup();
		const result = await autoSetup.run({
			interactive: true,
			quickSetup: false,
			force: false,
		});

		if (result.success) {
			console.log(styleText('green', '\n✅ Advanced setup completed successfully!'));
			console.log(styleText('gray', 'All features are now available.\n'));
		} else {
			console.log(styleText('red', '\n⚠️  Setup completed with some issues.'));
			if (result.warnings && result.warnings.length > 0) {
				console.log(styleText('yellow', '\nWarnings:'));
				result.warnings.forEach((w) => console.log(styleText('yellow', `  • ${w}`)));
			}
			if (result.errors && result.errors.length > 0) {
				console.log(styleText('red', '\nErrors:'));
				result.errors.forEach((e) => console.log(styleText('red', `  • ${e}`)));
			}
		}
	}

	private async checkHealth(): Promise<void> {
		console.log(styleText(['bold', 'cyan'], '\n🔍 System Health Check\n'));

		const neo4jStatus = await DatabaseSetup.checkNeo4jAvailability();
		if (neo4jStatus.running) {
			console.log(styleText('green', '✅ Neo4j: Running'));
		} else {
			console.log(styleText('red', '❌ Neo4j: Not running'));
		}

		const autoSetup = new AutoSetup();
		const health = await autoSetup.runHealthChecks();

		console.log(
			health.queue
				? styleText('green', '✅ Queue: Ready (embedded)')
				: styleText('red', '❌ Queue: Not ready')
		);
		console.log(
			health.ai
				? styleText('green', '✅ AI Services: Configured')
				: styleText('yellow', '⚠️  AI Services: Not configured')
		);

		// Overall status
		console.log(styleText('cyan', '\n━━━ Overall Status ━━━'));
		if (neo4jStatus.running && health.overall) {
			console.log(styleText('green', 'All systems operational! 🎉'));
		} else if (neo4jStatus.running || health.queue) {
			console.log(
				styleText(
					'yellow',
					'Some services are running. Run setup to configure missing services.'
				)
			);
		} else {
			console.log(styleText('red', 'No services are running. Run setup to get started.'));
		}

		console.log(styleText('gray', '\nRun setup option 1 or 2 to configure missing services.'));
	}

	/**
	 * Test Neo4j connection
	 */
	private async testConnection(credentials: {
		uri: string;
		user: string;
		password: string;
	}): Promise<void> {
		const wrappedFunction = withErrorHandling(async () => {
			validateInput(credentials, {
				uri: { type: 'string', required: true, minLength: 1 },
				user: { type: 'string', required: true, minLength: 1 },
				password: { type: 'string', required: true, minLength: 1 },
			});

			return measureAndTrackOperation(
				'testConnection',
				async () => {
					console.log(styleText('blue', '\n🔌 Testing connection...'));

					const neo4j = await import('neo4j-driver');
					const driver = neo4j.default.driver(
						credentials.uri,
						neo4j.default.auth.basic(credentials.user, credentials.password)
					);

					try {
						await driver.verifyConnectivity();
						const session = driver.session();
						const result = await session.run(
							'RETURN "Connection successful!" as message'
						);
						await session.close();
						console.log(styleText('green', `✅ ${result.records[0].get('message')}`));
					} finally {
						await driver.close();
					}
				},
				this.metricsTracker,
				'Setup'
			);
		}, 'SetupWizard.testConnection');

		try {
			await wrappedFunction();
		} catch (error: unknown) {
			console.log(styleText('red', '❌ Connection test failed:'));
			console.log(styleText('gray', (error as Error).message));
			throw error;
		}
	}

	private showMetricsSummary(): void {
		const metrics = this.metricsTracker.getMetrics();
		if (Object.keys(metrics).length === 0) return;

		console.log(styleText(['bold', 'blue'], '\n📊 Setup Performance Summary'));
		console.log(styleText('gray', '━'.repeat(40)));

		for (const [operation, data] of Object.entries(metrics)) {
			const duration = formatDuration(data.averageTime);
			const successRate = data.successRate ? `${data.successRate.toFixed(1)}%` : 'N/A';

			console.log(styleText('cyan', `${operation}:`));
			console.log(styleText('gray', `  Duration: ${duration}`));
			console.log(styleText('gray', `  Calls: ${data.callCount}`));
			if (data.successRate !== undefined) {
				console.log(styleText('gray', `  Success Rate: ${successRate}`));
			}
		}

		console.log(styleText('gray', '━'.repeat(40)));
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const wizard = new SetupWizard();
	wizard.run().catch(console.error);
}
