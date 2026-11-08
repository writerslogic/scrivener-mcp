import { availableParallelism } from 'node:os';

/** @type {import('jest').Config} */
export default {
	preset: 'ts-jest/presets/default-esm',
	testEnvironment: 'node',
	maxWorkers: Math.min(4, Math.max(1, availableParallelism() - 1)),
	extensionsToTreatAsEsm: ['.ts'],
	moduleNameMapper: {
		'^(.*/(?:native-loader|worker-path|lens-native|crjson-assessment-assets))\\.cjs$': '$1.cts',
		'^(\\.{1,2}/.*)\\.js$': '$1',
	},
	transform: {
		[/^.+[\\/]node_modules[\\/](?:asn1js|@peculiar[\\/]utils)[\\/].+\.js$/.source]: [
			'ts-jest',
			{ tsconfig: { allowJs: true, module: 'commonjs', target: 'es2022' }, useESM: false },
		],
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
		'/node_modules/(?!(@modelcontextprotocol|@peculiar/utils|asn1js|cheerio|syllable|turndown|compromise|compromise-dates|compromise-numbers|compromise-adjectives)/)',
	],
	roots: ['<rootDir>/src', '<rootDir>/tests'],
	testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
	collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/**/__tests__/**', '!src/index.ts'],
	testPathIgnorePatterns: ['/node_modules/'],
	coverageThreshold: {
		global: {
			branches: 60,
			functions: 65,
			lines: 65,
			statements: 65,
		},
		...Object.fromEntries(
			[
				'./src/core/response-formatter.ts',
				'./src/handlers/database/content-analysis-storage.ts',
				'./src/handlers/database/keydb-cache.ts',
				'./src/services/editorial/mutation-coordinator.ts',
				'./src/services/editorial/persistent-store.ts',
				'./src/services/editorial/project-source.ts',
			].map((path) => [path, { branches: 80, functions: 85, lines: 85, statements: 85 }])
		),
	},
	setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
	testTimeout: 30000,
	verbose: true,
};
