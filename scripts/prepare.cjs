if (!process.env.CI) {
	if (
		!require('node:fs').existsSync(
			require('node:path').join(__dirname, '../assets/c2pa-binding/binding_bg.wasm')
		)
	) {
		require('node:child_process').execFileSync(
			process.execPath,
			[require('node:path').join(__dirname, 'build-c2pa-binding.mjs')],
			{ stdio: 'inherit' }
		);
	}
	require('node:child_process').execFileSync(
		process.execPath,
		[require.resolve('typescript/bin/tsc')],
		{
			stdio: 'inherit',
		}
	);
}
