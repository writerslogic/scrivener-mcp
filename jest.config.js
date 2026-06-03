/** @type {import('jest').Config} */
export default {
	preset: 'ts-jest/presets/default-esm',
	testEnvironment: 'node',
	extensionsToTreatAsEsm: ['.ts'],
	moduleNameMapper: {
		'^(\\.{1,2}/.*)\\.js$': '$1',
		'^@langchain/core/(.*)$': '<rootDir>/node_modules/@langchain/core/$1.js',
		'^@langchain/openai$': '<rootDir>/node_modules/@langchain/openai/dist/index.js',
		'^@langchain/community/(.*)$': '<rootDir>/node_modules/@langchain/community/$1.js',
		'^@langchain/textsplitters$': '<rootDir>/node_modules/@langchain/textsplitters/dist/index.js',
		'^@langchain/classic/(.*)$': '<rootDir>/node_modules/@langchain/classic/$1.js',
	},
	transform: {
		'^.+\\.tsx?$': [
			'ts-jest',
			{
				useESM: true,
				tsconfig: {
					module: 'esnext',
					target: 'es2022',
					experimentalDecorators: true,
					emitDecoratorMetadata: true,
				},
			},
		],
	},
	transformIgnorePatterns: [
		'/node_modules/(?!(@langchain|langchain|@modelcontextprotocol|chalk|cheerio|syllable|turndown|compromise|compromise-dates|compromise-numbers|compromise-adjectives)/)',
	],
	roots: ['<rootDir>/src', '<rootDir>/tests'],
	testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
	collectCoverageFrom: [
		'src/**/*.ts',
		'!src/**/*.d.ts',
		'!src/**/__tests__/**',
		'!src/index.ts',
	],
	coverageThreshold: {
		global: {
			branches: 80, // Lowered slightly to allow for migration progress
			functions: 80,
			lines: 80,
			statements: 80,
		},
	},
	setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
	testTimeout: 30000,
	verbose: true,
};