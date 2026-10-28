import {
	getEnv,
	splitIntoSentences,
	splitIntoWords,
	getWordPairs,
	isValidUUID,
	readJSON,
	writeJSON,
} from '../../../src/utils/common.js';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

describe('Common Utilities - New Functions', () => {
	describe('Environment Utilities', () => {
		const originalEnv = process.env;

		beforeEach(() => {
			process.env = { ...originalEnv };
		});

		afterEach(() => {
			process.env = originalEnv;
		});

		describe('getEnv', () => {
			it('should return environment variable value if set', () => {
				process.env.TEST_VAR = 'test_value';
				expect(getEnv('TEST_VAR')).toBe('test_value');
			});

			it('should return default value if env var not set', () => {
				delete process.env.TEST_VAR;
				expect(getEnv('TEST_VAR', 'default')).toBe('default');
			});

			it('should return undefined if no default and env var not set', () => {
				delete process.env.TEST_VAR;
				expect(getEnv('TEST_VAR')).toBeUndefined();
			});

			it('should handle empty string env var', () => {
				process.env.TEST_VAR = '';
				// Empty string is falsy, so should return default
				expect(getEnv('TEST_VAR', 'default')).toBe('default');
			});
		});
	});

	describe('Text Processing Utilities', () => {
		describe('splitIntoSentences', () => {
			it('should split text into sentences', () => {
				const text = 'Hello world. How are you? I am fine! And you...';
				const sentences = splitIntoSentences(text);
				expect(sentences).toEqual([
					'Hello world.',
					'How are you?',
					'I am fine!',
					'And you...',
				]);
			});

			it('should handle text with no sentence endings', () => {
				const text = 'This is a single sentence without ending';
				const sentences = splitIntoSentences(text);
				expect(sentences).toEqual(['This is a single sentence without ending']);
			});

			it('should filter out empty sentences', () => {
				const text = 'First sentence. . . Second sentence!';
				const sentences = splitIntoSentences(text);
				expect(sentences).toEqual(['First sentence. . .', 'Second sentence!']);
			});

			it('should handle empty string', () => {
				expect(splitIntoSentences('')).toEqual([]);
			});

			it('should handle multiple punctuation marks', () => {
				const text = 'Really?! Yes!!! No...';
				const sentences = splitIntoSentences(text);
				expect(sentences).toEqual(['Really?!', 'Yes!!!', 'No...']);
			});
		});

		describe('splitIntoWords', () => {
			it('should extract words from text', () => {
				const text = 'Hello world, how are you?';
				const words = splitIntoWords(text);
				expect(words).toEqual(['Hello', 'world,', 'how', 'are', 'you?']);
			});

			it('should handle text with numbers', () => {
				const text = 'I have 2 cats and 3 dogs';
				const words = splitIntoWords(text);
				expect(words).toEqual(['I', 'have', '2', 'cats', 'and', '3', 'dogs']);
			});

			it('should handle empty string', () => {
				expect(splitIntoWords('')).toEqual([]);
			});

			it('should handle text with special characters', () => {
				const text = 'Hello@world #test $money';
				const words = splitIntoWords(text);
				expect(words).toEqual(['Hello@world', '#test', '$money']);
			});

			it('should handle text with underscores', () => {
				const text = 'snake_case and camelCase';
				const words = splitIntoWords(text);
				expect(words).toEqual(['snake_case', 'and', 'camelCase']);
			});
		});

		describe('getWordPairs', () => {
			it('should generate word pairs from array', () => {
				const words = ['the', 'quick', 'brown', 'fox'];
				const pairs = getWordPairs(words);
				expect(pairs).toEqual([
					['the', 'quick'],
					['quick', 'brown'],
					['brown', 'fox'],
				]);
			});

			it('should handle array with two words', () => {
				const words = ['hello', 'world'];
				const pairs = getWordPairs(words);
				expect(pairs).toEqual([['hello', 'world']]);
			});

			it('should handle array with one word', () => {
				const words = ['single'];
				const pairs = getWordPairs(words);
				expect(pairs).toEqual([]);
			});

			it('should handle empty array', () => {
				const words: string[] = [];
				const pairs = getWordPairs(words);
				expect(pairs).toEqual([]);
			});

			it('should preserve word order', () => {
				const words = ['a', 'b', 'c', 'd', 'e'];
				const pairs = getWordPairs(words);
				expect(pairs.length).toBe(4);
				expect(pairs[0]).toEqual(['a', 'b']);
				expect(pairs[3]).toEqual(['d', 'e']);
			});
		});
	});

	describe('UUID Validation', () => {
		const lower = '550e8400-e29b-41d4-a716-446655440000';
		const upper = lower.toUpperCase();
		it.each([
			{ name: 'standard UUID', id: lower, options: undefined, valid: true },
			{ name: 'uppercase by default', id: upper, options: undefined, valid: true },
			{
				name: 'explicit case insensitivity',
				id: upper,
				options: { caseSensitive: false },
				valid: true,
			},
			{
				name: 'case-sensitive uppercase rejection',
				id: upper,
				options: { caseSensitive: true },
				valid: false,
			},
			{ name: 'numeric rejection by default', id: '12345', options: undefined, valid: false },
			{
				name: 'opt-in numeric IDs',
				id: '12345',
				options: { allowNumeric: true },
				valid: true,
			},
			{ name: 'invalid syntax', id: 'not-a-uuid', options: undefined, valid: false },
			{
				name: 'invalid syntax in numeric mode',
				id: 'not-a-uuid',
				options: { allowNumeric: true },
				valid: false,
			},
			{
				name: 'wrong UUID version',
				id: '550e8400-e29b-31d4-a716-446655440000',
				options: undefined,
				valid: false,
			},
		])('validates $name', ({ id, options, valid }) => {
			expect(isValidUUID(id, options)).toBe(valid);
		});
	});

	describe('JSON File Operations', () => {
		let testDir: string;
		let testFile: string;

		beforeEach(async () => {
			testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-scrivener-'));
			testFile = path.join(testDir, 'test.json');
		});

		afterEach(async () => {
			try {
				await fs.rm(testDir, { recursive: true });
			} catch {
				// Ignore cleanup errors
			}
		});

		describe('readJSON', () => {
			it('should read and parse JSON file', async () => {
				const data = { test: 'value', number: 42 };
				await fs.writeFile(testFile, JSON.stringify(data));

				const result = await readJSON(testFile);
				expect(result).toEqual(data);
			});

			it('should return fallback on parse error', async () => {
				await fs.writeFile(testFile, 'invalid json');
				const fallback = { default: true };

				const result = await readJSON(testFile, fallback);
				expect(result).toEqual(fallback);
			});

			it('should return fallback if file does not exist', async () => {
				const fallback = { default: true };
				const result = await readJSON('/nonexistent/file.json', fallback);
				expect(result).toEqual(fallback);
			});

			it('should throw if no fallback and file does not exist', async () => {
				await expect(readJSON('/nonexistent/file.json')).rejects.toThrow();
			});
		});

		describe('writeJSON', () => {
			it('should write JSON with pretty formatting by default', async () => {
				const data = { test: 'value', nested: { key: 'value' } };
				await writeJSON(testFile, data);

				const content = await fs.readFile(testFile, 'utf-8');
				expect(content).toBe(JSON.stringify(data, null, 2));
			});

			it('should write compact JSON when pretty is false', async () => {
				const data = { test: 'value' };
				await writeJSON(testFile, data, false);

				const content = await fs.readFile(testFile, 'utf-8');
				expect(content).toBe(JSON.stringify(data));
			});

			it('should create directory if it does not exist', async () => {
				const nestedFile = path.join(testDir, 'nested', 'dir', 'file.json');
				const data = { test: 'value' };

				await writeJSON(nestedFile, data);

				const content = await fs.readFile(nestedFile, 'utf-8');
				expect(JSON.parse(content)).toEqual(data);
			});

			it('should handle circular references safely', async () => {
				const data: any = { test: 'value' };
				data.circular = data; // Create circular reference

				// Should not throw
				await writeJSON(testFile, data);

				const content = await fs.readFile(testFile, 'utf-8');
				expect(content).toContain('test');
			});
		});
	});
});
