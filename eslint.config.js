import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierPlugin from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
	{
		ignores: [
			'dist/**',
			'coverage/**',
			'node_modules/**',
			'desktop/i18n/**',
			'desktop/libs/**',
		],
	},
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	prettierConfig,
	{
		files: ['**/*.ts'],
		plugins: {
			prettier: prettierPlugin,
		},
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'module',
			parser: tseslint.parser,
			parserOptions: {
				project: './tsconfig.json',
			},
		},
		rules: {
			'prettier/prettier': 'error',
			'@typescript-eslint/explicit-function-return-type': 'off',
			'@typescript-eslint/no-explicit-any': 'warn',
			'@typescript-eslint/no-unused-vars': [
				'warn',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
				},
			],
			'@typescript-eslint/consistent-type-imports': [
				'error',
				{
					prefer: 'type-imports',
				},
			],
			// In a stdio MCP server only stdout (console.log/info/debug) corrupts the
			// JSON-RPC stream; stderr (console.warn/error) is the correct log channel.
			'no-console': [
				'error',
				{
					allow: ['warn', 'error'],
				},
			],
			'prefer-const': 'error',
			'no-var': 'error',
			'object-shorthand': 'error',
			'prefer-template': 'error',
			'no-useless-assignment': 'warn',
			'no-useless-escape': 'warn',
			'preserve-caught-error': 'warn',
			'@typescript-eslint/no-empty-object-type': 'warn',
			'@typescript-eslint/no-unsafe-function-type': 'warn',
		},
	},
	{
		files: ['**/*.js'],
		rules: {
			'@typescript-eslint/no-var-requires': 'off',
		},
	},
	{
		files: ['**/setup-wizard.ts', 'src/examples/**', 'scripts/**/*'],
		rules: {
			'no-console': 'off', // Standalone CLI/example files with their own stdout
		},
	},
	{
		ignores: [
			'dist/',
			'node_modules/',
			'tests/',
			'*.config.js',
			'scripts/**/*',
			'desktop/i18n/',
			'desktop/libs/',
			'test-langchain-integration.js',
		],
	}
);
