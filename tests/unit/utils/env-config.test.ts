import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	getEnvConfig,
	discoverAIKeys,
	applyDiscoveredAIKeys,
} from '../../../src/utils/env-config.js';

// Discovery is exercised via the explicit homeDir parameter: jest sandboxes
// process.env as a plain copy, so pointing HOME at a temp dir never reaches
// os.homedir() (native getenv).
describe('env-config AI key discovery', () => {
	const saved: Record<string, string | undefined> = {};
	let tmpHome: string;

	const anthropicKey = `sk-ant-api03-${'a'.repeat(24)}`;
	const openaiKey = `sk-proj-${'b'.repeat(24)}`;
	const openrouterKey = `sk-or-v1-${'d'.repeat(24)}`;

	beforeEach(() => {
		saved.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
		saved.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
		saved.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
		delete process.env.OPENAI_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.OPENROUTER_API_KEY;
		tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'env-config-test-'));
	});

	afterEach(() => {
		for (const v of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']) {
			if (saved[v] === undefined) delete process.env[v];
			else process.env[v] = saved[v];
		}
		fs.rmSync(tmpHome, { recursive: true, force: true });
	});

	it('discovers ANTHROPIC_API_KEY from ~/.env', () => {
		fs.writeFileSync(path.join(tmpHome, '.env'), `ANTHROPIC_API_KEY=${anthropicKey}\n`);
		expect(discoverAIKeys(tmpHome).anthropicApiKey).toBe(anthropicKey);
	});

	it('discovers ANTHROPIC_API_KEY from ~/.scrivener-mcp/.env', () => {
		fs.mkdirSync(path.join(tmpHome, '.scrivener-mcp'));
		fs.writeFileSync(
			path.join(tmpHome, '.scrivener-mcp', '.env'),
			`ANTHROPIC_API_KEY=${anthropicKey}\n`
		);
		expect(discoverAIKeys(tmpHome).anthropicApiKey).toBe(anthropicKey);
	});

	it('discovers a bare Anthropic key from ~/.anthropic/key', () => {
		fs.mkdirSync(path.join(tmpHome, '.anthropic'));
		fs.writeFileSync(path.join(tmpHome, '.anthropic', 'key'), `${anthropicKey}\n`);
		expect(discoverAIKeys(tmpHome).anthropicApiKey).toBe(anthropicKey);
	});

	it('never attributes an ANTHROPIC_API_KEY dotfile line to OpenAI', () => {
		fs.writeFileSync(path.join(tmpHome, '.env'), `ANTHROPIC_API_KEY=${anthropicKey}\n`);
		const keys = discoverAIKeys(tmpHome);
		expect(keys.openaiApiKey).not.toBe(anthropicKey);
		expect(keys.anthropicApiKey).toBe(anthropicKey);
	});

	it('discovers both providers from a single ~/.env', () => {
		fs.writeFileSync(
			path.join(tmpHome, '.env'),
			`OPENAI_API_KEY=${openaiKey}\nANTHROPIC_API_KEY=${anthropicKey}\n`
		);
		const keys = discoverAIKeys(tmpHome);
		expect(keys.openaiApiKey).toBe(openaiKey);
		expect(keys.anthropicApiKey).toBe(anthropicKey);
	});

	it('accepts quoted values in .env files', () => {
		fs.writeFileSync(path.join(tmpHome, '.env'), `ANTHROPIC_API_KEY="${anthropicKey}"\n`);
		expect(discoverAIKeys(tmpHome).anthropicApiKey).toBe(anthropicKey);
	});

	it('rejects an Anthropic-shaped key in a bare OpenAI key file', () => {
		fs.mkdirSync(path.join(tmpHome, '.openai'));
		fs.writeFileSync(path.join(tmpHome, '.openai', 'key'), `${anthropicKey}\n`);
		expect(discoverAIKeys(tmpHome).openaiApiKey).not.toBe(anthropicKey);
	});

	it('discovers OPENROUTER_API_KEY from ~/.env', () => {
		fs.writeFileSync(path.join(tmpHome, '.env'), `OPENROUTER_API_KEY=${openrouterKey}\n`);
		const keys = discoverAIKeys(tmpHome);
		expect(keys.openrouterApiKey).toBe(openrouterKey);
		expect(keys.openaiApiKey).not.toBe(openrouterKey);
	});

	it('rejects an OpenRouter-shaped key in a bare OpenAI key file', () => {
		fs.mkdirSync(path.join(tmpHome, '.openai'));
		fs.writeFileSync(path.join(tmpHome, '.openai', 'key'), `${openrouterKey}\n`);
		expect(discoverAIKeys(tmpHome).openaiApiKey).not.toBe(openrouterKey);
	});

	it('getEnvConfig prefers explicit environment variables over discovery', () => {
		const envKey = `sk-ant-api03-${'c'.repeat(24)}`;
		process.env.ANTHROPIC_API_KEY = envKey;
		expect(getEnvConfig().anthropicApiKey).toBe(envKey);
	});

	describe('applyDiscoveredAIKeys', () => {
		it('fills process.env from dotfiles when unset', () => {
			fs.writeFileSync(
				path.join(tmpHome, '.env'),
				`OPENAI_API_KEY=${openaiKey}\nANTHROPIC_API_KEY=${anthropicKey}\nOPENROUTER_API_KEY=${openrouterKey}\n`
			);
			applyDiscoveredAIKeys(tmpHome);
			expect(process.env.ANTHROPIC_API_KEY).toBe(anthropicKey);
			expect(process.env.OPENAI_API_KEY).toBe(openaiKey);
			expect(process.env.OPENROUTER_API_KEY).toBe(openrouterKey);
		});

		it('never overrides explicit environment variables', () => {
			const envKey = `sk-ant-api03-${'c'.repeat(24)}`;
			process.env.ANTHROPIC_API_KEY = envKey;
			fs.writeFileSync(path.join(tmpHome, '.env'), `ANTHROPIC_API_KEY=${anthropicKey}\n`);
			applyDiscoveredAIKeys(tmpHome);
			expect(process.env.ANTHROPIC_API_KEY).toBe(envKey);
		});
	});
});
