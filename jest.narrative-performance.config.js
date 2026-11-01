import base from './jest.config.js';

// Keep the TypeScript program out of runtime RSS measurements; correctness suites use the base config.
export default {
	...base,
	maxWorkers: 1,
	testMatch: ['**/integration/narrative-novels.test.ts'],
	globals: { narrativeBenchmarkCompiler: 'isolatedModules' },
	transform: Object.fromEntries(
		Object.entries(base.transform).map(([pattern, [transformer, options]]) => [
			pattern,
			[transformer, { ...options, tsconfig: { ...options.tsconfig, isolatedModules: true } }],
		])
	),
};
