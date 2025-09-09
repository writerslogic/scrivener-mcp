#!/usr/bin/env node
/**
 * Post-install script that runs after npm install
 * Prompts user to set up advanced features
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');
const os = require('os');

// ANSI color codes for terminal output
const colors = {
	reset: '\x1b[0m',
	bright: '\x1b[1m',
	cyan: '\x1b[36m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	red: '\x1b[31m',
	blue: '\x1b[34m',
};

function colorize(text, color) {
	return `${colors[color]}${text}${colors.reset}`;
}

// Check if this is a first-time installation
function isFirstInstall() {
	const configDir = path.join(os.homedir(), '.scrivener-mcp');
	const setupFile = path.join(configDir, 'setup.json');
	return !fs.existsSync(setupFile);
}

// Check if running in CI environment
function isCI() {
	return process.env.CI === 'true' || 
		process.env.CONTINUOUS_INTEGRATION === 'true' ||
		process.env.GITHUB_ACTIONS === 'true' ||
		process.env.GITLAB_CI === 'true' ||
		process.env.CIRCLECI === 'true';
}

// Check if running in non-interactive environment
function isNonInteractive() {
	return !process.stdin.isTTY || process.env.SCRIVENER_SKIP_SETUP === 'true';
}

// Display welcome banner
function showBanner() {
	console.log('\n' + colorize('═'.repeat(60), 'cyan'));
	console.log(colorize('   🎉 Scrivener MCP Installation Complete!', 'bright'));
	console.log(colorize('═'.repeat(60), 'cyan') + '\n');
}

// Display feature list
function showFeatures() {
	console.log(colorize('Available Features:', 'bright'));
	console.log(colorize('  ✓', 'green') + ' Basic document operations');
	console.log(colorize('  ✓', 'green') + ' RTF parsing and analysis');
	console.log(colorize('  ✓', 'green') + ' SQLite database support\n');

	console.log(colorize('Optional Advanced Features:', 'yellow'));
	console.log(colorize('  ○', 'yellow') + ' KeyDB high-performance queues (2-5x faster than Redis)');
	console.log(colorize('  ○', 'yellow') + ' Neo4j graph database for character relationships');
	console.log(colorize('  ○', 'yellow') + ' BullMQ distributed job processing');
	console.log(colorize('  ○', 'yellow') + ' LangChain AI integration (GPT-4, Claude, etc.)');
	console.log(colorize('  ○', 'yellow') + ' Intelligent query caching and optimization');
	console.log(colorize('  ○', 'yellow') + ' Semantic search and RAG capabilities\n');
}

// Create minimal config for basic operation
function createMinimalConfig() {
	const configDir = path.join(os.homedir(), '.scrivener-mcp');
	
	if (!fs.existsSync(configDir)) {
		fs.mkdirSync(configDir, { recursive: true });
	}

	// Create a minimal setup.json to indicate basic installation
	const setupFile = path.join(configDir, 'setup.json');
	if (!fs.existsSync(setupFile)) {
		const minimalSetup = {
			version: require('../package.json').version,
			timestamp: new Date().toISOString(),
			setupType: 'basic',
			completed: false,
			features: {
				sqlite: true,
				neo4j: false,
				redis: false,
				ai: false,
			},
		};
		fs.writeFileSync(setupFile, JSON.stringify(minimalSetup, null, 2));
	}
}

// Prompt user for setup
async function promptSetup() {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	return new Promise((resolve) => {
		console.log(colorize('Would you like to set up advanced features now?', 'bright'));
		console.log(colorize('(You can always run "npm run setup" later)', 'yellow'));
		
		rl.question('\n' + colorize('Set up now? (yes/no): ', 'cyan'), (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y');
		});
	});
}

// Run the setup wizard
function runSetup() {
	console.log('\n' + colorize('Starting setup wizard...', 'cyan') + '\n');
	
	try {
		// Build the project first if needed
		if (!fs.existsSync(path.join(__dirname, '..', 'dist'))) {
			console.log(colorize('Building project...', 'yellow'));
			execSync('npm run build', { 
				stdio: 'inherit',
				cwd: path.join(__dirname, '..'),
			});
		}

		// Run the setup wizard
		execSync('node dist/cli/setup-wizard.js', { 
			stdio: 'inherit',
			cwd: path.join(__dirname, '..'),
		});
	} catch (error) {
		console.error(colorize('\n❌ Setup failed:', 'red'), error.message);
		console.log(colorize('\nYou can run setup manually with: npm run setup', 'yellow'));
	}
}

// Show quick start guide
function showQuickStart() {
	console.log(colorize('\n📚 Quick Start Guide:', 'bright'));
	console.log(colorize('─'.repeat(40), 'cyan'));
	
	console.log('\n1. ' + colorize('Basic Usage (no setup required):', 'green'));
	console.log('   npm start\n');
	
	console.log('2. ' + colorize('Set up advanced features:', 'yellow'));
	console.log('   npm run setup\n');
	
	console.log('3. ' + colorize('Quick setup with defaults:', 'yellow'));
	console.log('   npm run setup:quick\n');
	
	console.log('4. ' + colorize('Check system health:', 'blue'));
	console.log('   npm run health\n');
	
	console.log(colorize('Documentation:', 'bright'));
	console.log('  • README.md - General documentation');
	console.log('  • LANGCHAIN_BULLMQ_USAGE.md - Advanced features guide');
	console.log('  • AUTO_SETUP_README.md - Setup documentation\n');
}

// Main post-install logic
async function main() {
	// Skip in CI environments
	if (isCI()) {
		console.log('Skipping post-install setup (CI environment detected)');
		return;
	}

	// Skip if explicitly disabled
	if (process.env.SCRIVENER_SKIP_POSTINSTALL === 'true') {
		console.log('Skipping post-install setup (SCRIVENER_SKIP_POSTINSTALL=true)');
		return;
	}

	// Show banner
	showBanner();

	// Create minimal config
	createMinimalConfig();

	// Show available features
	showFeatures();

	// If non-interactive or not first install, just show quick start
	if (isNonInteractive() || !isFirstInstall()) {
		showQuickStart();
		return;
	}

	// Prompt for setup on first install
	if (isFirstInstall()) {
		console.log(colorize('🆕 First-time installation detected!', 'bright'));
		console.log(colorize('─'.repeat(40), 'cyan') + '\n');
		
		const shouldSetup = await promptSetup();
		
		if (shouldSetup) {
			runSetup();
		} else {
			console.log('\n' + colorize('✓ Basic installation complete!', 'green'));
			showQuickStart();
		}
	} else {
		showQuickStart();
	}
}

// Handle errors gracefully
process.on('unhandledRejection', (error) => {
	console.error(colorize('\n❌ Post-install error:', 'red'), error);
	showQuickStart();
	process.exit(0); // Don't fail the install
});

// Run main function
if (require.main === module) {
	main().catch((error) => {
		console.error(colorize('\n❌ Post-install error:', 'red'), error);
		showQuickStart();
		process.exit(0); // Don't fail the install
	});
}