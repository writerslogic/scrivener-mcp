#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';
import JSZip from 'jszip';
import { parseStringPromise } from 'xml2js';
import { createC2paTestSigner } from './create-c2pa-fixtures.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
	assert.ok(
		['--fixtures', '--output'].includes(process.argv[index]) &&
			process.argv[index + 1] &&
			!options[process.argv[index]],
		'Use optional --fixtures <directory> and --output <report.json>'
	);
	options[process.argv[index]] = resolve(process.argv[index + 1]);
}
const fixtureRoot = options['--fixtures'] ?? join(ROOT, 'tests/fixtures/c2pa');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const envNames = [
	'SCRIVENER_C2PA_CERT_PATH',
	'SCRIVENER_C2PA_KEY_PATH',
	'SCRIVENER_C2PA_KEY_PASSWORD',
	'SCRIVENER_C2PA_TRUST_ANCHORS_PATH',
	'SCRIVENER_LOCAL_ONLY',
	'SCRIVENER_DISABLE_KEY_DISCOVERY',
	'SCRIVENER_DATA_DIR',
	'NODE_ENV',
	'LOG_LEVEL',
];
const previousEnv = new Map(envNames.map((name) => [name, process.env[name]]));
const workspace = await mkdtemp(join(tmpdir(), 'scrivener-c2pa-gate-'));
const evidence = {
	schemaVersion: 1,
	productVersion: JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
		.version,
	ok: false,
	sdkVersion: null,
	node: process.version,
	platform: process.platform,
	architecture: process.arch,
	fixtureIndexSha256: null,
	trustRoot: 'Ephemeral synthetic test CA; not publicly trusted',
	checks: [],
	formats: [],
	failures: [],
};
let cleanupFailed = false;
let phase = 'fixture-index';

function summary(validation) {
	return {
		state: validation.state,
		integrity: validation.integrity,
		trust: validation.trust,
		trustPolicy: validation.trustPolicy,
		validationCodes: validation.validationCodes,
	};
}
function trusted(validation) {
	assert.equal(validation.state, 'valid');
	assert.equal(validation.integrity, 'valid');
	assert.equal(validation.trust, 'trusted');
	assert.equal(validation.trustPolicy, 'configured-roots');
}
function untrusted(validation, policy) {
	assert.equal(validation.state, 'untrusted');
	assert.equal(validation.integrity, 'valid');
	assert.equal(validation.trust, 'untrusted');
	assert.equal(validation.trustPolicy, policy);
}
function describeFailure(error) {
	return {
		code: typeof error?.code === 'string' ? error.code : (error?.name ?? 'Error'),
		message:
			error instanceof assert.AssertionError
				? 'A native compatibility assertion failed'
				: 'A native compatibility operation failed',
	};
}

function compressedTestManifest(bytes) {
	assert.ok(bytes.length > 0 && bytes.length <= 8 * 1024 * 1024);
	const boxes = (start, end) => {
		const result = [];
		for (let offset = start; offset < end;) {
			assert.ok(result.length < 1024 && offset + 8 <= end, 'Invalid test JUMBF structure');
			let length = bytes.readUInt32BE(offset);
			let header = 8;
			if (length === 1) {
				assert.ok(offset + 16 <= end);
				const extended = bytes.readBigUInt64BE(offset + 8);
				assert.ok(extended <= BigInt(bytes.length));
				length = Number(extended);
				header = 16;
			} else if (length === 0) length = end - offset;
			assert.ok(length >= header && offset + length <= end, 'Invalid test JUMBF box size');
			result.push({
				start: offset,
				end: offset + length,
				payload: offset + header,
				header,
				type: bytes.toString('ascii', offset + 4, offset + 8),
			});
			offset += length;
		}
		return result;
	};
	const description = (box) => {
		const first = boxes(box.payload, box.end)[0];
		assert.ok(
			first?.type === 'jumd' && first.end - first.payload >= 17,
			'Missing JUMBF description'
		);
		return first;
	};
	const contentType = (box) => {
		const desc = description(box);
		return bytes.toString('ascii', desc.payload, desc.payload + 4);
	};
	const encode = (type, payload) => {
		assert.ok(payload.length + 8 <= 8 * 1024 * 1024);
		const header = Buffer.alloc(8);
		header.writeUInt32BE(payload.length + 8);
		header.write(type, 4, 'ascii');
		return Buffer.concat([header, payload]);
	};
	const stores = boxes(0, bytes.length).filter(
		(box) => box.type === 'jumb' && contentType(box) === 'c2pa'
	);
	assert.equal(stores.length, 1, 'Expected one native manifest store');
	const store = stores[0];
	let manifests = 0;
	const contents = boxes(store.payload, store.end).map((box) => {
		if (box.type !== 'jumb' || !['c2ma', 'c2um'].includes(contentType(box)))
			return bytes.subarray(box.start, box.end);
		const desc = description(box);
		const copiedDescription = Buffer.from(bytes.subarray(desc.start, desc.end));
		copiedDescription.write('c2cm', desc.header, 'ascii');
		const original = bytes.subarray(box.start, box.end);
		const compressed = brotliCompressSync(original, {
			params: {
				[zlibConstants.BROTLI_PARAM_QUALITY]: 4,
				[zlibConstants.BROTLI_PARAM_LGWIN]: 18,
			},
		});
		assert.ok(brotliDecompressSync(compressed).equals(original));
		manifests++;
		return encode('jumb', Buffer.concat([copiedDescription, encode('brob', compressed)]));
	});
	assert.ok(manifests > 0, 'Native sidecar has no standard manifest to compress');
	return {
		bytes: Buffer.concat([
			bytes.subarray(0, store.start),
			encode('jumb', Buffer.concat(contents)),
			bytes.subarray(store.end),
		]),
		manifests,
	};
}

try {
	for (const name of envNames.slice(0, 4)) delete process.env[name];
	Object.assign(process.env, {
		SCRIVENER_LOCAL_ONLY: 'true',
		SCRIVENER_DISABLE_KEY_DISCOVERY: '1',
		SCRIVENER_DATA_DIR: workspace,
		NODE_ENV: 'test',
		LOG_LEVEL: 'ERROR',
	});
	const indexFile = join(fixtureRoot, 'index.json');
	assert.ok((await lstat(indexFile)).size <= 256 * 1024, 'Fixture index exceeds its limit');
	const indexBytes = await readFile(indexFile);
	evidence.fixtureIndexSha256 = hash(indexBytes);
	const index = JSON.parse(indexBytes.toString('utf8'));
	assert.equal(index.schemaVersion, 1);
	assert.equal(index.license, 'CC0-1.0');
	assert.ok(
		Array.isArray(index.fixtures) && index.fixtures.length > 0 && index.fixtures.length <= 128
	);
	const seen = new Set();
	for (const fixture of index.fixtures) {
		assert.ok(
			typeof fixture.file === 'string' &&
				/^[a-z0-9][a-z0-9._-]{0,63}$/.test(fixture.file) &&
				!fixture.file.includes('..')
		);
		assert.ok(!seen.has(fixture.file), 'Duplicate fixture');
		seen.add(fixture.file);
		assert.ok(
			Number.isSafeInteger(fixture.bytes) && fixture.bytes > 0 && fixture.bytes <= 1024 * 1024
		);
		assert.match(fixture.sha256, /^[a-f0-9]{64}$/);
		const original = join(fixtureRoot, fixture.file);
		const info = await lstat(original);
		assert.ok(info.isFile() && !info.isSymbolicLink() && info.size === fixture.bytes);
		assert.equal(
			hash(await readFile(original)),
			fixture.sha256,
			'Fixture checksum differs from its index'
		);
		await copyFile(original, join(workspace, fixture.file));
	}
	phase = 'native-service-loading';
	const { getCredentialCapabilities, signCredentialAsset, validateCredentialAsset } =
		await import(
			pathToFileURL(join(ROOT, 'dist/services/content-credentials/service.js')).href
		);
	const { resolveCredentialFormat } = await import(
		pathToFileURL(join(ROOT, 'dist/services/content-credentials/formats.js')).href
	);
	const { validateExport } = await import(
		pathToFileURL(join(ROOT, 'dist/services/export/export-presets.js')).href
	);
	const { ErrorCode } = await import(pathToFileURL(join(ROOT, 'dist/core/errors.js')).href);
	const capabilities = await getCredentialCapabilities();
	assert.equal(
		capabilities.available,
		true,
		'The actual installed native C2PA SDK must load on this target'
	);
	assert.equal(capabilities.signerConfigured, false);
	assert.ok(typeof capabilities.sdkVersion === 'string' && capabilities.sdkVersion.length > 0);
	evidence.sdkVersion = capabilities.sdkVersion;
	evidence.compressedValidationDeclared = capabilities.compressedManifests.validation;
	const exercised = new Set(
		index.fixtures.map(
			(fixture) => resolveCredentialFormat(fixture.mimeType, fixture.file).mimeType
		)
	);
	evidence.notExercised = capabilities.formats
		.filter((format) => !exercised.has(format.mimeType))
		.map((format) => ({
			mimeType: format.mimeType,
			embedded: format.embedded,
			status: 'not-exercised-no-fixture',
		}));
	evidence.unavailableFixtures = (index.unavailable ?? []).map((fixture) => ({
		file: fixture.file,
		mimeType: fixture.mimeType,
		status: 'not-generated',
	}));
	evidence.checks.push('actual-installed-native-sdk');
	const categories = new Set(
		index.fixtures.map(
			(fixture) => resolveCredentialFormat(fixture.mimeType, fixture.file).category
		)
	);
	for (const category of [
		'image',
		'video',
		'audio',
		'document',
		'text',
		'font',
		'model',
		'other',
	])
		assert.ok(categories.has(category), `Missing ${category} fixture coverage`);
	const image = index.fixtures.find((fixture) => fixture.file === 'image.png');
	assert.ok(image, 'The baseline PNG fixture is required');
	const imagePath = join(workspace, image.file);
	phase = 'unsigned-validation';
	const unsigned = await validateCredentialAsset({
		assetPath: imagePath,
		mimeType: image.mimeType,
	});
	assert.equal(unsigned.state, 'unsigned');
	assert.equal(unsigned.integrity, 'not-evaluated');
	assert.equal(unsigned.trust, 'not-evaluated');
	evidence.checks.push('unsigned-is-not-valid-or-trusted');
	phase = 'ephemeral-test-signer';
	const signer = await createC2paTestSigner(join(workspace, 'signer'));
	Object.assign(process.env, {
		SCRIVENER_C2PA_CERT_PATH: signer.certificatePath,
		SCRIVENER_C2PA_KEY_PATH: signer.privateKeyPath,
		SCRIVENER_C2PA_KEY_PASSWORD: signer.password,
	});
	const trustImage = join(workspace, 'trust.png');
	phase = 'untrusted-signing';
	const noRoots = await signCredentialAsset({
		assetPath: imagePath,
		outputPath: trustImage,
		mimeType: image.mimeType,
		mode: 'embedded',
		title: 'Original CC0 compatibility test',
	});
	untrusted(noRoots.validation, 'none');
	const otherSigner = await createC2paTestSigner(join(workspace, 'unrelated-signer'));
	evidence.checks.push('ephemeral-encrypted-test-signers');
	phase = 'configured-root-trust-validation';
	process.env.SCRIVENER_C2PA_TRUST_ANCHORS_PATH = otherSigner.trustAnchorsPath;
	untrusted(
		await validateCredentialAsset({ assetPath: trustImage, mimeType: image.mimeType }),
		'configured-roots'
	);
	process.env.SCRIVENER_C2PA_TRUST_ANCHORS_PATH = signer.trustAnchorsPath;
	trusted(await validateCredentialAsset({ assetPath: trustImage, mimeType: image.mimeType }));
	evidence.checks.push(
		'no-root-untrusted',
		'unrelated-root-untrusted',
		'configured-test-root-trusted'
	);
	phase = 'concurrent-exclusive-publication';
	const racePath = join(workspace, 'concurrent.png');
	const race = await Promise.allSettled(
		[0, 1].map(() =>
			signCredentialAsset({ assetPath: imagePath, outputPath: racePath, mode: 'embedded' })
		)
	);
	assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1);
	const losing = race.find((result) => result.status === 'rejected');
	assert.equal(losing?.reason.code, ErrorCode.FILE_WRITE_ERROR);
	trusted(await validateCredentialAsset({ assetPath: racePath }));
	evidence.checks.push('concurrent-output-publish-never-overwrites');
	phase = 'wrong-signing-password';
	const rejectedPath = join(workspace, 'wrong-password.png');
	process.env.SCRIVENER_C2PA_KEY_PASSWORD = 'Deliberately incorrect synthetic test password';
	try {
		await assert.rejects(
			signCredentialAsset({
				assetPath: imagePath,
				outputPath: rejectedPath,
				mode: 'embedded',
			}),
			(error) =>
				error?.code === ErrorCode.OPERATION_FAILED &&
				!error.message.includes(signer.password)
		);
		await assert.rejects(lstat(rejectedPath), (error) => error?.code === 'ENOENT');
	} finally {
		process.env.SCRIVENER_C2PA_KEY_PASSWORD = signer.password;
	}
	evidence.checks.push('wrong-password-rejected-without-output');
	await mkdir(join(workspace, 'signed'));
	await mkdir(join(workspace, 'tampered'));
	const rejectTamper = async (request) => {
		try {
			const validation = await validateCredentialAsset(request);
			assert.equal(validation.state, 'invalid', 'Tampered asset was accepted');
			assert.notEqual(
				validation.integrity,
				'valid',
				'Tampered asset retained valid integrity'
			);
			return { status: 'rejected', ...summary(validation) };
		} catch (error) {
			if (error instanceof assert.AssertionError) throw error;
			assert.ok(
				[
					ErrorCode.INVALID_FORMAT,
					ErrorCode.VALIDATION_FAILED,
					ErrorCode.OPERATION_FAILED,
				].includes(error?.code),
				'Unexpected failure cannot establish tamper rejection'
			);
			return { status: 'rejected-unreadable', code: error.code, integrity: 'not-evaluated' };
		}
	};
	phase = 'format-roundtrips';
	for (const fixture of index.fixtures) {
		const row = { file: fixture.file, mimeType: fixture.mimeType, ok: true };
		evidence.formats.push(row);
		try {
			const format = resolveCredentialFormat(fixture.mimeType, fixture.file);
			row.category = format.category;
			row.embeddedDeclared = format.embedded;
			const assetPath = join(workspace, fixture.file);
			const sidecarPath = join(workspace, 'signed', `${fixture.file}.c2pa`);
			let stage = 'sidecar-sign';
			try {
				if (format.sidecar) {
					const signed = await signCredentialAsset({
						assetPath,
						outputPath: sidecarPath,
						mimeType: format.mimeType,
						mode: 'sidecar',
						title: 'Original CC0 detached compatibility test',
					});
					trusted(signed.validation);
					assert.equal(signed.sourceRevision, fixture.sha256);
					assert.equal(signed.mode, 'sidecar');
					assert.ok(signed.bytes > 0);
					stage = 'sidecar-validation';
					const validation = await validateCredentialAsset({
						assetPath,
						mimeType: format.mimeType,
						manifestPath: sidecarPath,
					});
					trusted(validation);
					assert.equal(validation.sourceRevision, fixture.sha256);
					row.sidecar = { status: 'roundtrip', ...summary(validation) };
					if (fixture.file === image.file) {
						stage = 'compressed-manifest-validation';
						const compressed = compressedTestManifest(await readFile(sidecarPath));
						const compressedPath = join(workspace, 'signed', 'compressed-image.c2pa');
						await writeFile(compressedPath, compressed.bytes, {
							flag: 'wx',
							mode: 0o600,
						});
						try {
							const result = await validateCredentialAsset({
								assetPath,
								mimeType: format.mimeType,
								manifestPath: compressedPath,
							});
							const accepted =
								result.state === 'valid' &&
								result.integrity === 'valid' &&
								result.trust === 'trusted' &&
								result.activeManifest === validation.activeManifest;
							if (capabilities.compressedManifests.validation)
								assert.ok(
									accepted,
									'Declared compressed-manifest validation failed'
								);
							row.compressedManifest = {
								status: accepted ? 'validated' : 'not-validated',
								manifests: compressed.manifests,
								bytes: compressed.bytes.length,
								sha256: hash(compressed.bytes),
								...summary(result),
							};
						} catch (error) {
							if (
								error instanceof assert.AssertionError ||
								capabilities.compressedManifests.validation
							)
								throw error;
							assert.ok(
								[
									ErrorCode.UNSUPPORTED_OPERATION,
									ErrorCode.INVALID_FORMAT,
									ErrorCode.OPERATION_FAILED,
								].includes(error?.code)
							);
							row.compressedManifest = {
								status: 'not-proven',
								code: error.code,
								manifests: compressed.manifests,
								bytes: compressed.bytes.length,
								sha256: hash(compressed.bytes),
							};
						}
						evidence.checks.push('standard-c2cm-brob-validation-probed');
					}
					const changed = Buffer.from(await readFile(assetPath));
					changed[Math.floor(changed.length / 2)] ^= 1;
					const tamperedPath = join(workspace, 'tampered', fixture.file);
					await writeFile(tamperedPath, changed, { flag: 'wx', mode: 0o600 });
					stage = 'sidecar-tampered-asset';
					row.tamperedAsset = await rejectTamper({
						assetPath: tamperedPath,
						mimeType: format.mimeType,
						manifestPath: sidecarPath,
					});
				} else {
					await assert.rejects(
						signCredentialAsset({
							assetPath,
							outputPath: sidecarPath,
							mimeType: format.mimeType,
							mode: 'sidecar',
						}),
						(error) => error?.code === ErrorCode.UNSUPPORTED_OPERATION
					);
					row.sidecar = { status: 'unsupported' };
				}
			} catch (error) {
				row.ok = false;
				row.sidecar ??= { status: 'failed' };
				row.sidecarFailure = { stage, ...describeFailure(error) };
				evidence.failures.push({ file: fixture.file, ...row.sidecarFailure });
			}
			const embeddedPath = join(workspace, 'signed', `embedded-${fixture.file}`);
			stage = 'embedded-sign';
			try {
				if (format.embedded === 'supported') {
					const signed = await signCredentialAsset({
						assetPath,
						outputPath: embeddedPath,
						mimeType: format.mimeType,
						mode: 'embedded',
						title: 'Original CC0 embedded compatibility test',
					});
					trusted(signed.validation);
					assert.equal(signed.sourceRevision, fixture.sha256);
					assert.equal(signed.mode, 'embedded');
					stage = 'embedded-validation';
					const validation = await validateCredentialAsset({
						assetPath: embeddedPath,
						mimeType: format.mimeType,
					});
					trusted(validation);
					assert.equal(validation.sourceRevision, hash(await readFile(embeddedPath)));
					row.embedded = { status: 'roundtrip', ...summary(validation) };
					if (format.preparation === 'zip-store') {
						stage = 'signed-archive-preserves-source-parts';
						const before = await JSZip.loadAsync(await readFile(assetPath), {
							checkCRC32: true,
						});
						const after = await JSZip.loadAsync(await readFile(embeddedPath), {
							checkCRC32: true,
						});
						let preserved = 0;
						for (const entry of Object.values(before.files)) {
							if (
								entry.dir ||
								['[Content_Types].xml', 'META-INF/manifest.xml'].includes(
									entry.name
								)
							)
								continue;
							const original = await entry.async('nodebuffer');
							assert.ok(
								after.file(entry.name),
								'Signing removed an original document part'
							);
							assert.ok(
								(await after.file(entry.name).async('nodebuffer')).equals(original),
								'Signing changed an original document part'
							);
							if (/\.(xml|rels|xhtml|opf)$/i.test(entry.name))
								await parseStringPromise(original.toString('utf8'));
							preserved++;
						}
						row.preservedArchiveParts = preserved;
						if (fixture.file === 'story.docx') {
							const document = await after
								.file('word/document.xml')
								.async('nodebuffer');
							after.file(
								'word/document.xml',
								Buffer.concat([document, Buffer.from('\n')])
							);
							const tampered = join(workspace, 'tampered', 'embedded-story.docx');
							await writeFile(
								tampered,
								await after.generateAsync({
									type: 'nodebuffer',
									compression: 'STORE',
								}),
								{ flag: 'wx' }
							);
							row.tamperedEmbeddedArchive = await rejectTamper({
								assetPath: tampered,
								mimeType: format.mimeType,
							});
						}
						const assertions =
							validation.report.manifests[validation.activeManifest].assertions;
						assert.ok(
							assertions.some(
								(assertion) =>
									assertion.label === 'com.writerslogic.input' &&
									assertion.data?.sha256 === fixture.sha256
							),
							'Prepared document credential omitted its original-source digest'
						);
					}
					if (['story.docx', 'story.epub', 'story.pdf'].includes(fixture.file)) {
						stage = 'signed-export-properties';
						row.exportProperties = await validateExport(
							await readFile(embeddedPath),
							extname(fixture.file).slice(1)
						);
						assert.ok(
							row.exportProperties.length > 0,
							'Signing invalidated the manuscript export'
						);
					}
					if (fixture.file === image.file) {
						const tampered = Buffer.from(await readFile(embeddedPath));
						assert.equal(tampered.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
						let offset = 8;
						while (
							offset + 12 <= tampered.length &&
							tampered.toString('ascii', offset + 4, offset + 8) !== 'IDAT'
						)
							offset += 12 + tampered.readUInt32BE(offset);
						assert.ok(offset + 12 < tampered.length, 'Signed PNG has no IDAT payload');
						tampered[offset + 8] ^= 1;
						const target = join(workspace, 'tampered', 'embedded-image.png');
						await writeFile(target, tampered, { flag: 'wx', mode: 0o600 });
						stage = 'embedded-tampered-asset';
						row.tamperedEmbedded = await rejectTamper({
							assetPath: target,
							mimeType: format.mimeType,
						});
					}
				} else {
					await assert.rejects(
						signCredentialAsset({
							assetPath,
							outputPath: embeddedPath,
							mimeType: format.mimeType,
							mode: 'embedded',
						}),
						(error) => error?.code === ErrorCode.UNSUPPORTED_OPERATION
					);
					row.embedded = {
						status:
							format.embedded === 'experimental'
								? 'experimental-not-enabled'
								: 'unsupported',
					};
				}
			} catch (error) {
				row.ok = false;
				row.embedded ??= { status: 'failed' };
				row.embeddedFailure = { stage, ...describeFailure(error) };
				evidence.failures.push({ file: fixture.file, ...row.embeddedFailure });
			}
			assert.equal(
				hash(await readFile(assetPath)),
				fixture.sha256,
				'Signing modified its source asset'
			);
		} catch (error) {
			row.ok = false;
			row.failure = describeFailure(error);
			evidence.failures.push({ file: fixture.file, ...row.failure });
		}
	}
	assert.equal(evidence.failures.length, 0, 'One or more native format checks failed');
	evidence.checks.push(
		'detached-roundtrips-preserve-original-assets',
		'supported-embedded-roundtrips',
		'tampered-assets-rejected',
		'unsupported-and-experimental-formats-explicit'
	);
	evidence.ok = true;
} catch (error) {
	evidence.failures.push({ stage: phase, ...describeFailure(error) });
} finally {
	for (const [name, value] of previousEnv) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	try {
		await rm(workspace, { recursive: true, force: true });
	} catch {
		cleanupFailed = true;
		evidence.ok = false;
		evidence.failures.push({
			stage: 'cleanup',
			code: 'FIXTURE_CLEANUP_FAILED',
			message: 'Disposable credential fixtures could not be removed',
		});
	}
}
if (!cleanupFailed) evidence.checks.push('disposable-workspace-cleanup');
const json = `${JSON.stringify(evidence, null, 2)}\n`;
if (options['--output']) {
	await mkdir(resolve(options['--output'], '..'), { recursive: true });
	await writeFile(options['--output'], json);
}
process.stdout.write(json);
if (!evidence.ok) process.exitCode = 1;
