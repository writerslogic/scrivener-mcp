#!/usr/bin/env node
/**
 * Advanced Setup Script for BullMQ and LangChain
 * Run this to auto-install and configure all advanced features
 */

// Use dynamic import for ESM modules
async function loadModules() {
	const { AutoSetup } = await import('../dist/services/auto-setup/auto-setup.js');
	const chalk = (await import('chalk')).default;
	return { AutoSetup, chalk };
}

async function main() {
	const { AutoSetup, chalk } = await loadModules();
	
	console.log(chalk.bold.cyan('\n🚀 Scrivener MCP - Advanced Features Auto-Setup\n'));
	
	// Parse command line arguments
	const args = process.argv.slice(2);
	const showHelp = args.includes('--help') || args.includes('-h');
	
	if (showHelp) {
		console.log('Usage: npm run setup:advanced [options]\n');
		console.log('Options:');
		console.log('  --quick              Quick setup with defaults');
		console.log('  --skip-redis         Skip Redis installation');
		console.log('  --skip-ai            Skip AI configuration');
		console.log('  --openai-key <key>   Provide OpenAI API key');
		console.log('  --redis-url <url>    Use existing Redis instance');
		console.log('  --force              Force reinstall even if already configured');
		console.log('  --help, -h           Show this help message\n');
		process.exit(0);
	}

	try {
		// Run auto-setup
		await AutoSetup.cli(args);
	} catch (error) {
		console.error(chalk.red('\n❌ Setup failed:'), error);
		process.exit(1);
	}
}

main().catch(console.error);