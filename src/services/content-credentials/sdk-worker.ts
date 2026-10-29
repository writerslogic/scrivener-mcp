import {
	constants as cryptoConstants,
	createPrivateKey,
	sign as cryptoSign,
	X509Certificate,
	type KeyObject,
} from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import type { SigningAlg } from '@contentauth/c2pa-node';
import type {
	CredentialAssetWorkerRequest,
	CredentialSignerConfiguration,
	CredentialValidation,
	CredentialWorkerRequest,
	CredentialWorkerResponse,
} from './types.js';

const MAX_ASSET_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_CONFIGURATION_BYTES = 128 * 1024;
const MAX_CODES = 1024;
const TRUST_FAILURES = new Set(['signingCredential.untrusted', 'timeStamp.untrusted']);
type SDK = typeof import('@contentauth/c2pa-node');

class WorkerError extends Error {
	constructor(readonly code: string, message: string) { super(message); }
}

function fail(code: string, message: string): never { throw new WorkerError(code, message); }
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value) &&
		(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
	if (Object.keys(value).some((key) => !allowed.includes(key))) fail('REQUEST_INVALID', 'Credential request contains unsupported fields.');
}
function localPath(value: unknown): asserts value is string {
	if (typeof value !== 'string' || value.length > 8192 || value.includes('\0') || !isAbsolute(value) || /^\\\\\.\\/u.test(value)) {
		fail('REQUEST_INVALID', 'Credential paths must be bounded absolute local file paths.');
	}
}

export function validateCredentialWorkerRequest(value: unknown): CredentialWorkerRequest {
	if (!record(value)) fail('REQUEST_INVALID', 'Credential request must be an object.');
	if (value.operation === 'probe') {
		keys(value, ['operation']);
		return { operation: 'probe' };
	}
	keys(value, ['operation', 'assetPath', 'mimeType', 'mode', 'destinationPath', 'manifestPath', 'title', 'signer', 'trustAnchorsPath']);
	if (value.operation !== 'sign' && value.operation !== 'validate') fail('REQUEST_INVALID', 'Credential operation is unsupported.');
	localPath(value.assetPath);
	if (typeof value.mimeType !== 'string' || value.mimeType.length > 127 || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu.test(value.mimeType)) fail('REQUEST_INVALID', 'Credential MIME type is invalid.');
	if (value.mode !== 'embedded' && value.mode !== 'sidecar') fail('REQUEST_INVALID', 'Credential mode is invalid.');
	if (value.trustAnchorsPath !== undefined) localPath(value.trustAnchorsPath);
	if (value.destinationPath !== undefined) localPath(value.destinationPath);
	if (value.manifestPath !== undefined) localPath(value.manifestPath);
	if (value.title !== undefined && (typeof value.title !== 'string' || value.title.length > 500 || value.title.includes('\0'))) fail('REQUEST_INVALID', 'Credential title exceeds its supported bounds.');
	if (value.operation === 'sign') {
		if (!record(value.signer)) fail('SIGNER_REQUIRED', 'Signing requires administrator-configured credentials.');
		keys(value.signer, ['certificatePath', 'privateKeyPath', 'password']);
		localPath(value.signer.certificatePath);
		localPath(value.signer.privateKeyPath);
		if (typeof value.signer.password !== 'string' || !value.signer.password.length || Buffer.byteLength(value.signer.password) > 4096) fail('REQUEST_INVALID', 'Signing password exceeds its supported bounds.');
		const output = value.mode === 'embedded' ? value.destinationPath : value.manifestPath;
		localPath(output);
		if ((value.mode === 'embedded' && value.manifestPath !== undefined) || (value.mode === 'sidecar' && value.destinationPath !== undefined)) fail('REQUEST_INVALID', 'Signing output does not match the credential mode.');
		if ([value.assetPath, value.signer.certificatePath, value.signer.privateKeyPath, value.trustAnchorsPath].some((path) => path !== undefined && resolve(path as string) === resolve(output))) fail('REQUEST_INVALID', 'Credential output must be separate from its input files.');
	} else if (value.destinationPath !== undefined || value.signer !== undefined || value.title !== undefined || (value.mode === 'sidecar') !== (value.manifestPath !== undefined)) {
		fail('REQUEST_INVALID', 'Validation request contains signing fields or inconsistent sidecar inputs.');
	}
	return value as unknown as CredentialWorkerRequest;
}

async function readBounded(path: string, maximum: number): Promise<Buffer> {
	const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
	let handle: FileHandle | undefined;
	try {
		handle = await open(path, fsConstants.O_RDONLY | noFollow);
		const before = await handle.stat({ bigint: true });
		if (!before.isFile() || before.size < 1n || before.size > BigInt(maximum)) fail('INPUT_LIMIT', 'Credential input must be a nonempty regular file within the supported size limit.');
		const pathInfo = await lstat(path, { bigint: true });
		if (pathInfo.isSymbolicLink() || !pathInfo.isFile() || pathInfo.ino !== before.ino) fail('INPUT_UNSAFE', 'Credential input path changed or is not a regular file.');
		const data = Buffer.alloc(Number(before.size) + 1);
		let length = 0;
		while (length < data.length) {
			const read = await handle.read(data, length, data.length - length, length);
			if (!read.bytesRead) break;
			length += read.bytesRead;
		}
		const after = await handle.stat({ bigint: true });
		if (length !== Number(before.size) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) { data.fill(0); fail('INPUT_CHANGED', 'Credential input changed while it was being read.'); }
		return data.subarray(0, length);
	} catch (error) {
		if (error instanceof WorkerError) throw error;
		fail('INPUT_UNAVAILABLE', 'Credential input could not be opened safely.');
	} finally { await handle?.close(); }
}

function certificates(bytes: Buffer, code: string): X509Certificate[] {
	const text = bytes.toString('ascii');
	const blocks = text.match(/-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----/gu);
	if (!blocks?.length || blocks.length > 32 || text.replace(/-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----/gu, '').trim()) fail(code, 'Certificate configuration must contain only bounded PEM certificates.');
	try { return blocks.map((block) => new X509Certificate(block)); }
	catch { fail(code, 'Certificate configuration could not be parsed.'); }
}

export function decryptCredentialKey(encrypted: Buffer, password: Buffer): KeyObject {
	try {
		if (!encrypted.length || encrypted.length > MAX_CONFIGURATION_BYTES || !password.length || password.length > 4096) fail('SIGNER_KEY_INVALID', 'Signing key configuration exceeds its supported bounds.');
		if (!/^\s*-----BEGIN ENCRYPTED PRIVATE KEY-----\s+[A-Za-z0-9+/=\s]+-----END ENCRYPTED PRIVATE KEY-----\s*$/u.test(encrypted.toString('ascii'))) fail('SIGNER_KEY_ENCRYPTION_REQUIRED', 'Signing requires an encrypted PKCS8 private key.');
		try { return createPrivateKey({ key: encrypted, format: 'pem', type: 'pkcs8', passphrase: password }); }
		catch { fail('SIGNER_KEY_INVALID', 'The encrypted signing key could not be unlocked.'); }
	} finally { encrypted.fill(0); password.fill(0); }
}

export function createRawCredentialSigner(key: KeyObject): { algorithm: SigningAlg; sign: (data: Buffer) => Promise<Buffer> } {
	const checked = (data: Buffer): void => {
		if (!Buffer.isBuffer(data) || !data.length || data.length > MAX_MANIFEST_BYTES) fail('SIGNING_LIMIT', 'Signing payload exceeds its supported bounds.');
	};
	if (key.type !== 'private') fail('SIGNER_KEY_INVALID', 'Signing requires a private key.');
	if (key.asymmetricKeyType === 'ec') {
		const curves = { prime256v1: ['es256', 'sha256'], secp384r1: ['es384', 'sha384'], secp521r1: ['es512', 'sha512'] } as const;
		const curve = key.asymmetricKeyDetails?.namedCurve;
		if (!curve || !Object.prototype.hasOwnProperty.call(curves, curve)) fail('SIGNER_ALGORITHM_UNSUPPORTED', 'Signing key algorithm is not supported by C2PA.');
		const [algorithm, digest] = curves[curve as keyof typeof curves];
		return { algorithm, sign: async (data) => { checked(data); return cryptoSign(digest, data, { key, dsaEncoding: 'ieee-p1363' }); } };
	}
	if (key.asymmetricKeyType === 'rsa' || key.asymmetricKeyType === 'rsa-pss') {
		const details = key.asymmetricKeyDetails;
		if (!details?.modulusLength || details.modulusLength < 2048 || details.modulusLength > 8192) fail('SIGNER_ALGORITHM_UNSUPPORTED', 'C2PA RSA signing requires a 2048 through 8192 bit key.');
		const digest = details.hashAlgorithm ?? 'sha256';
		const hashes = { sha256: ['ps256', 32], sha384: ['ps384', 48], sha512: ['ps512', 64] } as const;
		if (!Object.prototype.hasOwnProperty.call(hashes, digest)) fail('SIGNER_ALGORITHM_UNSUPPORTED', 'RSA signing digest is not supported by C2PA.');
		const [algorithm, saltLength] = hashes[digest as keyof typeof hashes];
		if ((details.mgf1HashAlgorithm && details.mgf1HashAlgorithm !== digest) || (details.saltLength !== undefined && details.saltLength > saltLength)) fail('SIGNER_ALGORITHM_UNSUPPORTED', 'RSA-PSS key restrictions are incompatible with C2PA.');
		return { algorithm, sign: async (data) => { checked(data); return cryptoSign(digest, data, { key, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength }); } };
	}
	if (key.asymmetricKeyType === 'ed25519') return { algorithm: 'ed25519', sign: async (data) => { checked(data); return cryptoSign(null, data, key); } };
	fail('SIGNER_ALGORITHM_UNSUPPORTED', 'Signing key algorithm is not supported by C2PA.');
}

async function signerFor(sdk: SDK, configuration: CredentialSignerConfiguration): Promise<InstanceType<SDK['CallbackSigner']>> {
	let encrypted: Buffer | undefined;
	let password: Buffer | undefined;
	try {
		password = Buffer.from(configuration.password, 'utf8');
		configuration.password = '';
		const certs = await readBounded(configuration.certificatePath, MAX_CONFIGURATION_BYTES);
		const chain = certificates(certs, 'SIGNER_CERTIFICATE_INVALID');
		encrypted = await readBounded(configuration.privateKeyPath, MAX_CONFIGURATION_BYTES);
		const key = decryptCredentialKey(encrypted, password);
		if (!chain[0].checkPrivateKey(key)) fail('SIGNER_KEY_MISMATCH', 'Signing certificate and private key do not match.');
		const callback = createRawCredentialSigner(key);
		return sdk.CallbackSigner.newSigner({ alg: callback.algorithm, certs: [certs], reserveSize: certs.length + 32 * 1024, directCoseHandling: false }, callback.sign);
	} finally { encrypted?.fill(0); password?.fill(0); configuration.password = ''; }
}

export function credentialContextSettings(anchors?: string) {
	return {
		verify: { verifyAfterReading: true, verifyAfterSign: true, verifyTrust: true, verifyTimestampTrust: true, ocspFetch: false, remoteManifestFetch: false },
		trust: { verifyTrustList: true, ...(anchors ? { trustAnchors: anchors } : {}) },
		cawgTrust: { verifyTrustList: false },
		builder: { generateC2paArchive: true as const, thumbnail: { enabled: false } },
	};
}

function boundedReport(value: unknown): asserts value is Record<string, unknown> {
	if (!record(value)) fail('REPORT_INVALID', 'The native SDK returned an invalid manifest report.');
	let bytes = 0;
	let nodes = 0;
	const visit = (item: unknown, depth: number): void => {
		if (depth > 64 || ++nodes > 250_000) fail('REPORT_LIMIT', 'The native manifest report exceeds its supported bounds.');
		if (typeof item === 'string') {
			if (Buffer.byteLength(item) > MAX_MANIFEST_BYTES) fail('REPORT_LIMIT', 'The native manifest report exceeds its supported bounds.');
			bytes += Buffer.byteLength(JSON.stringify(item));
		} else if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) bytes += String(item).length;
		else if (Array.isArray(item)) {
			bytes += 2 + Math.max(0, item.length - 1);
			for (const child of item) visit(child, depth + 1);
		} else if (record(item)) {
			const entries = Object.entries(item);
			bytes += 2 + Math.max(0, entries.length - 1);
			for (const [key, child] of entries) { bytes += Buffer.byteLength(JSON.stringify(key)) + 1; visit(child, depth + 1); }
		} else fail('REPORT_INVALID', 'The native SDK returned unsupported report data.');
		if (bytes > MAX_MANIFEST_BYTES) fail('REPORT_LIMIT', 'The native manifest report exceeds its supported bounds.');
	};
	visit(value, 0);
}

export function normalizeCredentialValidation(report: unknown, configuredRoots: boolean): CredentialValidation {
	const policy = configuredRoots ? 'configured-roots' : 'none';
	if (report === null) return { state: 'unsigned', integrity: 'not-evaluated', trust: 'not-evaluated', trustPolicy: policy, validationCodes: [], report: null };
	boundedReport(report);
	const codes = new Set<string>();
	const failures = new Set<string>();
	const statuses = (items: unknown, failure = false): void => {
		if (items === undefined || items === null) return;
		if (!Array.isArray(items)) fail('REPORT_INVALID', 'Native validation statuses are malformed.');
		for (const item of items) {
			if (!record(item) || typeof item.code !== 'string') fail('REPORT_INVALID', 'Native validation statuses are malformed.');
			const code = item.code.trim();
			if (!/^[a-z][a-z0-9_.-]{0,127}$/iu.test(code)) fail('REPORT_INVALID', 'A native validation code exceeds its supported bounds.');
			codes.add(code);
			if (failure || item.success === false) failures.add(code);
			if (codes.size > MAX_CODES) fail('REPORT_LIMIT', 'The native SDK returned too many validation codes.');
		}
	};
	const groups = (value: unknown): void => {
		if (value === undefined || value === null) return;
		if (!record(value)) fail('REPORT_INVALID', 'Native validation groups are malformed.');
		statuses(value.success); statuses(value.informational); statuses(value.failure, true);
	};
	statuses(report.validation_status);
	if (report.validation_results !== undefined && report.validation_results !== null) {
		if (!record(report.validation_results)) fail('REPORT_INVALID', 'Native validation results are malformed.');
		groups(report.validation_results.activeManifest);
		const deltas = report.validation_results.ingredientDeltas;
		if (deltas !== undefined && deltas !== null) {
			if (!Array.isArray(deltas)) fail('REPORT_INVALID', 'Native ingredient validation results are malformed.');
			for (const delta of deltas) { if (!record(delta)) fail('REPORT_INVALID', 'Native ingredient validation results are malformed.'); groups(delta.validationDeltas); }
		}
	}
	const active = report.active_manifest;
	const validActive = typeof active === 'string' && active.length > 0 && active.length <= 4096 && record(report.manifests) && Object.prototype.hasOwnProperty.call(report.manifests, active) && record(report.manifests[active]);
	const state = report.validation_state;
	const evaluated = state === 'Invalid' || state === 'Valid' || state === 'Trusted';
	const invalid = !validActive || !evaluated || state === 'Invalid' || [...failures].some((code) => !TRUST_FAILURES.has(code));
	const trusted = !invalid && configuredRoots && state === 'Trusted' && ![...failures].some((code) => TRUST_FAILURES.has(code));
	return {
		state: invalid ? 'invalid' : trusted ? 'valid' : 'untrusted',
		integrity: invalid ? (evaluated && validActive ? 'invalid' : 'not-evaluated') : 'valid',
		trust: trusted ? 'trusted' : invalid ? 'not-evaluated' : 'untrusted',
		trustPolicy: policy,
		...(validActive ? { activeManifest: active } : {}),
		validationCodes: [...codes].sort(), report,
	};
}

async function loadSdk(): Promise<{ sdk: SDK; version: string }> {
	try {
		const sdk = await import('@contentauth/c2pa-node');
		const metadata = await import('@contentauth/c2pa-node/package.json', { with: { type: 'json' } });
		if (typeof sdk.Reader?.fromAsset !== 'function' || typeof sdk.Reader.fromManifestDataAndAsset !== 'function' || typeof sdk.Builder?.withJsonAsync !== 'function' || typeof sdk.CallbackSigner?.newSigner !== 'function' || typeof metadata.default.version !== 'string') throw new Error();
		return { sdk, version: metadata.default.version };
	} catch { fail('SDK_UNAVAILABLE', 'The native Content Credentials SDK is unavailable on this installation.'); }
}

function nativeFailure(error: unknown, stage: 'read' | 'sign'): never {
	if (error instanceof WorkerError) throw error;
	const name = error instanceof Error ? error.name.slice(0, 512) : '';
	if (/^C2pa\((?:UnsupportedType|UnsupportedFormat)(?:[(), ]|$)/u.test(name)) fail('FORMAT_UNSUPPORTED', 'The native SDK does not support this asset format or operation.');
	if (/^(?:RemoteManifestFetch\(|C2pa\(RemoteManifest)/u.test(name)) fail('REMOTE_FETCH_DISABLED', 'Remote credential retrieval is disabled; supply a local manifest.');
	fail(stage === 'read' ? 'VALIDATION_FAILED' : 'SIGNING_FAILED', stage === 'read' ? 'The native SDK could not validate this asset or manifest.' : 'The native SDK could not sign this asset with the configured credentials.');
}

async function validateAsset(sdk: SDK, asset: Buffer, mimeType: string, context: InstanceType<SDK['Context']>, roots: boolean, manifest?: Buffer): Promise<CredentialValidation> {
	try {
		const input = { buffer: asset, mimeType };
		const reader = manifest ? await sdk.Reader.fromManifestDataAndAsset(manifest, input, context) : await sdk.Reader.fromAsset(input, context);
		return normalizeCredentialValidation(reader?.json() ?? null, roots);
	} catch (error) { nativeFailure(error, 'read'); }
}

async function writeOutput(path: string, data: Buffer): Promise<void> {
	let file: FileHandle | undefined;
	try {
		file = await open(path, 'wx', 0o600);
		await file.writeFile(data);
		await file.sync();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('OUTPUT_EXISTS', 'The staged credential output already exists.');
		fail('OUTPUT_WRITE_FAILED', 'The staged credential output could not be written.');
	} finally { await file?.close(); }
}

async function executeAsset(request: CredentialAssetWorkerRequest, sdk: SDK, version: string): Promise<CredentialWorkerResponse> {
	let anchors: string | undefined;
	if (request.trustAnchorsPath) {
		const bytes = await readBounded(request.trustAnchorsPath, MAX_CONFIGURATION_BYTES);
		certificates(bytes, 'TRUST_ANCHORS_INVALID');
		anchors = bytes.toString('ascii');
	}
	const context = new sdk.Context(credentialContextSettings(anchors));
	const asset = await readBounded(request.assetPath, MAX_ASSET_BYTES);
	if (request.operation === 'validate') {
		const manifest = request.manifestPath ? await readBounded(request.manifestPath, MAX_MANIFEST_BYTES) : undefined;
		return { ok: true, operation: 'validate', sdkVersion: version, validation: await validateAsset(sdk, asset, request.mimeType, context, !!anchors, manifest), assetBytes: asset.length, ...(manifest ? { manifestBytes: manifest.length } : {}) };
	}
	let existing: CredentialValidation | undefined;
	try { existing = await validateAsset(sdk, asset, request.mimeType, context, !!anchors); }
	catch (error) {
		if (request.mode !== 'sidecar' || !(error instanceof WorkerError) || error.code !== 'FORMAT_UNSUPPORTED') throw error;
	}
	if (existing?.state === 'invalid') fail('SOURCE_CREDENTIALS_INVALID', 'Existing credentials are invalid; attaching another credential would obscure the failure.');
	try {
		const builder = await sdk.Builder.withJsonAsync({ title: request.title || 'Credential attached to existing asset', format: request.mimeType, claim_generator_info: [{ name: 'scrivener-mcp' }] }, context);
		builder.setIntent('edit');
		builder.setNoEmbed(request.mode === 'sidecar');
		const signer = await signerFor(sdk, request.signer!);
		const output: { buffer: Buffer | null } = { buffer: null };
		const manifest = await builder.signAsync(signer, { buffer: asset, mimeType: request.mimeType }, output);
		if (!Buffer.isBuffer(manifest) || !manifest.length || manifest.length > MAX_MANIFEST_BYTES || !Buffer.isBuffer(output.buffer) || output.buffer.length > MAX_ASSET_BYTES + MAX_MANIFEST_BYTES) fail('OUTPUT_LIMIT', 'The native SDK output exceeds its supported bounds.');
		const validation = request.mode === 'sidecar'
			? await validateAsset(sdk, asset, request.mimeType, context, !!anchors, manifest)
			: await validateAsset(sdk, output.buffer, request.mimeType, context, !!anchors);
		if (validation.integrity !== 'valid') fail('OUTPUT_VALIDATION_FAILED', 'The produced credential failed native integrity validation.');
		if (existing?.activeManifest && (!record(validation.report?.manifests) || !record(validation.report.manifests[existing.activeManifest]))) fail('OUTPUT_PROVENANCE_MISSING', 'The produced credential did not preserve the existing manifest history.');
		const destination = request.mode === 'sidecar' ? request.manifestPath! : request.destinationPath!;
		await writeOutput(destination, request.mode === 'sidecar' ? manifest : output.buffer);
		return { ok: true, operation: 'sign', sdkVersion: version, validation, manifestBytes: manifest.length, assetBytes: request.mode === 'sidecar' ? asset.length : output.buffer.length };
	} catch (error) { nativeFailure(error, 'sign'); }
}

export async function handleCredentialWorkerRequest(value: unknown): Promise<CredentialWorkerResponse> {
	let request: CredentialWorkerRequest | undefined;
	try {
		request = validateCredentialWorkerRequest(value);
		const { sdk, version } = await loadSdk();
		if (request.operation === 'probe') {
			try { await sdk.Builder.newAsync(new sdk.Context(credentialContextSettings())); }
			catch { fail('SDK_UNAVAILABLE', 'The native Content Credentials SDK could not initialize.'); }
			return { ok: true, operation: 'probe', sdkVersion: version };
		}
		return await executeAsset(request, sdk, version);
	} catch (error) {
		if (error instanceof WorkerError) return { ok: false, code: error.code, message: error.message };
		return { ok: false, code: 'OPERATION_FAILED', message: 'The credential worker could not complete the operation.' };
	} finally {
		if (request?.operation === 'sign' && request.signer) request.signer.password = '';
		if (record(value) && record(value.signer)) value.signer.password = '';
	}
}

if (['sdk-worker.js', 'sdk-worker.ts'].includes(basename(process.argv[1] ?? '')) && typeof process.send === 'function') {
	let received = false;
	let duplicate = false;
	process.on('message', (message: unknown) => {
		if (received) { duplicate = true; if (record(message) && record(message.signer)) message.signer.password = ''; return; }
		received = true;
		void handleCredentialWorkerRequest(message).then((result) => {
			const response: CredentialWorkerResponse = duplicate ? { ok: false, code: 'PROTOCOL_INVALID', message: 'A credential worker accepts exactly one request.' } : result;
			if (!process.connected || !process.send) process.exit(1);
			try {
				process.send(response, (error) => {
					if (error) process.exit(1);
					if (process.connected) process.disconnect();
					// The published signer retains a referenced Neon channel and exposes no disposal API.
					process.exit(0);
				});
			} catch { process.exit(1); }
		}).catch(() => { process.exit(1); });
	});
}
