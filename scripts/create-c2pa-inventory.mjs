#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { readReleaseFile } from './check-release-candidate.mjs';
import { checkC2paBinding } from './check-c2pa-binding.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);
const MIB = 1024 * 1024;
const SYFT_VERSION = '1.55.0';
const SHA256 = /^[a-f0-9]{64}$/u;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+~-]{0,127}$/u;
const RUST_SCOPE =
	'Conservative Cargo.lock inventory: includes all recorded targets, optional, development and build dependencies; not an exact linked dependency graph.';
const CONFIGURATION = `check-for-app-update: false
parallelism: 1
javascript:
  include-dev-dependencies: true
  search-remote-licenses: false
`;

class InventoryError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

function requireCondition(condition, code, message) {
	if (!condition) throw new InventoryError(code, message);
}

function object(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value, maximum = 1024) {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= maximum &&
		!/[\u0000-\u001f\u007f]/u.test(value)
	);
}

function validVersion(value) {
	return typeof value === 'string' && VERSION.test(value);
}

function absolutePath(value) {
	requireCondition(
		boundedText(value, 4096) && isAbsolute(value),
		'INVALID_PATH',
		'Tool, output and root paths must be bounded absolute paths.'
	);
	return resolve(value);
}

function digest(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

function parseJSON(bytes, label) {
	try {
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch {
		throw new InventoryError('INVALID_JSON', `${label} must contain valid UTF-8 JSON.`);
	}
}

function publicError(error) {
	return error instanceof InventoryError
		? { code: error.code, message: error.message }
		: {
				code: 'INPUT_IO_FAILED',
				message: 'Inventory inputs or private evidence could not be read or written.',
			};
}

async function writePrivate(file, bytes) {
	const temporary = join(dirname(file), `.${randomUUID()}.tmp`);
	try {
		await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
		await fs.rename(temporary, file);
	} finally {
		await fs.rm(temporary, { force: true });
	}
}

async function writeJSON(file, value) {
	const bytes = JSON.stringify(value, null, 2) + '\n';
	requireCondition(
		Buffer.byteLength(bytes) <= 64 * MIB,
		'OUTPUT_LIMIT',
		'Generated inventory exceeds 64 MiB.'
	);
	await writePrivate(file, bytes);
	return { bytes: Buffer.byteLength(bytes), sha256: digest(bytes) };
}

function scannerEnvironment() {
	const env = {};
	for (const name of [
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
	])
		if (process.env[name] !== undefined) env[name] = process.env[name];
	return Object.assign(env, {
		SYFT_CHECK_FOR_APP_UPDATE: 'false',
		SYFT_PARALLELISM: '1',
		SYFT_JAVASCRIPT_SEARCH_REMOTE_LICENSES: 'false',
		SYFT_JAVASCRIPT_INCLUDE_DEV_DEPENDENCIES: 'true',
		NO_COLOR: '1',
	});
}

async function syftCommand(command, args, output, name, signal, maximum = 64 * MIB) {
	let result;
	let failed = false;
	try {
		const pending = execute(command, [...args, '--config', join(output, 'syft.yaml')], {
			cwd: output,
			env: scannerEnvironment(),
			encoding: 'buffer',
			signal,
			timeout: 120_000,
			killSignal: 'SIGKILL',
			maxBuffer: maximum,
			windowsHide: true,
		});
		pending.child.stdin?.end();
		result = await pending;
	} catch (error) {
		failed = true;
		result = {
			stdout: error.stdout ?? Buffer.alloc(0),
			stderr: error.stderr ?? Buffer.alloc(0),
		};
	}
	const stdout = (
		Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout)
	).subarray(0, maximum);
	const stderr = (
		Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr)
	).subarray(0, maximum);
	await writePrivate(join(output, `${name}.stderr.log`), stderr);
	await writePrivate(join(output, `${name}.json`), stdout);
	requireCondition(
		!failed,
		'SYFT_FAILED',
		'Syft failed or exceeded its resource limit; private command evidence was preserved.'
	);
	return stdout;
}

function requirePackages(value, expectedPackages) {
	requireCondition(
		object(value) && Array.isArray(value.artifacts) && value.artifacts.length <= 100_000,
		'INVALID_SYFT_REPORT',
		'Syft must emit a bounded package inventory.'
	);
	const packages = new Set();
	for (const item of value.artifacts) {
		requireCondition(
			object(item) && boundedText(item.name) && boundedText(item.version),
			'INVALID_SYFT_PACKAGE',
			'Syft emitted invalid package metadata.'
		);
		packages.add(`${item.name}\0${item.version}`);
	}
	requireCondition(
		expectedPackages.every((item) => packages.has(`${item.name}\0${item.version}`)),
		'MISSING_EXPECTED_PACKAGE',
		'Syft inventory is missing a required package name and version.'
	);
}

function runtimeComponent(name, version, evidence, executableHash, identity, id = name) {
	requireCondition(
		validVersion(version),
		'INVALID_RUNTIME_VERSION',
		'Runtime reported an unsupported component version format.'
	);
	const component = {
		type: name === 'node' ? 'application' : 'library',
		'bom-ref': `runtime:${id}`,
		name,
		version,
		purl: `pkg:generic/${encodeURIComponent(name)}@${encodeURIComponent(version)}`,
		properties: [
			{ name: 'scrivener:versionEvidence', value: evidence },
			{ name: 'scrivener:nodeExecutableSHA256', value: executableHash },
		],
	};
	if (identity) {
		const encoded = version.replace(/[^A-Za-z0-9._-]/gu, (character) => `\\${character}`);
		component.cpe = `cpe:2.3:a:${identity.vendor}:${identity.product}:${encoded}:*:*:*:*:*:*:*`;
		component.properties.push({ name: 'scrivener:cpeMappingEvidence', value: identity.source });
	}
	if (name === 'node') component.hashes = [{ alg: 'SHA-256', content: executableHash }];
	return component;
}

const RUNTIME_IDENTITIES = {
	node: {
		vendor: 'nodejs',
		product: 'node.js',
		source: 'https://github.com/anchore/syft/blob/v1.55.0/syft/pkg/cataloger/binary/classifiers.go#L205',
	},
	openssl: {
		vendor: 'openssl',
		product: 'openssl',
		source: 'https://github.com/anchore/syft/blob/v1.55.0/syft/pkg/cataloger/binary/classifiers.go#L770',
	},
	sqlite: {
		vendor: 'sqlite',
		product: 'sqlite',
		source: 'https://nvd.nist.gov/products/cpe/search/results?keyword=cpe%3A2.3%3Aa%3Asqlite%3Asqlite',
	},
	uv: {
		vendor: 'libuv',
		product: 'libuv',
		source: 'https://nvd.nist.gov/vuln/detail/CVE-2024-24806',
	},
	brotli: {
		vendor: 'google',
		product: 'brotli',
		source: 'https://nvd.nist.gov/products/cpe/detail/ecbe8552-a241-4f9b-a56f-50f1e727c616',
	},
	v8: {
		vendor: 'google',
		product: 'v8',
		source: 'https://nvd.nist.gov/products/cpe/search/results?keyword=cpe%3A2.3%3Aa%3Agoogle%3Av8',
	},
};

function cyclonedx(pkg, components, coverage) {
	return {
		bomFormat: 'CycloneDX',
		specVersion: '1.6',
		serialNumber: `urn:uuid:${randomUUID()}`,
		version: 1,
		metadata: {
			timestamp: new Date().toISOString(),
			component: { type: 'application', name: pkg.name, version: pkg.version },
		},
		components,
		properties: [{ name: 'scrivener:coverage', value: coverage }],
	};
}

async function sqliteEvidence(root) {
	const require = createRequire(join(root, 'package.json'));
	let database;
	try {
		const Database = require('better-sqlite3');
		database = new Database(':memory:');
		const row = database.prepare('SELECT sqlite_version() AS version').get();
		requireCondition(
			object(row) && validVersion(row.version),
			'SQLITE_QUERY_FAILED',
			'In-memory SQLite did not return a valid version.'
		);
		const loadedNativeFiles = Object.keys(require.cache).filter(
			(file) =>
				file.endsWith('.node') &&
				file.startsWith(join(root, 'node_modules', 'better-sqlite3') + sep)
		);
		return {
			available: true,
			version: row.version,
			loadedNativeFiles,
			method: 'better-sqlite3 :memory: SELECT sqlite_version()',
		};
	} catch (error) {
		if (database || error instanceof InventoryError) throw error;
		return {
			available: false,
			reason: 'Installed better-sqlite3 native binding could not be loaded; its SQLite version is unverified.',
		};
	} finally {
		if (database) database.close();
	}
}

function platformCandidate(file) {
	const platforms =
		file.match(
			/(?:^|[-_/.])(darwin|win32|windows|linuxmusl|linux|freebsd|android)(?=[-_/.]|$)/gu
		) ?? [];
	const architectures =
		file.match(/(?:^|[-_/.])(x86_64|aarch64|armv7|i686|x64|arm64|ia32|arm)(?=[-_/.]|$)/gu) ??
		[];
	const clean = (value) => value.replace(/^[-_/.]/u, '');
	const aliases = { x86_64: 'x64', aarch64: 'arm64', i686: 'ia32', armv7: 'arm' };
	return (
		(platforms.length === 0 ||
			platforms.some((value) => {
				const platform = clean(value);
				return (
					platform === process.platform ||
					(platform === 'linuxmusl' && process.platform === 'linux') ||
					(platform === 'windows' && process.platform === 'win32')
				);
			})) &&
		(architectures.length === 0 ||
			architectures.some((value) => (aliases[clean(value)] ?? clean(value)) === process.arch))
	);
}

async function nativeFiles(root, sqlite, lock) {
	const directory = join(root, 'node_modules');
	let entries;
	try {
		entries = await fs.readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (error.code === 'ENOENT') return { files: [], packages: [], unavailable: true };
		throw error;
	}
	requireCondition(
		entries.length <= 8192,
		'NATIVE_DIRECTORY_LIMIT',
		'Installed package directory exceeds its entry limit.'
	);
	const files = [];
	const packages = [];
	const excludedDirectories = [];
	let visited = 0;
	let totalBytes = 0;
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (
			!/^(?:bluepencil-node|narrative-lens|holographic-memory)(?:-|$)|^better-sqlite3$/u.test(
				entry.name
			)
		)
			continue;
		requireCondition(
			entry.isDirectory() && !entry.isSymbolicLink(),
			'NATIVE_SYMLINK',
			'Native package roots must be ordinary directories.'
		);
		const base = join(directory, entry.name);
		const metadataBytes = await readReleaseFile(join(base, 'package.json'), 128 * 1024);
		const metadata = parseJSON(metadataBytes, 'Installed native package metadata');
		requireCondition(
			metadata.name === entry.name && boundedText(metadata.version, 128),
			'INVALID_NATIVE_PACKAGE',
			'Installed native package metadata is inconsistent.'
		);
		requireCondition(
			lock.packages[`node_modules/${entry.name}`]?.version === metadata.version,
			'NATIVE_VERSION_MISMATCH',
			'Installed native package versions must match the npm lock.'
		);
		packages.push({
			name: metadata.name,
			version: metadata.version,
			metadataSHA256: digest(metadataBytes),
		});
		const pending = [{ path: base, depth: 0 }];
		while (pending.length) {
			const current = pending.pop();
			const children = await fs.readdir(current.path, { withFileTypes: true });
			visited += children.length;
			requireCondition(
				visited <= 8192,
				'NATIVE_DIRECTORY_LIMIT',
				'Native package traversal exceeds its entry limit.'
			);
			for (const child of children) {
				if (
					child.isDirectory() &&
					(child.name === 'node_modules' || child.name === '.git')
				) {
					excludedDirectories.push(
						relative(root, join(current.path, child.name)).split(sep).join('/')
					);
					continue;
				}
				requireCondition(
					!child.isSymbolicLink(),
					'NATIVE_SYMLINK',
					'Native package inventories do not follow symbolic links.'
				);
				const file = join(current.path, child.name);
				if (child.isDirectory()) {
					requireCondition(
						current.depth < 5,
						'NATIVE_DIRECTORY_LIMIT',
						'Native package traversal exceeds its depth limit.'
					);
					pending.push({ path: file, depth: current.depth + 1 });
				} else if (child.name.endsWith('.node')) {
					const bytes = await readReleaseFile(file, 128 * MIB);
					totalBytes += bytes.length;
					requireCondition(
						files.length < 64 && totalBytes <= 512 * MIB,
						'NATIVE_ALLOCATION_LIMIT',
						'Native binary inventory exceeds its file or byte limit.'
					);
					files.push({
						file: relative(root, file).split(sep).join('/'),
						bytes: bytes.length,
						sha256: digest(bytes),
						package: metadata.name,
						version: metadata.version,
						loadedForSqliteQuery: sqlite.loadedNativeFiles?.includes(file) ?? false,
						currentPlatformCandidate: platformCandidate(
							`${entry.name}/${relative(base, file)}`
						),
						selection:
							'All installed package .node files are retained. Platform/architecture selection uses filename hints and is not proof of loading.',
					});
				}
			}
		}
	}
	return {
		files,
		packages,
		excludedDirectories,
		unavailable: false,
		limitation:
			'Binary hashes identify installed files. No exact source dependency inventory is inferred for opaque native binaries.',
	};
}

async function supplementalInventories(root, stage, output, pkg, lock, provenance, scan) {
	const base = join(root, 'assets', 'c2pa-supply-chain');
	const metadataBytes = await readReleaseFile(join(base, 'upstream.json'), 128 * 1024);
	const upstream = parseJSON(metadataBytes, 'Pinned upstream metadata');
	requireCondition(
		upstream.schemaVersion === 1 &&
			object(upstream.sourceAssociation) &&
			Array.isArray(upstream.holographicMemory) &&
			upstream.holographicMemory.length >= 2 &&
			upstream.holographicMemory.length <= 16,
		'INVALID_UPSTREAM_METADATA',
		'Pinned upstream source associations and HMS inventories are required.'
	);
	provenance.upstream = {
		metadataSHA256: digest(metadataBytes),
		sourceAssociation: [],
		holographicMemory: [],
	};
	await writePrivate(join(stage, 'upstream.json'), metadataBytes);
	const editorialStage = join(stage, 'editorial-native');
	await fs.mkdir(editorialStage, { mode: 0o700 });
	const editorialExpected = [];
	for (const [key, packageName] of [
		['bluepencil', 'bluepencil-node'],
		['narrative-lens', 'narrative-lens'],
	]) {
		const association = upstream.sourceAssociation[key];
		requireCondition(
			object(association) &&
				association.file === `${key}/Cargo.lock` &&
				SHA256.test(association.sha256) &&
				/^[a-f0-9]{40}$/u.test(association.commit) &&
				boundedText(association.basis, 512) &&
				validVersion(association.version) &&
				lock.packages[`node_modules/${packageName}`]?.version === association.version,
			'UPSTREAM_VERSION_MISMATCH',
			'Pinned editorial native source associations must match the npm lock.'
		);
		const bytes = await readReleaseFile(join(base, key, 'Cargo.lock'), 8 * MIB);
		requireCondition(
			digest(bytes) === association.sha256,
			'UPSTREAM_HASH_MISMATCH',
			'Pinned editorial native Cargo.lock digest does not match.'
		);
		const destination = join(editorialStage, key);
		await fs.mkdir(destination, { mode: 0o700 });
		await writePrivate(join(destination, 'Cargo.lock'), bytes);
		provenance.upstream.sourceAssociation.push({
			package: packageName,
			...association,
			coverage: `${RUST_SCOPE} Source association does not prove the installed native binary was built from this lock.`,
		});
		editorialExpected.push({ name: packageName, version: association.version });
	}
	await scan('editorial-native', editorialStage, 'rust-cargo-lock-cataloger', editorialExpected);
	const union = new Map();
	const sources = join(stage, 'hms-upstream');
	await fs.mkdir(sources, { mode: 0o700 });
	const seenFiles = new Set();
	const hmsVersion = lock.packages['node_modules/holographic-memory']?.version;
	for (const evidence of upstream.holographicMemory) {
		requireCondition(
			object(evidence) &&
				boundedText(evidence.file, 128) &&
				/^holographic-memory(?:-[A-Za-z0-9-]+)?-[0-9]+\.[0-9]+\.[0-9]+\.tgz\.cdx\.json$/u.test(
					evidence.file
				) &&
				!seenFiles.has(evidence.file) &&
				SHA256.test(evidence.sha256) &&
				boundedText(evidence.url, 2048),
			'INVALID_UPSTREAM_METADATA',
			'HMS evidence requires unique safe filenames, URLs and digests.'
		);
		seenFiles.add(evidence.file);
		const url = new URL(evidence.url);
		requireCondition(
			url.protocol === 'https:' &&
				url.hostname === 'github.com' &&
				!url.port &&
				!url.username &&
				!url.password &&
				!url.search &&
				!url.hash &&
				url.pathname ===
					`/writerslogic/holographic-memory/releases/download/v${hmsVersion}/${evidence.file}`,
			'INVALID_UPSTREAM_METADATA',
			'HMS evidence must identify the pinned official release asset.'
		);
		const bytes = await readReleaseFile(join(base, evidence.file), 8 * MIB);
		requireCondition(
			digest(bytes) === evidence.sha256,
			'UPSTREAM_HASH_MISMATCH',
			'Pinned HMS inventory digest does not match.'
		);
		const document = parseJSON(bytes, 'Upstream HMS CycloneDX');
		requireCondition(
			document.bomFormat === 'CycloneDX' &&
				Array.isArray(document.components) &&
				document.metadata?.component?.name === 'holographic-memory' &&
				document.metadata.component.version === hmsVersion,
			'UPSTREAM_VERSION_MISMATCH',
			'HMS inventory metadata must match the pinned npm version.'
		);
		await writePrivate(join(sources, evidence.file), bytes);
		provenance.upstream.holographicMemory.push(evidence);
		const pending = [document.metadata.component, ...document.components];
		for (let index = 0; index < pending.length; index++) {
			requireCondition(
				pending.length <= 100_000,
				'UPSTREAM_COMPONENT_LIMIT',
				'HMS component union exceeds its allocation limit.'
			);
			const component = pending[index];
			requireCondition(
				object(component) && boundedText(component.name) && boundedText(component.version),
				'INVALID_UPSTREAM_COMPONENT',
				'HMS inventory has invalid component metadata.'
			);
			if (component.components !== undefined) {
				requireCondition(
					Array.isArray(component.components),
					'INVALID_UPSTREAM_COMPONENT',
					'Nested HMS components must be arrays.'
				);
				for (const child of component.components) pending.push(child);
			}
			const identity = JSON.stringify([
				component.purl ?? null,
				component.group ?? null,
				component.name,
				component.version,
				component.type,
				component.cpe ?? null,
				component.hashes ?? [],
			]);
			if (!union.has(identity)) {
				requireCondition(
					union.size < 100_000,
					'UPSTREAM_COMPONENT_LIMIT',
					'HMS component union exceeds its allocation limit.'
				);
				const copy = { ...component, 'bom-ref': `hms:${digest(identity)}` };
				delete copy.components;
				union.set(identity, copy);
			}
		}
	}
	const components = [...union.values()];
	const representative = components.find(
		(component) =>
			component.purl?.startsWith('pkg:cargo/') &&
			!component.purl.startsWith('pkg:cargo/holographic-memory@')
	);
	requireCondition(
		representative && components.length <= 100_000,
		'MISSING_EXPECTED_PACKAGE',
		'HMS inventories must include native Rust dependencies.'
	);
	const combined = cyclonedx(
		pkg,
		components,
		'Component union of the pinned wrapper and all supplied native platform SBOMs. Conservative all-platform scope; original dependency relationships remain in the preserved source SBOMs.'
	);
	await writeJSON(join(output, 'hms-upstream.cdx.json'), combined);
	return [
		{ name: 'holographic-memory', version: hmsVersion },
		{ name: representative.name, version: representative.version },
	];
}

export async function createC2paInventory(options) {
	requireCondition(
		object(options) &&
			Object.keys(options).every((key) => ['syft', 'output', 'rootDirectory'].includes(key)),
		'INVALID_OPTIONS',
		'Expected --syft ABS --output ABS.'
	);
	const root = await fs.realpath(absolutePath(options.rootDirectory ?? ROOT));
	const requestedOutput = absolutePath(options.output);
	const requestedSyft = absolutePath(options.syft);
	requireCondition(
		requestedOutput !== dirname(requestedOutput),
		'INVALID_OUTPUT',
		'Output must be a new private directory.'
	);
	const output = join(await fs.realpath(dirname(requestedOutput)), basename(requestedOutput));
	try {
		await fs.mkdir(output, { mode: 0o700 });
	} catch {
		throw new InventoryError(
			'OUTPUT_UNAVAILABLE',
			'Output must be a new directory in an existing writable parent.'
		);
	}
	const provenance = {
		schemaVersion: 1,
		ok: false,
		generatedAt: new Date().toISOString(),
		tool: null,
		sources: [],
		inventories: [],
		nativeBinaries: null,
		binding: null,
		runtime: null,
		limitations: [
			RUST_SCOPE,
			'Generated inventories and binary hashes are security evidence inputs, not vulnerability results or C2PA conformance approval.',
			'Explicit runtime CPEs use reported versions. Vendor backports and Node-specific V8 suffixes require advisory applicability review.',
			'Opaque editorial native binaries retain source-association limitations; no exact compiled dependency coverage is inferred.',
		],
		errors: [],
	};
	const controller = new AbortController();
	const interrupted = () => controller.abort();
	process.once('SIGINT', interrupted);
	process.once('SIGTERM', interrupted);
	try {
		const stage = join(output, 'staging');
		await fs.mkdir(stage, { mode: 0o700 });
		const readSource = async (file, maximum) => {
			const bytes = await readReleaseFile(join(root, file), maximum);
			provenance.sources.push({ file, bytes: bytes.length, sha256: digest(bytes) });
			return bytes;
		};
		const packageBytes = await readSource('package.json', 128 * 1024);
		const lockBytes = await readSource('package-lock.json', 16 * MIB);
		const pkg = parseJSON(packageBytes, 'Package metadata');
		const lock = parseJSON(lockBytes, 'npm lock');
		requireCondition(
			pkg.name === 'scrivener-mcp' &&
				validVersion(pkg.version) &&
				object(lock.packages) &&
				lock.packages['']?.version === pkg.version &&
				lock.packages['node_modules/asn1js']?.version === '4.0.0',
			'PACKAGE_LOCK_MISMATCH',
			'Package metadata and npm lock must agree and include asn1js 4.0.0.'
		);
		try {
			await checkC2paBinding(root);
		} catch {
			throw new InventoryError(
				'BINDING_PROVENANCE_FAILED',
				'C2PA build artifacts and source hashes must pass check-c2pa-binding before inventory generation.'
			);
		}
		const bindingBytes = await readSource('assets/c2pa-binding/build.json', 64 * 1024);
		const binding = parseJSON(bindingBytes, 'C2PA build metadata');
		requireCondition(
			binding.version === '0.91.7',
			'BINDING_VERSION_MISMATCH',
			'C2PA binding must identify pinned c2pa 0.91.7.'
		);
		await writePrivate(join(stage, 'binding-build.json'), bindingBytes);
		provenance.binding = {
			buildManifestSHA256: digest(bindingBytes),
			metadata: binding,
			evidenceFile: 'staging/binding-build.json',
			basis: 'Existing binding verifier checked the local artifact/source hashes; this is not an independent reproducible-build attestation.',
		};
		const npmStage = join(stage, 'npm');
		const rustStage = join(stage, 'c2pa-rust');
		await fs.mkdir(npmStage, { mode: 0o700 });
		await fs.mkdir(rustStage, { mode: 0o700 });
		await writePrivate(join(npmStage, 'package.json'), packageBytes);
		await writePrivate(join(npmStage, 'package-lock.json'), lockBytes);
		for (const file of ['Cargo.toml', 'Cargo.lock']) {
			const source = `native/c2pa-binding/${file}`;
			const bytes = await readSource(source, 8 * MIB);
			requireCondition(
				binding.sources.find((entry) => entry.file === source)?.sha256 === digest(bytes),
				'BINDING_PROVENANCE_FAILED',
				'Staged Rust inputs must match the verified C2PA build manifest.'
			);
			await writePrivate(join(rustStage, file), bytes);
		}
		const core = join(root, 'src', 'services', 'content-credentials');
		const coreEntries = await fs.readdir(core, { withFileTypes: true });
		requireCondition(
			coreEntries.length <= 128,
			'SOURCE_LIMIT',
			'Credentials source directory exceeds its entry limit.'
		);
		for (const entry of coreEntries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (!/\.(?:ts|cts)$/u.test(entry.name)) continue;
			requireCondition(
				entry.isFile() && !entry.isSymbolicLink(),
				'SOURCE_SYMLINK',
				'Credentials sources must be regular files.'
			);
			await readSource(`src/services/content-credentials/${entry.name}`, 2 * MIB);
		}
		for (const file of [
			'src/handlers/content-credentials-handlers.ts',
			'src/cli/content-credentials.ts',
			'scripts/create-c2pa-inventory.mjs',
			'scripts/check-c2pa-supply-chain.mjs',
			'scripts/check-c2pa-binding.mjs',
		])
			await readSource(file, 2 * MIB);
		let command;
		try {
			command = await fs.realpath(requestedSyft);
			await fs.access(command, constants.X_OK);
		} catch {
			throw new InventoryError(
				'SYFT_UNAVAILABLE',
				'The supplied Syft executable is unavailable or not executable.'
			);
		}
		const executableHash = digest(await readReleaseFile(command, 256 * MIB));
		await writePrivate(join(output, 'syft.yaml'), CONFIGURATION);
		const version = parseJSON(
			await syftCommand(
				command,
				['version', '-o', 'json'],
				output,
				'syft-version',
				controller.signal,
				MIB
			),
			'Syft version'
		);
		requireCondition(
			version.application === 'syft' && version.version === SYFT_VERSION,
			'WRONG_SYFT_VERSION',
			`Syft ${SYFT_VERSION} is required.`
		);
		provenance.tool = { version: SYFT_VERSION, sha256: executableHash, metadata: version };
		const addInventory = (name, file, bytes, expectedPackages, coverage) => {
			const inventory = {
				name,
				path: join(output, file),
				sha256: digest(bytes),
				expectedPackages,
			};
			provenance.inventories.push({ ...inventory, coverage });
			return inventory;
		};
		const inventories = [];
		const scan = async (name, directory, cataloger, expectedPackages) => {
			const bytes = await syftCommand(
				command,
				[
					'scan',
					`dir:${directory}`,
					'--override-default-catalogers',
					cataloger,
					'-o',
					'syft-json',
				],
				output,
				`${name}.syft`,
				controller.signal
			);
			requirePackages(parseJSON(bytes, 'Syft inventory'), expectedPackages);
			inventories.push(
				addInventory(
					name,
					`${name}.syft.json`,
					bytes,
					expectedPackages,
					cataloger === 'rust-cargo-lock-cataloger'
						? RUST_SCOPE
						: 'Declared npm lock dependencies including development dependencies; not an installed-file inventory.'
				)
			);
		};
		const npmExpected = [
			'asn1js',
			'better-sqlite3',
			'bluepencil-node',
			'narrative-lens',
			'holographic-memory',
		].map((name) => ({ name, version: lock.packages[`node_modules/${name}`]?.version }));
		requireCondition(
			npmExpected.every((item) => validVersion(item.version)),
			'PACKAGE_LOCK_MISMATCH',
			'npm lock is missing a required runtime dependency.'
		);
		await scan('npm-lock', npmStage, 'javascript-lock-cataloger', npmExpected);
		await scan('c2pa-rust', rustStage, 'rust-cargo-lock-cataloger', [
			{ name: 'c2pa', version: '0.91.7' },
		]);
		const hmsExpected = await supplementalInventories(
			root,
			stage,
			output,
			pkg,
			lock,
			provenance,
			scan
		);
		const hmsBytes = await readReleaseFile(join(output, 'hms-upstream.cdx.json'), 64 * MIB);
		inventories.push(
			addInventory(
				'hms-upstream',
				'hms-upstream.cdx.json',
				hmsBytes,
				hmsExpected,
				'Verified upstream wrapper/native SBOM component union across all supplied platforms; not proof of exact installed linkage.'
			)
		);
		const { isSupportedRuntime } = await import(
			pathToFileURL(join(root, 'dist/setup/runtime.js')).href
		);
		requireCondition(
			isSupportedRuntime({
				node: process.execPath,
				npx: null,
				version: process.version,
				major: Number(process.versions.node.split('.')[0]),
				source: 'c2pa-inventory',
			}),
			'UNSUPPORTED_RUNTIME',
			'Use the product runtime security floor before generating assessment evidence.'
		);
		for (const [file, entry] of Object.entries(lock.packages)) {
			if (/(?:^|\/)node_modules\/(?:picomatch|uri-js)$/u.test(file))
				requireCondition(
					entry.dev === true,
					'VEX_SCOPE_CHANGED',
					'The reviewed development-only vulnerability disposition must be reassessed for runtime dependencies.'
				);
		}
		const nodePath = await fs.realpath(process.execPath);
		const nodeBytes = await readReleaseFile(nodePath, 256 * MIB);
		const nodeHash = digest(nodeBytes);
		const versions = { ...process.versions };
		requireCondition(
			validVersion(versions.node) && validVersion(versions.openssl),
			'RUNTIME_COMPONENT_MISSING',
			'Executing Node must report its Node and OpenSSL versions.'
		);
		const components = [];
		for (const [field, version] of Object.entries(versions).sort(([a], [b]) =>
			a.localeCompare(b)
		)) {
			if (field === 'modules' || field === 'napi' || version === '') continue;
			const component = runtimeComponent(
				field === 'uv' ? 'libuv' : field === 'ada' ? 'ada-url' : field,
				version,
				`process.versions.${field}; https://nodejs.org/api/process.html#processversions`,
				nodeHash,
				RUNTIME_IDENTITIES[field],
				field
			);
			if (['cldr', 'unicode', 'tz'].includes(field)) component.type = 'data';
			components.push(component);
		}
		const sqlite = await sqliteEvidence(root);
		if (sqlite.available)
			components.push(
				runtimeComponent(
					'sqlite',
					sqlite.version,
					'better-sqlite3 in-memory SELECT sqlite_version()',
					nodeHash,
					RUNTIME_IDENTITIES.sqlite,
					'better-sqlite3-sqlite'
				)
			);
		provenance.runtime = {
			executableSHA256: nodeHash,
			executableBytes: nodeBytes.length,
			platform: process.platform,
			architecture: process.arch,
			processVersions: versions,
			sqlite,
			evidence:
				'Versions reported by the actually executing process and, when available, its installed in-memory SQLite binding.',
		};
		provenance.nativeBinaries = await nativeFiles(root, sqlite, lock);
		if (!sqlite.available) provenance.limitations.push(sqlite.reason);
		if (provenance.nativeBinaries.unavailable)
			provenance.limitations.push(
				'Installed node_modules was unavailable; no native package binaries were inventoried.'
			);
		const sqliteComponent = components.find(
			(component) => component['bom-ref'] === 'runtime:better-sqlite3-sqlite'
		);
		if (sqliteComponent) {
			for (const binary of provenance.nativeBinaries.files.filter(
				(file) => file.loadedForSqliteQuery
			))
				sqliteComponent.properties.push({
					name: 'scrivener:sqliteBindingSHA256',
					value: binary.sha256,
				});
		}
		const runtime = cyclonedx(
			pkg,
			components,
			'Executing Node component versions and optional in-memory better-sqlite3 query. Runtime ABI counters are retained in provenance; OS packages and unreported static libraries are outside this inventory.'
		);
		const runtimeOutput = join(output, 'runtime.cdx.json');
		await writeJSON(runtimeOutput, runtime);
		const runtimeExpected = [
			{ name: 'node', version: versions.node },
			{ name: 'openssl', version: versions.openssl },
		];
		if (sqlite.available) runtimeExpected.push({ name: 'sqlite', version: sqlite.version });
		inventories.push(
			addInventory(
				'runtime',
				'runtime.cdx.json',
				await readReleaseFile(runtimeOutput, MIB),
				runtimeExpected,
				'Observed runtime versions and explicit evidence-backed CPE mappings; advisory applicability still requires review.'
			)
		);
		try {
			await checkC2paBinding(root);
			requireCondition(
				digest(
					await readReleaseFile(join(root, 'assets/c2pa-binding/build.json'), 64 * 1024)
				) === digest(bindingBytes),
				'BINDING_PROVENANCE_FAILED',
				'C2PA build metadata changed during inventory generation.'
			);
		} catch (error) {
			if (error instanceof InventoryError) throw error;
			throw new InventoryError(
				'BINDING_PROVENANCE_FAILED',
				'C2PA artifact or source identity changed during inventory generation.'
			);
		}
		requireCondition(
			!controller.signal.aborted,
			'INTERRUPTED',
			'Inventory generation was interrupted.'
		);
		await writeJSON(join(output, 'input-manifest.json'), { schemaVersion: 1, inventories });
		provenance.ok = true;
	} catch (error) {
		provenance.errors.push(publicError(error));
	} finally {
		process.removeListener('SIGINT', interrupted);
		process.removeListener('SIGTERM', interrupted);
		await writeJSON(join(output, 'provenance.json'), provenance);
	}
	return provenance;
}

function argumentsFromCLI(values) {
	const options = {};
	for (let index = 0; index < values.length; index += 2) {
		const flag = values[index];
		requireCondition(
			['--syft', '--output'].includes(flag) &&
				values[index + 1] !== undefined &&
				!Object.hasOwn(options, flag.slice(2)),
			'INVALID_OPTIONS',
			'Expected --syft ABS --output ABS.'
		);
		options[flag.slice(2)] = values[index + 1];
	}
	return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const result = await createC2paInventory(argumentsFromCLI(process.argv.slice(2)));
		console.log(
			JSON.stringify({
				ok: result.ok,
				inventories: result.inventories.length,
				errorCodes: result.errors.map((error) => error.code),
			})
		);
		process.exitCode = result.ok ? 0 : 1;
	} catch (error) {
		console.error(JSON.stringify({ ok: false, error: publicError(error) }));
		process.exitCode = 1;
	}
}
