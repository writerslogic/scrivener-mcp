/**
 * AI Configuration Wizard for LangChain setup
 * Handles API key management and model configuration
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as readline from 'readline';
import { execSync } from 'child_process';
import { getLogger } from '../../core/logger.js';
import { createError, ErrorCode } from '../../core/errors.js';

const logger = getLogger('ai-config-wizard');

export interface AIConfig {
	openaiApiKey?: string;
	anthropicApiKey?: string;
	cohereApiKey?: string;
	huggingfaceApiKey?: string;
	defaultModel?: string;
	defaultEmbeddingModel?: string;
	temperature?: number;
	maxTokens?: number;
	enableLocalModels?: boolean;
	ollamaUrl?: string;
}

export class AIConfigWizard {
	private configDir = join(homedir(), '.scrivener-mcp');
	private configPath = join(this.configDir, 'ai-config.json');
	private envPath = join(this.configDir, '.env');
	private rl: readline.Interface;

	constructor() {
		// Ensure config directory exists
		if (!existsSync(this.configDir)) {
			mkdirSync(this.configDir, { recursive: true });
		}

		this.rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});
	}

	/**
	 * Load existing configuration
	 */
	loadConfig(): AIConfig {
		if (existsSync(this.configPath)) {
			try {
				const configData = readFileSync(this.configPath, 'utf-8');
				return JSON.parse(configData);
			} catch (error) {
				logger.warn('Failed to load existing config', { error });
			}
		}
		return {};
	}

	/**
	 * Save configuration
	 */
	saveConfig(config: AIConfig): void {
		writeFileSync(this.configPath, JSON.stringify(config, null, 2));
		this.updateEnvFile(config);
		logger.info('Configuration saved');
	}

	/**
	 * Update .env file with API keys
	 */
	private updateEnvFile(config: AIConfig): void {
		let envContent = '';

		if (existsSync(this.envPath)) {
			envContent = readFileSync(this.envPath, 'utf-8');
		}

		// Update or add environment variables
		const updateEnvVar = (key: string, value: string | undefined) => {
			if (!value) return;
			
			const regex = new RegExp(`^${key}=.*$`, 'm');
			if (regex.test(envContent)) {
				envContent = envContent.replace(regex, `${key}=${value}`);
			} else {
				envContent += `\n${key}=${value}`;
			}
		};

		updateEnvVar('OPENAI_API_KEY', config.openaiApiKey);
		updateEnvVar('ANTHROPIC_API_KEY', config.anthropicApiKey);
		updateEnvVar('COHERE_API_KEY', config.cohereApiKey);
		updateEnvVar('HUGGINGFACE_API_KEY', config.huggingfaceApiKey);
		updateEnvVar('DEFAULT_AI_MODEL', config.defaultModel);
		updateEnvVar('DEFAULT_EMBEDDING_MODEL', config.defaultEmbeddingModel);
		updateEnvVar('AI_TEMPERATURE', config.temperature?.toString());
		updateEnvVar('AI_MAX_TOKENS', config.maxTokens?.toString());
		updateEnvVar('OLLAMA_URL', config.ollamaUrl);

		writeFileSync(this.envPath, envContent.trim() + '\n');
	}

	/**
	 * Prompt user for input
	 */
	private async prompt(question: string): Promise<string> {
		return new Promise((resolve) => {
			this.rl.question(question, (answer) => {
				resolve(answer.trim());
			});
		});
	}

	/**
	 * Validate OpenAI API key
	 */
	async validateOpenAIKey(apiKey: string): Promise<boolean> {
		try {
			const response = await fetch('https://api.openai.com/v1/models', {
				headers: {
					'Authorization': `Bearer ${apiKey}`,
				},
			});
			return response.ok;
		} catch (error) {
			logger.warn('Failed to validate OpenAI key', { error });
			return false;
		}
	}

	/**
	 * Validate Anthropic API key
	 */
	async validateAnthropicKey(apiKey: string): Promise<boolean> {
		try {
			const response = await fetch('https://api.anthropic.com/v1/messages', {
				method: 'POST',
				headers: {
					'x-api-key': apiKey,
					'anthropic-version': '2023-06-01',
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					model: 'claude-3-haiku-20240307',
					messages: [{ role: 'user', content: 'test' }],
					max_tokens: 1,
				}),
			});
			// 401 means invalid key, 400 might mean valid key but bad request
			return response.status !== 401;
		} catch (error) {
			logger.warn('Failed to validate Anthropic key', { error });
			return false;
		}
	}

	/**
	 * Check if Ollama is installed and running
	 */
	async checkOllama(): Promise<boolean> {
		try {
			const response = await fetch('http://localhost:11434/api/tags');
			return response.ok;
		} catch {
			return false;
		}
	}

	/**
	 * Install Ollama for local models
	 */
	async installOllama(): Promise<void> {
		logger.info('Installing Ollama for local model support...');

		const platform = process.platform;

		try {
			if (platform === 'darwin' || platform === 'linux') {
				execSync('curl -fsSL https://ollama.ai/install.sh | sh', { stdio: 'inherit' });
			} else if (platform === 'win32') {
				console.log('\nPlease download and install Ollama from: https://ollama.ai/download/windows\n');
				await this.prompt('Press Enter after installation is complete...');
			}

			// Start Ollama service in background
			const { spawn } = await import('child_process');
			const ollama = spawn('ollama', ['serve'], {
				detached: true,
				stdio: 'ignore',
			});
			ollama.unref();
			
			// Pull a default model
			logger.info('Downloading default model (llama2)...');
			execSync('ollama pull llama2', { stdio: 'inherit' });
			
			logger.info('Ollama installed successfully');
		} catch (error) {
			logger.error('Failed to install Ollama', { error });
			throw error;
		}
	}

	/**
	 * Interactive configuration wizard
	 */
	async runWizard(): Promise<AIConfig> {
		console.log('\n🤖 AI Configuration Wizard for Scrivener MCP\n');
		console.log('This wizard will help you set up AI features powered by LangChain.\n');

		const config = this.loadConfig();

		// OpenAI Configuration
		console.log('━━━ OpenAI Configuration ━━━');
		const useOpenAI = await this.prompt('Do you want to use OpenAI? (y/n): ');
		
		if (useOpenAI.toLowerCase() === 'y') {
			const currentKey = config.openaiApiKey ? '(configured)' : '(not set)';
			console.log(`Current OpenAI API key: ${currentKey}`);
			
			const updateKey = await this.prompt('Enter new OpenAI API key (or press Enter to skip): ');
			if (updateKey) {
				console.log('Validating API key...');
				if (await this.validateOpenAIKey(updateKey)) {
					config.openaiApiKey = updateKey;
					console.log('✅ API key validated successfully');
				} else {
					console.log('⚠️  Warning: Could not validate API key. It will be saved but may not work.');
					config.openaiApiKey = updateKey;
				}
			}

			// Model selection
			const models = ['gpt-4-turbo-preview', 'gpt-4', 'gpt-3.5-turbo'];
			console.log('\nAvailable models:');
			models.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
			
			const modelChoice = await this.prompt('Select default model (1-3): ');
			const modelIndex = parseInt(modelChoice) - 1;
			if (modelIndex >= 0 && modelIndex < models.length) {
				config.defaultModel = models[modelIndex];
			}
		}

		// Anthropic Configuration
		console.log('\n━━━ Anthropic Configuration ━━━');
		const useAnthropic = await this.prompt('Do you want to use Anthropic Claude? (y/n): ');
		
		if (useAnthropic.toLowerCase() === 'y') {
			const currentKey = config.anthropicApiKey ? '(configured)' : '(not set)';
			console.log(`Current Anthropic API key: ${currentKey}`);
			
			const updateKey = await this.prompt('Enter new Anthropic API key (or press Enter to skip): ');
			if (updateKey) {
				console.log('Validating API key...');
				if (await this.validateAnthropicKey(updateKey)) {
					config.anthropicApiKey = updateKey;
					console.log('✅ API key validated successfully');
				} else {
					console.log('⚠️  Warning: Could not validate API key. It will be saved but may not work.');
					config.anthropicApiKey = updateKey;
				}
			}
		}

		// Local Models Configuration
		console.log('\n━━━ Local Models Configuration ━━━');
		const useLocal = await this.prompt('Do you want to use local models (Ollama)? (y/n): ');
		
		if (useLocal.toLowerCase() === 'y') {
			config.enableLocalModels = true;
			
			if (await this.checkOllama()) {
				console.log('✅ Ollama is already installed and running');
				config.ollamaUrl = 'http://localhost:11434';
			} else {
				const installNow = await this.prompt('Ollama not found. Install now? (y/n): ');
				if (installNow.toLowerCase() === 'y') {
					await this.installOllama();
					config.ollamaUrl = 'http://localhost:11434';
				}
			}
		}

		// Advanced Settings
		console.log('\n━━━ Advanced Settings ━━━');
		const configureAdvanced = await this.prompt('Configure advanced settings? (y/n): ');
		
		if (configureAdvanced.toLowerCase() === 'y') {
			// Temperature
			const temp = await this.prompt(`Temperature (0.0-1.0, current: ${config.temperature || 0.7}): `);
			if (temp) {
				const tempValue = parseFloat(temp);
				if (tempValue >= 0 && tempValue <= 1) {
					config.temperature = tempValue;
				}
			}

			// Max tokens
			const tokens = await this.prompt(`Max tokens (current: ${config.maxTokens || 2000}): `);
			if (tokens) {
				const tokenValue = parseInt(tokens);
				if (tokenValue > 0) {
					config.maxTokens = tokenValue;
				}
			}

			// Embedding model
			const embeddingModels = ['text-embedding-ada-002', 'text-embedding-3-small', 'text-embedding-3-large'];
			console.log('\nAvailable embedding models:');
			embeddingModels.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
			
			const embChoice = await this.prompt('Select embedding model (1-3): ');
			const embIndex = parseInt(embChoice) - 1;
			if (embIndex >= 0 && embIndex < embeddingModels.length) {
				config.defaultEmbeddingModel = embeddingModels[embIndex];
			}
		}

		// Save configuration
		this.saveConfig(config);
		this.rl.close();

		console.log('\n✅ Configuration complete!');
		console.log(`Configuration saved to: ${this.configPath}`);
		console.log(`Environment variables saved to: ${this.envPath}`);

		return config;
	}

	/**
	 * Quick setup with defaults
	 */
	async quickSetup(apiKey?: string): Promise<AIConfig> {
		const config: AIConfig = {
			openaiApiKey: apiKey || process.env.OPENAI_API_KEY,
			defaultModel: 'gpt-4-turbo-preview',
			defaultEmbeddingModel: 'text-embedding-ada-002',
			temperature: 0.7,
			maxTokens: 2000,
			enableLocalModels: false,
		};

		if (config.openaiApiKey) {
			logger.info('Validating OpenAI API key...');
			if (await this.validateOpenAIKey(config.openaiApiKey)) {
				logger.info('API key validated successfully');
			} else {
				logger.warn('Could not validate API key');
			}
		}

		this.saveConfig(config);
		return config;
	}

	/**
	 * Get active configuration
	 */
	getActiveConfig(): AIConfig {
		const config = this.loadConfig();

		// Override with environment variables if present
		config.openaiApiKey = process.env.OPENAI_API_KEY || config.openaiApiKey;
		config.anthropicApiKey = process.env.ANTHROPIC_API_KEY || config.anthropicApiKey;
		config.cohereApiKey = process.env.COHERE_API_KEY || config.cohereApiKey;
		config.huggingfaceApiKey = process.env.HUGGINGFACE_API_KEY || config.huggingfaceApiKey;
		config.defaultModel = process.env.DEFAULT_AI_MODEL || config.defaultModel;
		config.defaultEmbeddingModel = process.env.DEFAULT_EMBEDDING_MODEL || config.defaultEmbeddingModel;
		config.ollamaUrl = process.env.OLLAMA_URL || config.ollamaUrl;

		if (process.env.AI_TEMPERATURE) {
			config.temperature = parseFloat(process.env.AI_TEMPERATURE);
		}
		if (process.env.AI_MAX_TOKENS) {
			config.maxTokens = parseInt(process.env.AI_MAX_TOKENS);
		}

		return config;
	}
}