import { availableParallelism } from 'node:os';

/** @type {import('jest').Config} */
export default {
	preset: 'ts-jest/presets/default-esm',
	testEnvironment: 'node',
	maxWorkers: Math.min(4, Math.max(1, availableParallelism() - 1)),
	extensionsToTreatAsEsm: ['.ts'],
	moduleNameMapper: {
		'^(.*/(?:native-loader|worker-path))\\.cjs$': '$1.cts',
		'^(\\.{1,2}/.*)\\.js$': '$1',
	},
	transform: {
		'^.+\\.cts$': [
			'ts-jest',
			{ tsconfig: { module: 'commonjs', target: 'es2022' }, useESM: false },
		],
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
		'/node_modules/(?!(@modelcontextprotocol|chalk|cheerio|syllable|turndown|compromise|compromise-dates|compromise-numbers|compromise-adjectives)/)',
	],
	roots: ['<rootDir>/src', '<rootDir>/tests'],
	testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
	collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/**/__tests__/**', '!src/index.ts'],
	testPathIgnorePatterns: ['/node_modules/'],
	coverageThreshold: {
		global: {
			branches: 5,
			functions: 5,
			lines: 5,
			statements: 5,
		},
	},
	setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
	testTimeout: 30000,
	verbose: true,
};
