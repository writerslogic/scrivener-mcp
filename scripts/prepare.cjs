if (!process.env.CI) {
	require('node:child_process').execFileSync(
		process.execPath,
		[require.resolve('typescript/bin/tsc')],
		{
			stdio: 'inherit',
		}
	);
}
