import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { AutoSetup } from '../../../src/services/auto-setup/auto-setup.js';
import { AIConfigWizard } from '../../../src/services/auto-setup/ai-config-wizard.js';
import { initializeAsyncServices } from '../../../src/handlers/async-handlers.js';
import { readJSON, writeJSON } from '../../../src/utils/common.js';

jest.mock('../../../src/services/auto-setup/ai-config-wizard.js', () => ({
	AIConfigWizard: jest.fn().mockImplementation(() => ({
		getActiveConfig: jest.fn(),
		quickSetup: jest.fn(),
		runWizard: jest.fn(),
	})),
}));
jest.mock('../../../src/handlers/async-handlers.js', () => ({
	initializeAsyncServices: jest.fn(),
}));
jest.mock('fs', () => ({
	...jest.requireActual<typeof import('fs')>('fs'),
	existsSync: jest.fn(),
	mkdirSync: jest.fn(),
}));
jest.mock('../../../src/utils/common.js', () => ({
	...jest.requireActual<typeof import('../../../src/utils/common.js')>(
		'../../../src/utils/common.js'
	),
	readJSON: jest.fn(),
	writeJSON: jest.fn(),
}));

describe('AutoSetup', () => {
	const directory = join(homedir(), '.scrivener-mcp');
	const setupPath = join(directory, 'setup.json');
	let autoSetup: AutoSetup;
	let wizard: jest.Mocked<AIConfigWizard>;

	beforeEach(() => {
		jest.clearAllMocks();
		jest.mocked(existsSync).mockReset().mockReturnValue(false);
		jest.mocked(mkdirSync).mockReset();
		jest.mocked(readJSON).mockReset().mockResolvedValue({ completed: false });
		jest.mocked(writeJSON).mockReset().mockResolvedValue(undefined);
		jest.mocked(initializeAsyncServices).mockReset().mockResolvedValue(undefined);
		autoSetup = new AutoSetup();
		wizard = jest.mocked(AIConfigWizard).mock.results[0].value;
		wizard.getActiveConfig.mockResolvedValue({});
		wizard.quickSetup.mockResolvedValue({});
		wizard.runWizard.mockResolvedValue({ enableLocalModels: true });
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	describe('Setup status', () => {
		it('reports incomplete setup without reading a missing status file', async () => {
			await expect(autoSetup.isSetupComplete()).resolves.toBe(false);
			expect(existsSync).toHaveBeenCalledWith(setupPath);
			expect(readJSON).not.toHaveBeenCalled();
		});

		it.each([true, false, 'true', null])(
			'accepts only an explicit completed boolean: %p',
			async (completed) => {
				jest.mocked(existsSync).mockReturnValue(true);
				jest.mocked(readJSON).mockResolvedValue({ completed });
				await expect(autoSetup.isSetupComplete()).resolves.toBe(completed === true);
				expect(readJSON).toHaveBeenCalledWith(setupPath, { completed: false });
			}
		);

		it('reports incomplete setup when reading the status fails', async () => {
			jest.mocked(existsSync).mockReturnValue(true);
			jest.mocked(readJSON).mockRejectedValue(new Error('Status unavailable'));
			await expect(autoSetup.isSetupComplete()).resolves.toBe(false);
		});
	});

	describe('Health checks', () => {
		it('keeps the embedded queue healthy when optional AI is unconfigured', async () => {
			await expect(autoSetup.runHealthChecks()).resolves.toEqual({
				queue: true,
				ai: false,
				overall: true,
				details: [
					'✅ Embedded queue system is ready',
					'⚠️  AI services not configured (optional)',
				],
			});
			expect(wizard.getActiveConfig).toHaveBeenCalledTimes(1);
			expect(initializeAsyncServices).not.toHaveBeenCalled();
		});

		it.each([
			[{ openaiApiKey: 'test-openai-key' }, 'OpenAI'],
			[{ anthropicApiKey: 'test-anthropic-key' }, 'Anthropic'],
			[{ enableLocalModels: true }, 'Local Models'],
		] as const)('reports configured AI %p', async (config, provider) => {
			wizard.getActiveConfig.mockResolvedValue(config);
			const health = await autoSetup.runHealthChecks();
			expect(health).toMatchObject({ queue: true, ai: true, overall: true });
			expect(health.details).toContain(`✅ AI configured: ${provider}`);
		});

		it('reports AI configuration errors without marking the queue unhealthy', async () => {
			wizard.getActiveConfig.mockRejectedValue(new Error('Configuration unavailable'));
			const health = await autoSetup.runHealthChecks();
			expect(health).toMatchObject({ queue: true, ai: false, overall: true });
			expect(health.details).toContain(
				'⚠️  AI check failed: Error: Configuration unavailable'
			);
		});
	});

	describe('Setup process', () => {
		it('initializes services and saves completion while warning about optional AI', async () => {
			const result = await autoSetup.run();
			expect(result).toEqual({
				success: true,
				warnings: ['AI services not configured. Run with --interactive to configure.'],
				errors: [],
			});
			expect(initializeAsyncServices).toHaveBeenCalledWith({ openaiApiKey: undefined });
			expect(mkdirSync).toHaveBeenCalledWith(directory, { recursive: true });
			expect(writeJSON).toHaveBeenCalledWith(setupPath, {
				completed: true,
				timestamp: expect.any(String),
				aiConfigured: undefined,
			});
			expect(jest.mocked(initializeAsyncServices).mock.invocationCallOrder[0]).toBeLessThan(
				jest.mocked(writeJSON).mock.invocationCallOrder[0]
			);
		});

		it('skips every AI configuration path when requested', async () => {
			await expect(autoSetup.run({ skipAI: true })).resolves.toEqual({
				success: true,
				warnings: [],
				errors: [],
			});
			expect(wizard.getActiveConfig).not.toHaveBeenCalled();
			expect(wizard.quickSetup).not.toHaveBeenCalled();
			expect(wizard.runWizard).not.toHaveBeenCalled();
			expect(initializeAsyncServices).toHaveBeenCalledTimes(1);
			expect(writeJSON).toHaveBeenCalledTimes(1);
		});

		it('uses quick setup and passes the requested key to service initialization', async () => {
			const result = await autoSetup.run({ quickSetup: true, openaiApiKey: 'test-key' });
			expect(result).toEqual({ success: true, aiConfigured: true, warnings: [], errors: [] });
			expect(wizard.quickSetup).toHaveBeenCalledWith('test-key');
			expect(wizard.getActiveConfig).not.toHaveBeenCalled();
			expect(wizard.runWizard).not.toHaveBeenCalled();
			expect(initializeAsyncServices).toHaveBeenCalledWith({ openaiApiKey: 'test-key' });
		});

		it('uses the interactive wizard when requested', async () => {
			await expect(autoSetup.run({ interactive: true })).resolves.toMatchObject({
				success: true,
				aiConfigured: true,
			});
			expect(wizard.runWizard).toHaveBeenCalledTimes(1);
			expect(wizard.getActiveConfig).not.toHaveBeenCalled();
			expect(wizard.quickSetup).not.toHaveBeenCalled();
		});

		it('recognizes existing AI configuration without running the wizard', async () => {
			wizard.getActiveConfig.mockResolvedValue({ anthropicApiKey: 'test-key' });
			await expect(autoSetup.run()).resolves.toEqual({
				success: true,
				aiConfigured: true,
				warnings: [],
				errors: [],
			});
			expect(wizard.runWizard).not.toHaveBeenCalled();
		});

		it('skips completed setup unless forced', async () => {
			jest.mocked(existsSync).mockReturnValue(true);
			jest.mocked(readJSON).mockResolvedValue({ completed: true });
			await expect(autoSetup.run()).resolves.toEqual({
				success: true,
				warnings: ['Setup was already completed. Use --force to re-run.'],
				errors: [],
			});
			expect(wizard.getActiveConfig).not.toHaveBeenCalled();
			expect(initializeAsyncServices).not.toHaveBeenCalled();
			expect(writeJSON).not.toHaveBeenCalled();

			await expect(autoSetup.run({ force: true, skipAI: true })).resolves.toMatchObject({
				success: true,
				warnings: [],
			});
			expect(initializeAsyncServices).toHaveBeenCalledTimes(1);
			expect(writeJSON).toHaveBeenCalledTimes(1);
			expect(mkdirSync).not.toHaveBeenCalled();
		});

		it('does not initialize or mark setup complete when AI configuration fails', async () => {
			wizard.getActiveConfig.mockRejectedValue(new Error('Configuration failed'));
			await expect(autoSetup.run()).resolves.toMatchObject({
				success: false,
				errors: ['Setup failed: Error: Configuration failed'],
			});
			expect(initializeAsyncServices).not.toHaveBeenCalled();
			expect(writeJSON).not.toHaveBeenCalled();
		});

		it('does not mark setup complete when service initialization fails', async () => {
			jest.mocked(initializeAsyncServices).mockRejectedValue(
				new Error('Initialization failed')
			);
			await expect(autoSetup.run({ skipAI: true })).resolves.toEqual({
				success: false,
				warnings: [],
				errors: ['Setup failed: Error: Initialization failed'],
			});
			expect(writeJSON).not.toHaveBeenCalled();
		});

		it('reports persistence failure instead of claiming setup succeeded', async () => {
			jest.mocked(writeJSON).mockRejectedValue(new Error('Status write failed'));
			await expect(autoSetup.run({ skipAI: true })).resolves.toEqual({
				success: false,
				warnings: [],
				errors: ['Setup failed: Error: Status write failed'],
			});
			expect(initializeAsyncServices).toHaveBeenCalledTimes(1);
		});
	});

	describe('CLI integration', () => {
		it('applies CLI flags through the real setup workflow and exits successfully', async () => {
			jest.mocked(existsSync).mockReturnValue(true);
			jest.mocked(readJSON).mockResolvedValue({ completed: true });
			const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
				throw new Error('process.exit');
			});

			await expect(AutoSetup.cli(['--force', '--skip-ai'])).rejects.toThrow('process.exit');
			const cliWizard = jest.mocked(AIConfigWizard).mock.results[1]
				.value as jest.Mocked<AIConfigWizard>;
			expect(cliWizard.getActiveConfig).not.toHaveBeenCalled();
			expect(initializeAsyncServices).toHaveBeenCalledTimes(1);
			expect(writeJSON).toHaveBeenCalledTimes(1);
			expect(mockExit).toHaveBeenCalledWith(0);
		});

		it('exits unsuccessfully when setup fails', async () => {
			jest.mocked(initializeAsyncServices).mockRejectedValue(
				new Error('Initialization failed')
			);
			const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
				throw new Error('process.exit');
			});

			await expect(AutoSetup.cli(['--skip-ai'])).rejects.toThrow('process.exit');
			expect(writeJSON).not.toHaveBeenCalled();
			expect(mockExit).toHaveBeenCalledWith(1);
		});
	});
});
