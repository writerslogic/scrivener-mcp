#!/usr/bin/env node
/**
 * Advanced Setup Script for BullMQ and LangChain
 * Run this to auto-install and configure all advanced features
 */

const { styleText } = require('node:util');
async function loadModules() {
	const { AutoSetup } = await import('../dist/services/auto-setup/auto-setup.js');
	return { AutoSetup };
}

async function main() {
	const { AutoSetup } = await loadModules();

	console.log(styleText(['bold', 'cyan'], '\n🚀 Scrivener MCP - Advanced Features Auto-Setup\n'));

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
		await AutoSetup.cli(args);
	} catch (error) {
		console.error(styleText('red', '\n❌ Setup failed:', { stream: process.stderr }), error);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
