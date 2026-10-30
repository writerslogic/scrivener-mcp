import {
	constants as cryptoConstants,
	createPrivateKey,
	createHash,
	sign as cryptoSign,
	X509Certificate,
	type KeyObject,
} from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { readStableCredentialFile } from './local-files.js';
import { ErrorCode } from '../../core/errors.js';
import { prepareUnsignedCredentialArchive } from './archive-preparation.js';
import { credentialProductVersion } from './worker-path.cjs';
import { CREDENTIAL_LIMITS, MAX_CONFIGURATION_BYTES, MAX_VALIDATION_CODES } from './limits.js';
import { resolveCredentialFormat } from './formats.js';
import {
	readCredentialAsset,
	probeCredentialBinding,
	signCredentialAssetBytes,
	type CredentialCallbackSigner,
} from './binding.js';
import { credentialWireSettings, parseCredentialTrustList } from './trust.js';
import { MAX_TRUST_CONFIGURATION_BYTES } from './limits.js';
import { CREDENTIAL_KEY_POLICY, inspectEncryptedCredentialKey } from './key-policy.js';
import type {
	CredentialAssetWorkerRequest,
	CredentialSignerConfiguration,
	CredentialValidation,
	CredentialWorkerRequest,
	CredentialWorkerResponse,
	CredentialSigningAlgorithm,
} from './types.js';

const { assetBytes: MAX_ASSET_BYTES, manifestBytes: MAX_MANIFEST_BYTES } = CREDENTIAL_LIMITS;
const TRUST_FAILURES = new Set(['signingCredential.untrusted', 'timeStamp.untrusted']);
const ASSET_BINDINGS = new Set([
	'assertion.dataHash.match',
	'assertion.bmffHash.match',
	'assertion.boxesHash.match',
	'assertion.collectionHash.match',
]);
type SigningAlg = CredentialSigningAlgorithm;

class WorkerError extends Error {
	constructor(
		readonly code: string,
		message: string
	) {
		super(message);
	}
}

function fail(code: string, message: string): never {
	throw new WorkerError(code, message);
}
function record(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
	);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
	if (Object.keys(value).some((key) => !allowed.includes(key)))
		fail('REQUEST_INVALID', 'Credential request contains unsupported fields.');
}
function localPath(value: unknown): asserts value is string {
	if (
		typeof value !== 'string' ||
		value.length > 8192 ||
		value.includes('\0') ||
		!isAbsolute(value) ||
		/^\\\\\.\\/u.test(value)
	) {
		fail('REQUEST_INVALID', 'Credential paths must be bounded absolute local file paths.');
	}
}

export function validateCredentialWorkerRequest(value: unknown): CredentialWorkerRequest {
	if (!record(value)) fail('REQUEST_INVALID', 'Credential request must be an object.');
	if (value.operation === 'probe') {
		keys(value, ['operation']);
		return { operation: 'probe' };
	}
	keys(value, [
		'operation',
		'assetPath',
		'mimeType',
		'mode',
		'destinationPath',
		'manifestPath',
		'title',
		'signer',
		'trustAnchorsPath',
		'timestampTrustAnchorsPath',
		'validationTime',
		'includeCrjson',
		'sourceManifestPath',
		'preserveInvalidSource',
	]);
	if (value.operation !== 'sign' && value.operation !== 'validate')
		fail('REQUEST_INVALID', 'Credential operation is unsupported.');
	localPath(value.assetPath);
	if (
		typeof value.mimeType !== 'string' ||
		value.mimeType.length > 127 ||
		!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu.test(value.mimeType)
	)
		fail('REQUEST_INVALID', 'Credential MIME type is invalid.');
	if (value.mode !== 'embedded' && value.mode !== 'sidecar')
		fail('REQUEST_INVALID', 'Credential mode is invalid.');
	if (value.trustAnchorsPath !== undefined) localPath(value.trustAnchorsPath);
	if (value.timestampTrustAnchorsPath !== undefined) localPath(value.timestampTrustAnchorsPath);
	if (value.sourceManifestPath !== undefined) localPath(value.sourceManifestPath);
	if (value.includeCrjson !== undefined && typeof value.includeCrjson !== 'boolean')
		fail('REQUEST_INVALID', 'includeCrjson must be a boolean.');
	if (
		value.preserveInvalidSource !== undefined &&
		typeof value.preserveInvalidSource !== 'boolean'
	)
		fail('REQUEST_INVALID', 'preserveInvalidSource must be a boolean.');
	if (
		value.validationTime !== undefined &&
		(typeof value.validationTime !== 'string' ||
			value.validationTime.length > 64 ||
			!/^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/u.test(
				value.validationTime
			) ||
			value.trustAnchorsPath === undefined ||
			value.timestampTrustAnchorsPath === undefined)
	)
		fail(
			'REQUEST_INVALID',
			'Assessment validation requires an RFC 3339 time and both trust lists.'
		);
	if (value.destinationPath !== undefined) localPath(value.destinationPath);
	if (value.manifestPath !== undefined) localPath(value.manifestPath);
	if (
		value.title !== undefined &&
		(typeof value.title !== 'string' || value.title.length > 500 || value.title.includes('\0'))
	)
		fail('REQUEST_INVALID', 'Credential title exceeds its supported bounds.');
	if (value.operation === 'sign') {
		if (value.validationTime !== undefined || value.includeCrjson !== undefined)
			fail('REQUEST_INVALID', 'Assessment output and time are validation-only fields.');
		if (!record(value.signer))
			fail('SIGNER_REQUIRED', 'Signing requires administrator-configured credentials.');
		keys(value.signer, ['certificatePath', 'privateKeyPath', 'password']);
		localPath(value.signer.certificatePath);
		localPath(value.signer.privateKeyPath);
		if (
			typeof value.signer.password !== 'string' ||
			!value.signer.password.length ||
			Buffer.byteLength(value.signer.password) > 4096
		)
			fail('REQUEST_INVALID', 'Signing password exceeds its supported bounds.');
		const output = value.mode === 'embedded' ? value.destinationPath : value.manifestPath;
		localPath(output);
		if (
			(value.mode === 'embedded' && value.manifestPath !== undefined) ||
			(value.mode === 'sidecar' && value.destinationPath !== undefined)
		)
			fail('REQUEST_INVALID', 'Signing output does not match the credential mode.');
		if (
			[
				value.assetPath,
				value.signer.certificatePath,
				value.signer.privateKeyPath,
				value.trustAnchorsPath,
				value.timestampTrustAnchorsPath,
				value.sourceManifestPath,
			].some((path) => path !== undefined && resolve(path as string) === resolve(output))
		)
			fail('REQUEST_INVALID', 'Credential output must be separate from its input files.');
	} else if (
		value.destinationPath !== undefined ||
		value.sourceManifestPath !== undefined ||
		value.preserveInvalidSource !== undefined ||
		value.signer !== undefined ||
		value.title !== undefined ||
		(value.mode === 'sidecar') !== (value.manifestPath !== undefined)
	) {
		fail(
			'REQUEST_INVALID',
			'Validation request contains signing fields or inconsistent sidecar inputs.'
		);
	}
	return value as unknown as CredentialWorkerRequest;
}

async function readBounded(path: string, maximum: number, privateKey = false): Promise<Buffer> {
	try {
		const { bytes } = await readStableCredentialFile(path, maximum, 'Credential input', {
			privateKey,
		});
		if (!bytes.length) fail('INPUT_LIMIT', 'Credential input must not be empty.');
		return bytes;
	} catch (error) {
		if (error instanceof WorkerError) throw error;
		const code = (error as NodeJS.ErrnoException)?.code;
		if (code === ErrorCode.CONFIGURATION_ERROR)
			fail(
				'SIGNER_KEY_ACCESS_INVALID',
				'Signing key access must be restricted to its owner and trusted system administrators.'
			);
		if (code === ErrorCode.DOCUMENT_TOO_LARGE)
			fail('INPUT_LIMIT', 'Credential input exceeds its supported size limit.');
		if (code === ErrorCode.INVALID_STATE)
			fail('INPUT_CHANGED', 'Credential input changed while reading.');
		if (code === ErrorCode.INVALID_FORMAT)
			fail(
				'INPUT_UNSAFE',
				'Credential input must be a regular file without a symbolic link.'
			);
		return fail('INPUT_UNAVAILABLE', 'Credential input could not be opened safely.');
	}
}

function certificates(bytes: Buffer, code: string): X509Certificate[] {
	const text = bytes.toString('ascii');
	const blocks = text.match(
		/-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----/gu
	);
	if (
		!blocks?.length ||
		blocks.length > 32 ||
		text
			.replace(
				/-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----/gu,
				''
			)
			.trim()
	)
		fail(code, 'Certificate configuration must contain only bounded PEM certificates.');
	try {
		return blocks.map((block) => new X509Certificate(block));
	} catch {
		fail(code, 'Certificate configuration could not be parsed.');
	}
}

export function decryptCredentialKey(encrypted: Buffer, password: Buffer): KeyObject {
	try {
		if (
			!encrypted.length ||
			encrypted.length > MAX_CONFIGURATION_BYTES ||
			!password.length ||
			password.length > 4096
		)
			fail('SIGNER_KEY_INVALID', 'Signing key configuration exceeds its supported bounds.');
		if (
			!/^\s*-----BEGIN ENCRYPTED PRIVATE KEY-----\s+[A-Za-z0-9+/=\s]+-----END ENCRYPTED PRIVATE KEY-----\s*$/u.test(
				encrypted.toString('ascii')
			)
		)
			fail(
				'SIGNER_KEY_ENCRYPTION_REQUIRED',
				'Signing requires an encrypted PKCS8 private key.'
			);
		try {
			if (password.length < CREDENTIAL_KEY_POLICY.minimumPasswordBytes)
				throw new Error('SHORT_PASSWORD');
			inspectEncryptedCredentialKey(encrypted);
		} catch {
			fail(
				'SIGNER_KEY_POLICY',
				'Signing requires PBES2 AES-256-CBC, PBKDF2-HMAC-SHA256 with 600000–2000000 iterations, a 16–64 byte salt, and a password of at least 16 bytes. Re-encrypt the existing key using the documented migration.'
			);
		}
		try {
			return createPrivateKey({
				key: encrypted,
				format: 'pem',
				type: 'pkcs8',
				passphrase: password,
			});
		} catch {
			fail('SIGNER_KEY_INVALID', 'The encrypted signing key could not be unlocked.');
		}
	} finally {
		encrypted.fill(0);
		password.fill(0);
	}
}

export function createRawCredentialSigner(key: KeyObject): {
	algorithm: SigningAlg;
	sign: (data: Buffer) => Promise<Buffer>;
} {
	const checked = (data: Buffer): void => {
		if (!Buffer.isBuffer(data) || !data.length || data.length > MAX_MANIFEST_BYTES)
			fail('SIGNING_LIMIT', 'Signing payload exceeds its supported bounds.');
	};
	if (key.type !== 'private') fail('SIGNER_KEY_INVALID', 'Signing requires a private key.');
	if (key.asymmetricKeyType === 'ec') {
		const curves = {
			prime256v1: ['es256', 'sha256'],
			secp384r1: ['es384', 'sha384'],
			secp521r1: ['es512', 'sha512'],
		} as const;
		const curve = key.asymmetricKeyDetails?.namedCurve;
		if (!curve || !Object.prototype.hasOwnProperty.call(curves, curve))
			fail('SIGNER_ALGORITHM_UNSUPPORTED', 'Signing key algorithm is not supported by C2PA.');
		const [algorithm, digest] = curves[curve as keyof typeof curves];
		return {
			algorithm,
			sign: async (data) => {
				checked(data);
				return cryptoSign(digest, data, { key, dsaEncoding: 'ieee-p1363' });
			},
		};
	}
	if (key.asymmetricKeyType === 'rsa' || key.asymmetricKeyType === 'rsa-pss') {
		const details = key.asymmetricKeyDetails;
		if (!details?.modulusLength || details.modulusLength < 2048 || details.modulusLength > 8192)
			fail(
				'SIGNER_ALGORITHM_UNSUPPORTED',
				'C2PA RSA signing requires a 2048 through 8192 bit key.'
			);
		const digest = details.hashAlgorithm ?? 'sha256';
		const hashes = {
			sha256: ['ps256', 32],
			sha384: ['ps384', 48],
			sha512: ['ps512', 64],
		} as const;
		if (!Object.prototype.hasOwnProperty.call(hashes, digest))
			fail('SIGNER_ALGORITHM_UNSUPPORTED', 'RSA signing digest is not supported by C2PA.');
		const [algorithm, saltLength] = hashes[digest as keyof typeof hashes];
		if (
			(details.mgf1HashAlgorithm && details.mgf1HashAlgorithm !== digest) ||
			(details.saltLength !== undefined && details.saltLength > saltLength)
		)
			fail(
				'SIGNER_ALGORITHM_UNSUPPORTED',
				'RSA-PSS key restrictions are incompatible with C2PA.'
			);
		return {
			algorithm,
			sign: async (data) => {
				checked(data);
				return cryptoSign(digest, data, {
					key,
					padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
					saltLength,
				});
			},
		};
	}
	if (key.asymmetricKeyType === 'ed25519')
		return {
			algorithm: 'ed25519',
			sign: async (data) => {
				checked(data);
				return cryptoSign(null, data, key);
			},
		};
	fail('SIGNER_ALGORITHM_UNSUPPORTED', 'Signing key algorithm is not supported by C2PA.');
}

async function signerFor(
	configuration: CredentialSignerConfiguration
): Promise<CredentialCallbackSigner> {
	let encrypted: Buffer | undefined;
	let password: Buffer | undefined;
	try {
		password = Buffer.from(configuration.password, 'utf8');
		configuration.password = '';
		const certs = await readBounded(configuration.certificatePath, MAX_CONFIGURATION_BYTES);
		const chain = certificates(certs, 'SIGNER_CERTIFICATE_INVALID');
		encrypted = await readBounded(configuration.privateKeyPath, MAX_CONFIGURATION_BYTES, true);
		const key = decryptCredentialKey(encrypted, password);
		if (!chain[0].checkPrivateKey(key))
			fail('SIGNER_KEY_MISMATCH', 'Signing certificate and private key do not match.');
		const callback = createRawCredentialSigner(key);
		return {
			algorithm: callback.algorithm,
			certificates: certs.toString('ascii'),
			sign: (bytes) => callback.sign(Buffer.from(bytes)),
		};
	} finally {
		encrypted?.fill(0);
		password?.fill(0);
		configuration.password = '';
	}
}

export const credentialContextSettings = credentialWireSettings;

function boundedReport(value: unknown): asserts value is Record<string, unknown> {
	if (!record(value))
		fail('REPORT_INVALID', 'The native SDK returned an invalid manifest report.');
	let bytes = 0;
	let nodes = 0;
	const visit = (item: unknown, depth: number): void => {
		if (depth > 64 || ++nodes > 250_000)
			fail('REPORT_LIMIT', 'The native manifest report exceeds its supported bounds.');
		if (typeof item === 'string') {
			if (Buffer.byteLength(item) > MAX_MANIFEST_BYTES)
				fail('REPORT_LIMIT', 'The native manifest report exceeds its supported bounds.');
			bytes += Buffer.byteLength(JSON.stringify(item));
		} else if (
			item === null ||
			typeof item === 'boolean' ||
			(typeof item === 'number' && Number.isFinite(item))
		)
			bytes += String(item).length;
		else if (Array.isArray(item)) {
			bytes += 2 + Math.max(0, item.length - 1);
			for (const child of item) visit(child, depth + 1);
		} else if (record(item)) {
			const entries = Object.entries(item);
			bytes += 2 + Math.max(0, entries.length - 1);
			for (const [key, child] of entries) {
				bytes += Buffer.byteLength(JSON.stringify(key)) + 1;
				visit(child, depth + 1);
			}
		} else fail('REPORT_INVALID', 'The native SDK returned unsupported report data.');
		if (bytes > MAX_MANIFEST_BYTES)
			fail('REPORT_LIMIT', 'The native manifest report exceeds its supported bounds.');
	};
	visit(value, 0);
}

export function normalizeCredentialValidation(
	report: unknown,
	configuredRoots: boolean
): CredentialValidation {
	const policy = configuredRoots ? 'configured-roots' : 'none';
	if (report === null)
		return {
			state: 'unsigned',
			integrity: 'not-evaluated',
			trust: 'not-evaluated',
			trustPolicy: policy,
			validationCodes: [],
			report: null,
		};
	boundedReport(report);
	const codes = new Set<string>();
	const failures = new Set<string>();
	const activeFailures = new Set<string>();
	const currentSuccesses = new Set<string>();
	const statuses = (
		items: unknown,
		failure = false,
		currentSuccess = false,
		currentFailure = false
	): void => {
		if (items === undefined || items === null) return;
		if (!Array.isArray(items))
			fail('REPORT_INVALID', 'Native validation statuses are malformed.');
		for (const item of items) {
			if (!record(item) || typeof item.code !== 'string')
				fail('REPORT_INVALID', 'Native validation statuses are malformed.');
			const code = item.code.trim();
			if (!/^[a-z][a-z0-9_.-]{0,127}$/iu.test(code))
				fail('REPORT_INVALID', 'A native validation code exceeds its supported bounds.');
			codes.add(code);
			if (failure || item.success === false) failures.add(code);
			else if (currentSuccess) currentSuccesses.add(code);
			if (currentFailure && (failure || item.success === false)) activeFailures.add(code);
			if (codes.size > MAX_VALIDATION_CODES)
				fail('REPORT_LIMIT', 'The native SDK returned too many validation codes.');
		}
	};
	const groups = (value: unknown, current = false): void => {
		if (value === undefined || value === null) return;
		if (!record(value)) fail('REPORT_INVALID', 'Native validation groups are malformed.');
		statuses(value.success, false, current, current);
		statuses(value.informational, false, false, current);
		statuses(value.failure, true, false, current);
	};
	statuses(report.validation_status, true, false, true);
	if (report.validation_results !== undefined && report.validation_results !== null) {
		if (!record(report.validation_results))
			fail('REPORT_INVALID', 'Native validation results are malformed.');
		groups(report.validation_results.activeManifest, true);
		const deltas = report.validation_results.ingredientDeltas;
		if (deltas !== undefined && deltas !== null) {
			if (!Array.isArray(deltas))
				fail('REPORT_INVALID', 'Native ingredient validation results are malformed.');
			for (const delta of deltas) {
				if (!record(delta))
					fail('REPORT_INVALID', 'Native ingredient validation results are malformed.');
				groups(delta.validationDeltas);
			}
		}
	}
	const active = report.active_manifest;
	const validActive =
		typeof active === 'string' &&
		active.length > 0 &&
		active.length <= 4096 &&
		record(report.manifests) &&
		Object.prototype.hasOwnProperty.call(report.manifests, active) &&
		record(report.manifests[active]);
	const state = report.validation_state;
	const evaluated = state === 'Invalid' || state === 'Valid' || state === 'Trusted';
	const bound =
		currentSuccesses.has('claimSignature.validated') &&
		[...ASSET_BINDINGS].some((code) => currentSuccesses.has(code));
	const integrityFailure = [...failures].some((code) => !TRUST_FAILURES.has(code));
	const invalid = !validActive || !evaluated || !bound || state === 'Invalid' || integrityFailure;
	const trusted =
		!invalid &&
		configuredRoots &&
		state === 'Trusted' &&
		![...failures].some((code) => TRUST_FAILURES.has(code));
	const recordedSourceCodes = new Set<string>();
	if (validActive && record(report.manifests)) {
		for (const manifest of Object.values(report.manifests)) {
			if (record(manifest) && Array.isArray(manifest.assertions)) {
				for (const assertion of manifest.assertions) {
					if (
						!record(assertion) ||
						assertion.label !== 'com.writerslogic.source-validation' ||
						!record(assertion.data) ||
						assertion.data.state !== 'invalid' ||
						!Array.isArray(assertion.data.validationCodes)
					)
						continue;
					for (const code of assertion.data.validationCodes) {
						if (
							typeof code !== 'string' ||
							!/^[a-z][a-z0-9_.-]{0,127}$/iu.test(code) ||
							recordedSourceCodes.size >= MAX_VALIDATION_CODES
						)
							fail(
								'REPORT_INVALID',
								'Recorded source validation codes are malformed or excessive.'
							);
						recordedSourceCodes.add(code);
					}
				}
			}
		}
	}
	return {
		state: invalid ? 'invalid' : trusted ? 'valid' : 'untrusted',
		integrity: invalid
			? evaluated && validActive && (bound || integrityFailure)
				? 'invalid'
				: 'not-evaluated'
			: 'valid',
		trust: trusted ? 'trusted' : invalid ? 'not-evaluated' : 'untrusted',
		trustPolicy: policy,
		...(validActive ? { activeManifest: active } : {}),
		validationCodes: [...codes].sort(),
		...(recordedSourceCodes.size
			? { sourceValidationCodes: [...recordedSourceCodes].sort() }
			: {}),
		activeIntegrity:
			validActive && evaluated && bound
				? [...activeFailures].some((code) => !TRUST_FAILURES.has(code))
					? 'invalid'
					: 'valid'
				: 'not-evaluated',
		report,
	};
}

async function loadSdk(): Promise<{ version: string }> {
	try {
		return { version: await probeCredentialBinding() };
	} catch {
		fail(
			'SDK_UNAVAILABLE',
			'The native Content Credentials SDK is unavailable on this installation.'
		);
	}
}

function nativeFailure(error: unknown, stage: 'read' | 'sign'): never {
	if (error instanceof WorkerError) throw error;
	if (typeof error === 'string') {
		const errors: Record<string, string> = {
			FORMAT_UNSUPPORTED: 'The SDK does not support this asset format or operation.',
			ZIP_COMPRESSION_UNSUPPORTED: 'The SDK cannot read DEFLATE archive credentials.',
			VALIDATION_TIME_INVALID: 'The assessment time is not a valid RFC 3339 date.',
			INPUT_LIMIT: 'Credential input exceeds its supported bounds.',
			REPORT_LIMIT: 'The credential report exceeds its supported bounds.',
		};
		if (Object.prototype.hasOwnProperty.call(errors, error)) fail(error, errors[error]);
	}
	const name = error instanceof Error ? error.name.slice(0, 512) : '';
	const message = error instanceof Error ? error.message.slice(0, 1024) : '';
	if (/compression method not supported: 8(?:\D|$)/u.test(message))
		fail(
			'ZIP_COMPRESSION_UNSUPPORTED',
			'The native SDK cannot read DEFLATE ZIP entries; unsigned archives can be prepared for embedded signing, while existing credentials require a supported reader.'
		);
	if (/^C2pa\((?:UnsupportedType|UnsupportedFormat)(?:[(), ]|$)/u.test(name))
		fail(
			'FORMAT_UNSUPPORTED',
			'The native SDK does not support this asset format or operation.'
		);
	if (/^(?:RemoteManifestFetch\(|C2pa\(RemoteManifest)/u.test(name))
		fail(
			'REMOTE_FETCH_DISABLED',
			'Remote credential retrieval is disabled; supply a local manifest.'
		);
	fail(
		stage === 'read' ? 'VALIDATION_FAILED' : 'SIGNING_FAILED',
		stage === 'read'
			? 'The native SDK could not validate this asset or manifest.'
			: 'The native SDK could not sign this asset with the configured credentials.'
	);
}

async function validateAsset(
	asset: Buffer,
	mimeType: string,
	settings: string,
	roots: boolean,
	manifest?: Buffer,
	includeCrjson = false,
	validationTime?: string
): Promise<CredentialValidation> {
	try {
		const result = await readCredentialAsset(
			mimeType,
			asset,
			settings,
			manifest,
			validationTime,
			includeCrjson
		);
		const validation = normalizeCredentialValidation(result.report, roots);
		if (includeCrjson) {
			boundedReport(result.crjson);
			if (!Array.isArray(result.crjson.manifests) || !record(result.crjson.jsonGenerator))
				fail('REPORT_INVALID', 'The SDK returned malformed crJSON.');
			validation.crjson = result.crjson;
		}
		if (validationTime !== undefined) validation.validationTime = validationTime;
		return validation;
	} catch (error) {
		nativeFailure(error, 'read');
	}
}

async function writeOutput(path: string, data: Buffer): Promise<void> {
	let file: FileHandle | undefined;
	try {
		file = await open(path, 'wx', 0o600);
		await file.writeFile(data);
		await file.sync();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST')
			fail('OUTPUT_EXISTS', 'The staged credential output already exists.');
		fail('OUTPUT_WRITE_FAILED', 'The staged credential output could not be written.');
	} finally {
		await file?.close();
	}
}

async function executeAsset(
	request: CredentialAssetWorkerRequest,
	version: string
): Promise<CredentialWorkerResponse> {
	let anchors: string | undefined;
	let timestampAnchors: string | undefined;
	if (request.trustAnchorsPath) {
		const { bytes } = await readStableCredentialFile(
			request.trustAnchorsPath,
			MAX_TRUST_CONFIGURATION_BYTES,
			'Signing trust list'
		);
		try {
			anchors = parseCredentialTrustList(bytes);
		} catch {
			fail(
				'TRUST_ANCHORS_INVALID',
				'The signing trust list is invalid or exceeds its bounds.'
			);
		}
	}
	if (request.timestampTrustAnchorsPath) {
		const { bytes } = await readStableCredentialFile(
			request.timestampTrustAnchorsPath,
			MAX_TRUST_CONFIGURATION_BYTES,
			'Timestamp trust list'
		);
		try {
			timestampAnchors = parseCredentialTrustList(bytes);
		} catch {
			fail(
				'TRUST_ANCHORS_INVALID',
				'The timestamp trust list is invalid or exceeds its bounds.'
			);
		}
	}
	const settings = credentialContextSettings(anchors, timestampAnchors);
	const roots = request.trustAnchorsPath !== undefined;
	let asset = await readBounded(request.assetPath, MAX_ASSET_BYTES);
	if (request.operation === 'validate') {
		const manifest = request.manifestPath
			? await readBounded(request.manifestPath, MAX_MANIFEST_BYTES)
			: undefined;
		return {
			ok: true,
			operation: 'validate',
			sdkVersion: version,
			validation: await validateAsset(
				asset,
				request.mimeType,
				settings,
				roots,
				manifest,
				request.includeCrjson,
				request.validationTime
			),
			assetBytes: asset.length,
			...(manifest ? { manifestBytes: manifest.length } : {}),
		};
	}
	let existing: CredentialValidation | undefined;
	let repackedSource: string | undefined;
	const sourceManifest = request.sourceManifestPath
		? await readBounded(request.sourceManifestPath, MAX_MANIFEST_BYTES)
		: undefined;
	try {
		existing = await validateAsset(asset, request.mimeType, settings, roots, sourceManifest);
	} catch (error) {
		if (
			request.mode === 'embedded' &&
			error instanceof WorkerError &&
			error.code === 'ZIP_COMPRESSION_UNSUPPORTED'
		) {
			repackedSource = createHash('sha256').update(asset).digest('hex');
			try {
				asset = await prepareUnsignedCredentialArchive(asset, MAX_ASSET_BYTES);
			} catch {
				fail(
					'ARCHIVE_PREPARATION_FAILED',
					'The unsigned archive could not be prepared safely; existing credentials and unsafe or oversized entries are rejected.'
				);
			}
			existing = await validateAsset(asset, request.mimeType, settings, roots);
			if (existing.state !== 'unsigned')
				fail(
					'SOURCE_CREDENTIALS_UNVERIFIABLE',
					'Archive preparation requires an unsigned source; existing credentials must remain verifiable.'
				);
		} else if (
			request.mode !== 'sidecar' ||
			!(error instanceof WorkerError) ||
			error.code !== 'FORMAT_UNSUPPORTED'
		)
			throw error;
	}
	if (existing?.state === 'invalid' && !request.preserveInvalidSource)
		fail(
			'SOURCE_CREDENTIALS_INVALID',
			'Existing credentials are invalid; attaching another credential would obscure the failure.'
		);
	if (sourceManifest) {
		let embedded: CredentialValidation | undefined;
		try {
			embedded = await validateAsset(asset, request.mimeType, settings, roots);
		} catch (error) {
			if (!(error instanceof WorkerError) || error.code !== 'FORMAT_UNSUPPORTED') throw error;
		}
		if (embedded?.activeManifest && record(embedded.report?.manifests)) {
			const sourceHistory = existing?.report?.manifests;
			if (
				!record(sourceHistory) ||
				Object.keys(embedded.report.manifests).some(
					(id) => !Object.prototype.hasOwnProperty.call(sourceHistory, id)
				)
			)
				fail(
					'SOURCE_CREDENTIALS_CONFLICT',
					'The supplied sidecar omits embedded source history; resolve the conflicting credentials before signing.'
				);
		}
	}
	if (
		request.mode === 'embedded' &&
		existing?.state === 'unsigned' &&
		!repackedSource &&
		resolveCredentialFormat(request.mimeType).preparation === 'zip-store'
	) {
		repackedSource = createHash('sha256').update(asset).digest('hex');
		try {
			asset = await prepareUnsignedCredentialArchive(asset, MAX_ASSET_BYTES);
		} catch {
			fail(
				'ARCHIVE_PREPARATION_FAILED',
				'The unsigned archive could not be prepared safely; existing credentials and unsafe or oversized entries are rejected.'
			);
		}
	}
	try {
		const actions = repackedSource ? [{ action: 'c2pa.repackaged' }] : [];
		const assertions: Array<{
			label: string;
			created: boolean;
			data: Record<string, unknown>;
		}> = [
			{
				label: 'c2pa.actions.v2',
				created: true,
				data: { actions, allActionsIncluded: true },
			},
		];
		const definition = {
			title: request.title || 'Credential attached to existing asset',
			format: request.mimeType,
			claim_generator_info: [
				{ name: 'scrivener-mcp', version: credentialProductVersion(), specVersion: '2.4' },
			],
			assertions,
		};
		if (repackedSource) {
			assertions.push({
				label: 'com.writerslogic.input',
				created: true,
				data: {
					sha256: repackedSource,
					preparation: 'zip-store',
					preserves: 'archive entry contents',
					sourceCredentials: 'absent',
				},
			});
		}
		if (existing?.state === 'invalid') {
			assertions.push({
				label: 'com.writerslogic.source-validation',
				created: true,
				data: {
					disposition: 'invalid-source-preserved',
					state: existing.state,
					validationCodes: existing.validationCodes,
				},
			});
		}
		const signer = await signerFor(request.signer!);
		const { asset: signedAsset, manifest } = await signCredentialAssetBytes({
			mimeType: request.mimeType,
			asset,
			sourceManifest,
			definition,
			settings,
			noEmbed: request.mode === 'sidecar',
			signer,
		});
		if (
			!Buffer.isBuffer(manifest) ||
			!manifest.length ||
			manifest.length > MAX_MANIFEST_BYTES ||
			!Buffer.isBuffer(signedAsset) ||
			signedAsset.length > MAX_ASSET_BYTES + MAX_MANIFEST_BYTES
		)
			fail('OUTPUT_LIMIT', 'The native SDK output exceeds its supported bounds.');
		const validation =
			request.mode === 'sidecar'
				? await validateAsset(asset, request.mimeType, settings, roots, manifest)
				: await validateAsset(signedAsset, request.mimeType, settings, roots);
		if (
			validation.integrity !== 'valid' &&
			!(
				request.preserveInvalidSource &&
				existing?.state === 'invalid' &&
				validation.activeIntegrity === 'valid'
			)
		)
			fail(
				'OUTPUT_VALIDATION_FAILED',
				'The produced credential failed native integrity validation.'
			);
		if (
			existing?.activeManifest &&
			(!record(validation.report?.manifests) ||
				!record(validation.report.manifests[existing.activeManifest]))
		)
			fail(
				'OUTPUT_PROVENANCE_MISSING',
				'The produced credential did not preserve the existing manifest history.'
			);
		const destination =
			request.mode === 'sidecar' ? request.manifestPath! : request.destinationPath!;
		await writeOutput(destination, request.mode === 'sidecar' ? manifest : signedAsset);
		const sourceValidation = existing
			? (({ report: _report, crjson: _crjson, validationTime: _time, ...summary }) =>
					summary)(existing)
			: undefined;
		return {
			ok: true,
			operation: 'sign',
			sdkVersion: version,
			validation,
			...(sourceValidation ? { sourceValidation } : {}),
			manifestBytes: manifest.length,
			assetBytes: request.mode === 'sidecar' ? asset.length : signedAsset.length,
		};
	} catch (error) {
		nativeFailure(error, 'sign');
	}
}

export async function handleCredentialWorkerRequest(
	value: unknown
): Promise<CredentialWorkerResponse> {
	let request: CredentialWorkerRequest | undefined;
	try {
		request = validateCredentialWorkerRequest(value);
		const { version } = await loadSdk();
		if (request.operation === 'probe') {
			try {
				await probeCredentialBinding();
			} catch {
				fail('SDK_UNAVAILABLE', 'The native Content Credentials SDK could not initialize.');
			}
			return { ok: true, operation: 'probe', sdkVersion: version };
		}
		return await executeAsset(request, version);
	} catch (error) {
		if (error instanceof WorkerError)
			return { ok: false, code: error.code, message: error.message };
		return {
			ok: false,
			code: 'OPERATION_FAILED',
			message: 'The credential worker could not complete the operation.',
		};
	} finally {
		if (request?.operation === 'sign' && request.signer) request.signer.password = '';
		if (record(value) && record(value.signer)) value.signer.password = '';
	}
}

if (
	['sdk-worker.js', 'sdk-worker.ts'].includes(basename(process.argv[1] ?? '')) &&
	typeof process.send === 'function'
) {
	let received = false;
	let duplicate = false;
	process.on('message', (message: unknown) => {
		if (received) {
			duplicate = true;
			if (record(message) && record(message.signer)) message.signer.password = '';
			return;
		}
		received = true;
		void handleCredentialWorkerRequest(message)
			.then((result) => {
				const response: CredentialWorkerResponse = duplicate
					? {
							ok: false,
							code: 'PROTOCOL_INVALID',
							message: 'A credential worker accepts exactly one request.',
						}
					: result;
				if (!process.connected || !process.send) process.exit(1);
				try {
					process.send(response, (error) => {
						if (error) process.exit(1);
						if (process.connected) process.disconnect?.();
						// The published signer retains a referenced Neon channel and exposes no disposal API.
						process.exit(0);
					});
				} catch {
					process.exit(1);
				}
			})
			.catch(() => {
				process.exit(1);
			});
	});
}
