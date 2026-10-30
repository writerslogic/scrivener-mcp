import { isAbsolute, join } from 'node:path';

export function credentialProcessEnvironment(): NodeJS.ProcessEnv {
	const names = ['PATH', 'TMPDIR', 'TEMP', 'TMP'];
	if (process.platform === 'win32')
		names.push(
			'SystemRoot',
			'WINDIR',
			'SystemDrive',
			'ProgramFiles',
			'ProgramFiles(x86)',
			'ProgramW6432',
			'CommonProgramFiles',
			'CommonProgramFiles(x86)',
			'CommonProgramW6432',
			'ProgramData',
			'ALLUSERSPROFILE',
			'USERPROFILE',
			'APPDATA',
			'LOCALAPPDATA',
			'ComSpec',
			'PATHEXT',
			'PROCESSOR_ARCHITECTURE',
			'OS'
		);
	const environment: NodeJS.ProcessEnv = {};
	for (const name of names) if (process.env[name]) environment[name] = process.env[name];
	const systemRoot = environment.SystemRoot ?? environment.WINDIR;
	if (systemRoot && isAbsolute(systemRoot)) {
		environment.SystemRoot = systemRoot;
		environment.WINDIR = systemRoot;
		environment.PSModulePath = join(systemRoot, 'System32/WindowsPowerShell/v1.0/Modules');
	}
	return environment;
}
