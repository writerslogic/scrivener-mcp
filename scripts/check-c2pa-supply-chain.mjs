#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GRYPE_VERSION = '0.121.0';
const MIB = 1024 * 1024;
const MAX_FINDINGS = 10_000;
const MAX_DATABASE_AGE = 120 * 60 * 60 * 1000;
const CONFIGURATION = `check-for-app-update: false
add-cpes-if-none: true
only-fixed: false
ignore: []
vex-documents: []
external-sources:
  enable: false
match:
  rust:
    using-cpes: true
  javascript:
    using-cpes: true
db:
  auto-update: false
  validate-age: true
  max-allowed-built-age: 120h
  validate-by-hash-on-start: true
  require-update-check: false
`;

class VerificationError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

function requireCondition(condition, code, message) {
	if (!condition) throw new VerificationError(code, message);
}

function publicError(error) {
	return error instanceof VerificationError
		? { code: error.code, message: error.message }
		: { code: 'IO_FAILED', message: 'Supply-chain evidence could not be read or written.' };
}

function absolutePath(value) {
	requireCondition(
		typeof value === 'string' &&
			value.length <= 4096 &&
			!/[\u0000-\u001f\u007f]/u.test(value) &&
			isAbsolute(value),
		'INVALID_PATH',
		'All supplied paths must be absolute and within the path length limit.'
	);
	return resolve(value);
}

function object(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, maximum = 1024) {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= maximum &&
		!/[\u0000-\u001f\u007f]/u.test(value)
	);
}

function exactKeys(value, keys) {
	return (
		object(value) &&
		Object.keys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

async function readRegularFile(file, maximum, capture = true) {
	const handle = await fs.open(
		file,
		constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
	);
	try {
		const initial = await handle.stat({ bigint: true });
		const entry = await fs.lstat(file, { bigint: true });
		requireCondition(
			initial.isFile() &&
				entry.isFile() &&
				!entry.isSymbolicLink() &&
				initial.dev === entry.dev &&
				initial.ino === entry.ino &&
				initial.size > 0n &&
				initial.size <= BigInt(maximum),
			'INVALID_FILE',
			'Input must be a regular nonempty file within its size limit.'
		);
		const buffer = Buffer.alloc(capture ? Number(initial.size) + 1 : 64 * 1024);
		const hash = createHash('sha256');
		let size = 0;
		for (;;) {
			const offset = capture ? size : 0;
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, size);
			if (!bytesRead) break;
			hash.update(buffer.subarray(offset, offset + bytesRead));
			size += bytesRead;
			requireCondition(
				BigInt(size) <= initial.size,
				'INPUT_CHANGED',
				'Input changed while reading.'
			);
		}
		const [final, current] = await Promise.all([
			handle.stat({ bigint: true }),
			fs.lstat(file, { bigint: true }),
		]);
		requireCondition(
			current.isFile() &&
				!current.isSymbolicLink() &&
				BigInt(size) === initial.size &&
				[final, current].every(
					(info) =>
						info.dev === initial.dev &&
						info.ino === initial.ino &&
						info.size === initial.size &&
						info.mtimeNs === initial.mtimeNs &&
						info.ctimeNs === initial.ctimeNs
				),
			'INPUT_CHANGED',
			'Input changed while reading.'
		);
		return {
			bytes: capture ? buffer.subarray(0, size) : undefined,
			size,
			sha256: hash.digest('hex'),
		};
	} finally {
		await handle.close();
	}
}

function json(bytes, label) {
	try {
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch {
		throw new VerificationError('INVALID_JSON', `${label} must contain valid UTF-8 JSON.`);
	}
}

function validateManifest(value) {
	requireCondition(
		exactKeys(value, ['schemaVersion', 'inventories']) &&
			value.schemaVersion === 1 &&
			Array.isArray(value.inventories) &&
			value.inventories.length >= 1 &&
			value.inventories.length <= 16,
		'INVALID_MANIFEST',
		'Inventory manifest schemaVersion 1 requires between 1 and 16 inventories.'
	);
	const names = new Set();
	for (const inventory of value.inventories) {
		requireCondition(
			exactKeys(inventory, ['name', 'path', 'sha256', 'expectedPackages']) &&
				typeof inventory.name === 'string' &&
				/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(inventory.name) &&
				!/[. ]$/u.test(inventory.name) &&
				!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(inventory.name) &&
				!names.has(inventory.name.toLowerCase()) &&
				typeof inventory.sha256 === 'string' &&
				/^[a-fA-F0-9]{64}$/u.test(inventory.sha256) &&
				Array.isArray(inventory.expectedPackages) &&
				inventory.expectedPackages.length >= 1 &&
				inventory.expectedPackages.length <= 256,
			'INVALID_INVENTORY',
			'Inventories require unique safe names, SHA256 digests and 1 to 256 expected packages.'
		);
		names.add(inventory.name.toLowerCase());
		absolutePath(inventory.path);
		for (const expected of inventory.expectedPackages) {
			requireCondition(
				exactKeys(expected, ['name', 'version']) &&
					text(expected.name, 512) &&
					text(expected.version, 256),
				'INVALID_EXPECTATION',
				'Expected packages require bounded nonempty names and versions.'
			);
		}
	}
	return value.inventories;
}

function inspectInventory(value, expectations) {
	requireCondition(
		object(value) && Array.isArray(value.artifacts) !== Array.isArray(value.components),
		'INVALID_SBOM',
		'SBOM must contain Syft artifacts or CycloneDX components.'
	);
	const packages = [...(Array.isArray(value.artifacts) ? value.artifacts : value.components)];
	requireCondition(
		packages.length <= 100_000,
		'PACKAGE_LIMIT',
		'SBOM package count exceeds its limit.'
	);
	const observed = new Set();
	for (const item of packages) {
		requireCondition(
			object(item) &&
				text(item.name) &&
				(item.version === undefined || item.version === '' || text(item.version)),
			'INVALID_SBOM_PACKAGE',
			'SBOM package metadata is invalid.'
		);
		if (typeof item.version === 'string') {
			observed.add(`${item.name}\0${item.version}`);
			if (value.components && text(item.group))
				observed.add(`${item.group}/${item.name}\0${item.version}`);
		}
		if (value.components && item.components !== undefined) {
			requireCondition(
				Array.isArray(item.components) &&
					packages.length + item.components.length <= 100_000,
				'PACKAGE_LIMIT',
				'Nested CycloneDX components are invalid or exceed the package limit.'
			);
			for (const nested of item.components) packages.push(nested);
		}
	}
	const missing = expectations.filter((item) => !observed.has(`${item.name}\0${item.version}`));
	return {
		format: value.artifacts ? 'syft-json' : 'cyclonedx-json',
		packageCount: packages.length,
		missingExpectedPackages: missing,
	};
}

async function writePrivate(file, bytes) {
	const temporary = join(dirname(file), `.${randomUUID()}.tmp`);
	try {
		await fs.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
		await fs.rename(temporary, file);
	} finally {
		await fs.rm(temporary, { force: true });
	}
}

function scannerEnvironment() {
	const env = {};
	for (const key of [
		'PATH',
		'SystemRoot',
		'WINDIR',
		'HOME',
		'USERPROFILE',
		'LOCALAPPDATA',
		'XDG_CACHE_HOME',
		'TMPDIR',
		'TEMP',
		'TMP',
	]) {
		if (process.env[key] !== undefined) env[key] = process.env[key];
	}
	if (process.env.GRYPE_DB_CACHE_DIR !== undefined)
		env.GRYPE_DB_CACHE_DIR = absolutePath(process.env.GRYPE_DB_CACHE_DIR);
	return Object.assign(env, {
		GRYPE_DB_AUTO_UPDATE: 'false',
		GRYPE_DB_VALIDATE_AGE: 'true',
		GRYPE_DB_MAX_ALLOWED_BUILT_AGE: '120h',
		GRYPE_DB_VALIDATE_BY_HASH_ON_START: 'true',
		GRYPE_CHECK_FOR_APP_UPDATE: 'false',
		GRYPE_EXTERNAL_SOURCES_ENABLE: 'false',
		GRYPE_MATCH_RUST_USING_CPES: 'true',
		GRYPE_MATCH_JAVASCRIPT_USING_CPES: 'true',
		NO_COLOR: '1',
	});
}

async function executeScanner(
	command,
	args,
	{ output, env, signal, name, maximum = MIB, timeout = 30_000 }
) {
	requireCondition(!signal.aborted, 'INTERRUPTED', 'Supply-chain verification was interrupted.');
	const started = Date.now();
	const execution = await new Promise((resolveExecution) => {
		const child = spawn(command, args, {
			cwd: output,
			env,
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const stdout = [];
		const stderr = [];
		let stdoutSize = 0;
		let stderrSize = 0;
		let failure;
		const stop = (code) => {
			failure ??= code;
			child.kill('SIGKILL');
		};
		const interrupted = () => stop('INTERRUPTED');
		const timer = setTimeout(() => stop('SCANNER_TIMEOUT'), timeout);
		signal.addEventListener('abort', interrupted, { once: true });
		if (signal.aborted) interrupted();
		child.stdout.on('data', (chunk) => {
			const remaining = maximum - stdoutSize;
			if (remaining > 0) stdout.push(chunk.subarray(0, remaining));
			stdoutSize += Math.min(chunk.length, Math.max(remaining, 0));
			if (chunk.length > remaining) stop('SCANNER_OUTPUT_LIMIT');
		});
		child.stderr.on('data', (chunk) => {
			const remaining = 256 * 1024 - stderrSize;
			if (remaining > 0) stderr.push(chunk.subarray(0, remaining));
			stderrSize += Math.min(chunk.length, Math.max(remaining, 0));
			if (chunk.length > remaining) stop('SCANNER_OUTPUT_LIMIT');
		});
		child.stdout.on('error', () => stop('SCANNER_IO_FAILED'));
		child.stderr.on('error', () => stop('SCANNER_IO_FAILED'));
		child.on('error', () => {
			failure ??= 'SCANNER_UNAVAILABLE';
		});
		child.once('close', (exitCode, terminationSignal) => {
			clearTimeout(timer);
			signal.removeEventListener('abort', interrupted);
			resolveExecution({
				exitCode,
				signal: terminationSignal,
				error: failure ?? null,
				stdout: Buffer.concat(stdout, stdoutSize),
				stderr: Buffer.concat(stderr, stderrSize),
			});
		});
	});
	const stdoutFile = `${name}.json`;
	const stderrFile = `${name}.stderr.log`;
	await writePrivate(join(output, stdoutFile), execution.stdout);
	await writePrivate(join(output, stderrFile), execution.stderr);
	const { stdout, stderr, ...status } = execution;
	return {
		...status,
		elapsedMs: Date.now() - started,
		stdoutFile,
		stderrFile,
		stdoutSha256: sha256(stdout),
		stdout,
	};
}

function successfulExecution(execution) {
	requireCondition(
		!execution.error && execution.exitCode === 0 && execution.signal === null,
		execution.error ?? 'SCANNER_FAILED',
		'Grype did not complete successfully; private command evidence was preserved.'
	);
}

function databaseStatus(value) {
	const built = Date.parse(value?.built);
	const schema = String(value?.schemaVersion ?? '');
	requireCondition(
		object(value) &&
			value.valid === true &&
			!value.error &&
			/^v?6(?:\.\d+){0,2}$/u.test(schema) &&
			text(value.built, 64) &&
			Number.isFinite(built) &&
			built <= Date.now() + 5 * 60 * 1000 &&
			Date.now() - built <= MAX_DATABASE_AGE &&
			text(value.path, 4096) &&
			(value.from === undefined || value.from === '' || text(value.from, 4096)),
		'INVALID_DATABASE',
		'Grype requires an available valid schema-6 database built within the last 120 hours.'
	);
	return {
		schemaVersion: value.schemaVersion,
		built: value.built,
		path: value.path,
		from: value.from ?? null,
	};
}

function findings(value, database, available) {
	requireCondition(
		object(value) &&
			value.descriptor?.name === 'grype' &&
			value.descriptor.version === GRYPE_VERSION &&
			Array.isArray(value.matches) &&
			value.matches.length <= available &&
			(value.ignoredMatches === undefined || Array.isArray(value.ignoredMatches)),
		'INVALID_SCAN_REPORT',
		'Grype report is invalid or exceeds the aggregate finding limit.'
	);
	requireCondition(
		JSON.stringify(databaseStatus(value.descriptor.db?.status)) === JSON.stringify(database),
		'DATABASE_CHANGED',
		'Grype database identity changed during verification.'
	);
	const counts = { unknown: 0, negligible: 0, low: 0, medium: 0, high: 0, critical: 0 };
	const normalized = value.matches.map((match) => {
		const vulnerability = match?.vulnerability;
		const severity =
			typeof vulnerability?.severity === 'string' ? vulnerability.severity.toLowerCase() : '';
		const fix = vulnerability?.fix;
		requireCondition(
			object(match?.artifact) &&
				text(match.artifact.name) &&
				text(match.artifact.version) &&
				text(vulnerability?.id, 256) &&
				Object.hasOwn(counts, severity) &&
				(vulnerability.namespace === undefined || text(vulnerability.namespace, 512)) &&
				(fix === undefined ||
					fix === null ||
					(object(fix) &&
						(fix.state === '' || text(fix.state, 64)) &&
						Array.isArray(fix.versions) &&
						fix.versions.length <= 16 &&
						fix.versions.every((version) => text(version, 128)))),
			'INVALID_FINDING',
			'Grype finding metadata is invalid.'
		);
		counts[severity]++;
		return {
			id: vulnerability.id,
			severity,
			package: match.artifact.name,
			version: match.artifact.version,
			namespace: vulnerability.namespace ?? null,
			fix: fix ? { state: fix.state, versions: fix.versions } : null,
		};
	});
	return { counts, findings: normalized, ignoredFindingCount: value.ignoredMatches?.length ?? 0 };
}

export async function verifyC2paSupplyChain(options) {
	requireCondition(
		object(options) &&
			['grype', 'manifest', 'output'].every((key) => Object.hasOwn(options, key)) &&
			Object.keys(options).every((key) =>
				['grype', 'manifest', 'output', 'vex'].includes(key)
			),
		'INVALID_OPTIONS',
		'Expected --grype ABS --manifest ABS --output ABS [--vex ABS].'
	);
	const paths = Object.fromEntries(
		Object.entries(options).map(([key, value]) => [key, absolutePath(value)])
	);
	requireCondition(
		paths.output !== dirname(paths.output),
		'INVALID_OUTPUT',
		'Output must be a new directory.'
	);
	const output = join(await fs.realpath(dirname(paths.output)), basename(paths.output));
	try {
		await fs.mkdir(output, { mode: 0o700 });
	} catch {
		throw new VerificationError(
			'OUTPUT_UNAVAILABLE',
			'Output must be a new directory in an existing writable parent.'
		);
	}
	const report = {
		schemaVersion: 1,
		ok: false,
		startedAt: new Date().toISOString(),
		policy: {
			grypeVersion: GRYPE_VERSION,
			failOn: 'high',
			databaseMaximumAgeHours: 120,
			rustCpeMatching: true,
			javascriptCpeMatching: true,
			databaseAutoUpdate: false,
		},
		sourceInventorySha256: null,
		tool: null,
		database: null,
		vex: null,
		inventories: [],
		errors: [],
	};
	const controller = new AbortController();
	const interrupted = () => controller.abort();
	process.once('SIGINT', interrupted);
	process.once('SIGTERM', interrupted);
	try {
		const manifest = await readRegularFile(paths.manifest, 128 * 1024);
		report.sourceInventorySha256 = manifest.sha256;
		const inventories = validateManifest(json(manifest.bytes, 'Inventory manifest'));
		await writePrivate(join(output, 'input-manifest.json'), manifest.bytes);
		await writePrivate(join(output, 'grype.yaml'), CONFIGURATION);
		const vexArguments = [];
		if (paths.vex) {
			const vex = await readRegularFile(paths.vex, 8 * MIB);
			requireCondition(
				object(json(vex.bytes, 'VEX')),
				'INVALID_VEX',
				'VEX must contain a JSON object.'
			);
			const staged = join(output, 'input-vex.json');
			await writePrivate(staged, vex.bytes);
			report.vex = { sha256: vex.sha256, evidenceFile: 'input-vex.json' };
			vexArguments.push('--vex', staged);
		}
		let command;
		let executable;
		try {
			command = await fs.realpath(paths.grype);
			await fs.access(command, constants.X_OK);
			executable = await readRegularFile(command, 256 * MIB, false);
		} catch (error) {
			if (error instanceof VerificationError) throw error;
			throw new VerificationError(
				'SCANNER_UNAVAILABLE',
				'The supplied Grype executable is unavailable or not executable.'
			);
		}
		const env = scannerEnvironment();
		const base = ['--config', join(output, 'grype.yaml')];
		const run = (args, name, maximum, timeout) =>
			executeScanner(command, [...args, ...base], {
				output,
				env,
				signal: controller.signal,
				name,
				maximum,
				timeout,
			});
		const versionResult = await run(['version', '-o', 'json'], 'tool-version', 64 * 1024);
		successfulExecution(versionResult);
		const version = json(versionResult.stdout, 'Grype version');
		report.tool = {
			version: version?.version ?? null,
			sha256: executable.sha256,
			metadata: version,
		};
		requireCondition(
			version?.application === 'grype' && version.version === GRYPE_VERSION,
			'WRONG_GRYPE_VERSION',
			`Grype ${GRYPE_VERSION} is required.`
		);
		const before = await run(['db', 'status', '-o', 'json'], 'database-before');
		successfulExecution(before);
		report.database = databaseStatus(json(before.stdout, 'Grype database status'));
		let remainingFindings = MAX_FINDINGS;
		for (const inventory of inventories) {
			const entry = {
				name: inventory.name,
				sourceSha256: inventory.sha256.toLowerCase(),
				expectedPackages: inventory.expectedPackages,
				ok: false,
			};
			report.inventories.push(entry);
			try {
				const input = await readRegularFile(inventory.path, 64 * MIB);
				requireCondition(
					input.sha256 === entry.sourceSha256,
					'SBOM_DIGEST_MISMATCH',
					'SBOM bytes do not match the inventory digest.'
				);
				Object.assign(
					entry,
					inspectInventory(json(input.bytes, 'SBOM'), inventory.expectedPackages)
				);
				requireCondition(
					entry.missingExpectedPackages.length === 0,
					'MISSING_EXPECTED_PACKAGE',
					'SBOM is missing an expected package name and version.'
				);
				const staged = `${inventory.name}.sbom.json`;
				await writePrivate(join(output, staged), input.bytes);
				entry.evidenceFile = staged;
				const execution = await run(
					[
						'sbom:' + join(output, staged),
						'--add-cpes-if-none',
						'--fail-on',
						'high',
						'-o',
						'json',
						...vexArguments,
					],
					`scan-${inventory.name}`,
					64 * MIB,
					120_000
				);
				const { stdout, ...commandResult } = execution;
				entry.execution = commandResult;
				requireCondition(
					!execution.error && execution.signal === null,
					execution.error ?? 'SCANNER_FAILED',
					'Grype execution failed; private command evidence was preserved.'
				);
				Object.assign(
					entry,
					findings(json(stdout, 'Grype report'), report.database, remainingFindings)
				);
				remainingFindings -= entry.findings.length;
				requireCondition(
					entry.counts.high + entry.counts.critical === 0,
					'SEVERITY_THRESHOLD',
					'Grype reported findings at or above high severity.'
				);
				successfulExecution(execution);
				entry.ok = true;
			} catch (error) {
				entry.error = publicError(error);
			}
		}
		const after = await run(['db', 'status', '-o', 'json'], 'database-after');
		successfulExecution(after);
		requireCondition(
			JSON.stringify(databaseStatus(json(after.stdout, 'Grype database status'))) ===
				JSON.stringify(report.database),
			'DATABASE_CHANGED',
			'Grype database identity changed during verification.'
		);
		report.ok =
			!controller.signal.aborted && report.inventories.every((inventory) => inventory.ok);
	} catch (error) {
		report.errors.push(publicError(error));
	} finally {
		process.removeListener('SIGINT', interrupted);
		process.removeListener('SIGTERM', interrupted);
		report.finishedAt = new Date().toISOString();
		let serialized = JSON.stringify(report, null, 2) + '\n';
		if (Buffer.byteLength(serialized) > 64 * MIB) {
			report.ok = false;
			report.errors.push({
				code: 'AGGREGATE_LIMIT',
				message:
					'Aggregate finding detail exceeded its limit; complete individual reports remain available.',
			});
			for (const inventory of report.inventories) {
				if (inventory.findings) {
					inventory.findingCount = inventory.findings.length;
					inventory.findingsFile = inventory.execution.stdoutFile;
					delete inventory.findings;
				}
			}
			serialized = JSON.stringify(report, null, 2) + '\n';
		}
		await writePrivate(join(output, 'report.json'), serialized);
	}
	return report;
}

function argumentsFromCLI(values) {
	const options = {};
	for (let index = 0; index < values.length; index += 2) {
		const flag = values[index];
		requireCondition(
			['--grype', '--manifest', '--output', '--vex'].includes(flag) &&
				!Object.hasOwn(options, flag.slice(2)) &&
				values[index + 1] !== undefined,
			'INVALID_OPTIONS',
			'Expected --grype ABS --manifest ABS --output ABS [--vex ABS].'
		);
		options[flag.slice(2)] = values[index + 1];
	}
	return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const report = await verifyC2paSupplyChain(argumentsFromCLI(process.argv.slice(2)));
		console.log(
			JSON.stringify({
				ok: report.ok,
				passed: report.inventories.filter((item) => item.ok).length,
				total: report.inventories.length,
				errorCodes: [
					...report.errors,
					...report.inventories.flatMap((item) => (item.error ? [item.error] : [])),
				].map((error) => error.code),
			})
		);
		process.exitCode = report.ok ? 0 : 1;
	} catch (error) {
		console.error(JSON.stringify({ ok: false, error: publicError(error) }));
		process.exitCode = 1;
	}
}
