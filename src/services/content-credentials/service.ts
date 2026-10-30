import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createError, ErrorCode } from '../../core/errors.js';
import { CREDENTIAL_FORMATS, resolveCredentialFormat } from './formats.js';
import { CREDENTIAL_LIMITS } from './limits.js';
import {
	readStableCredentialFile as readStableFile,
	assertCredentialFileUnchanged as assertUnchanged,
	writeExclusiveCredentialFile,
	protectCredentialOutputPath as protectManuscriptOutput,
	canonicalCredentialOutputPath as canonicalOutputPath,
} from './local-files.js';
import { credentialWorkerPath } from './worker-path.cjs';
import { makeCredentialDirectoryPrivate } from './key-access.js';
import type {
	CredentialCapabilities,
	CredentialAssessmentPolicy,
	CredentialSignerConfiguration,
	CredentialWorkerRequest,
	CredentialWorkerResponse,
	SignCredentialRequest,
	SignCredentialResult,
	ValidateCredentialRequest,
	ValidateCredentialResult,
} from './types.js';

export { CREDENTIAL_LIMITS } from './limits.js';
const MAX_WORKERS = 2;
let activeWorkers = 0;
let activeOperations = 0;
let nativeProbe: Promise<{ sdkVersion: string }> | undefined;

const validationSchema = z.object({
	state: z.enum(['valid', 'invalid', 'unsigned', 'untrusted']),
	integrity: z.enum(['valid', 'invalid', 'not-evaluated']),
	trust: z.enum(['trusted', 'untrusted', 'not-evaluated']),
	trustPolicy: z.enum(['configured-roots', 'none']),
	activeManifest: z.string().max(4096).optional(),
	validationCodes: z.array(z.string().max(256)).max(1024),
	sourceValidationCodes: z.array(z.string().max(128)).max(1024).optional(),
	report: z.record(z.string(), z.unknown()).nullable(),
	crjson: z.record(z.string(), z.unknown()).optional(),
	validationTime: z.string().max(64).optional(),
	activeIntegrity: z.enum(['valid', 'invalid', 'not-evaluated']).optional(),
});
const responseSchema = z.union([
	z
		.object({
			ok: z.literal(true),
			operation: z.literal('probe'),
			sdkVersion: z.string().max(64),
		})
		.strict(),
	z
		.object({
			ok: z.literal(true),
			operation: z.enum(['sign', 'validate']),
			sdkVersion: z.string().max(64),
			validation: validationSchema,
			sourceValidation: validationSchema
				.omit({ report: true, crjson: true, validationTime: true })
				.optional(),
			manifestBytes: z
				.number()
				.int()
				.nonnegative()
				.max(CREDENTIAL_LIMITS.manifestBytes)
				.optional(),
			assetBytes: z
				.number()
				.int()
				.nonnegative()
				.max(CREDENTIAL_LIMITS.assetBytes + CREDENTIAL_LIMITS.manifestBytes)
				.optional(),
		})
		.strict(),
	z
		.object({
			ok: z.literal(false),
			code: z.string().regex(/^[A-Z0-9_]{1,64}$/),
			message: z.string().max(500),
		})
		.strict(),
]);

function absolutePath(value: unknown, field: string): string {
	if (
		typeof value !== 'string' ||
		!value ||
		value.length > 4096 ||
		value.includes('\0') ||
		!path.isAbsolute(value)
	)
		throw createError(
			ErrorCode.PATH_INVALID,
			{ field },
			`${field} must be an absolute path of at most 4096 characters`
		);
	return path.resolve(value);
}

function errorCode(error: unknown): string | undefined {
	return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
		? error.code
		: undefined;
}

function adminSigner(): CredentialSignerConfiguration | undefined {
	const certificatePath = process.env.SCRIVENER_C2PA_CERT_PATH;
	const privateKeyPath = process.env.SCRIVENER_C2PA_KEY_PATH;
	const password = process.env.SCRIVENER_C2PA_KEY_PASSWORD;
	if (!certificatePath && !privateKeyPath && !password) return undefined;
	if (!certificatePath || !privateKeyPath || !password || Buffer.byteLength(password) > 4096)
		throw createError(
			ErrorCode.CONFIGURATION_ERROR,
			undefined,
			'Configure SCRIVENER_C2PA_CERT_PATH, SCRIVENER_C2PA_KEY_PATH and SCRIVENER_C2PA_KEY_PASSWORD together; signing requires an encrypted private key'
		);
	return {
		certificatePath: absolutePath(certificatePath, 'Signing certificate'),
		privateKeyPath: absolutePath(privateKeyPath, 'Encrypted signing key'),
		password,
	};
}

function adminTrustAnchors(): string | undefined {
	const value = process.env.SCRIVENER_C2PA_TRUST_ANCHORS_PATH;
	return value ? absolutePath(value, 'Trust anchors') : undefined;
}

function adminTimestampTrustAnchors(): string | undefined {
	const value = process.env.SCRIVENER_C2PA_TSA_TRUST_ANCHORS_PATH;
	return value ? absolutePath(value, 'Timestamp trust anchors') : undefined;
}

function invokeWorker(
	request: CredentialWorkerRequest,
	cwd: string
): Promise<CredentialWorkerResponse> {
	if (activeWorkers >= MAX_WORKERS)
		return Promise.reject(
			createError(
				ErrorCode.RESOURCE_EXHAUSTED,
				undefined,
				'Content credential workers are busy; retry after the current operation'
			)
		);
	activeWorkers++;
	return new Promise((resolve, reject) => {
		const env: NodeJS.ProcessEnv = {};
		for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP'])
			if (process.env[key]) env[key] = process.env[key];
		let response: CredentialWorkerResponse | undefined;
		let failure: Error | undefined;
		let child: ReturnType<typeof fork>;
		try {
			child = fork(credentialWorkerPath(), [], {
				cwd,
				env,
				execArgv: ['--max-old-space-size=256'],
				stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
				serialization: 'json',
				windowsHide: true,
			});
		} catch {
			activeWorkers--;
			reject(
				createError(
					ErrorCode.DEPENDENCY_ERROR,
					undefined,
					'Content credential worker could not start'
				)
			);
			return;
		}
		const timeout = setTimeout(() => {
			failure = createError(
				ErrorCode.TIMEOUT,
				undefined,
				'Content credential processing exceeded its time limit'
			);
			child.kill('SIGKILL');
		}, CREDENTIAL_LIMITS.timeoutMs);
		child.on('message', (value: unknown) => {
			if (response) {
				failure = createError(
					ErrorCode.DEPENDENCY_ERROR,
					undefined,
					'Content credential worker returned multiple responses'
				);
				child.kill('SIGKILL');
				return;
			}
			try {
				if (
					Buffer.byteLength(JSON.stringify(value)) >
					CREDENTIAL_LIMITS.manifestBytes * 2 + 256 * 1024
				)
					throw new Error('Oversized worker response');
				response = responseSchema.parse(value);
			} catch {
				failure = createError(
					ErrorCode.DEPENDENCY_ERROR,
					undefined,
					'Content credential worker returned an invalid response'
				);
				child.kill('SIGKILL');
			}
		});
		child.once('error', () => {
			failure = createError(
				ErrorCode.DEPENDENCY_ERROR,
				undefined,
				'Content credential worker could not start'
			);
		});
		child.once('close', (code) => {
			clearTimeout(timeout);
			activeWorkers--;
			if (failure) reject(failure);
			else if (code !== 0 || !response)
				reject(
					createError(
						ErrorCode.DEPENDENCY_ERROR,
						undefined,
						'Content credential native processing failed'
					)
				);
			else if (!response.ok)
				reject(
					createError(
						ErrorCode.OPERATION_FAILED,
						{ code: response.code },
						response.message
					)
				);
			else resolve(response);
		});
		const communicationFailed = (): void => {
			failure = createError(
				ErrorCode.DEPENDENCY_ERROR,
				undefined,
				'Content credential worker communication failed'
			);
			child.kill('SIGKILL');
		};
		try {
			child.send(request, (error) => {
				if (error) communicationFailed();
			});
		} catch {
			communicationFailed();
		}
	});
}

async function withStage<T>(operation: (directory: string) => Promise<T>): Promise<T> {
	if (activeOperations >= MAX_WORKERS)
		throw createError(
			ErrorCode.RESOURCE_EXHAUSTED,
			undefined,
			'Content credential operations are busy; retry after the current operation'
		);
	activeOperations++;
	let directory: string | undefined;
	let outcome: { value: T } | { error: unknown };
	try {
		directory = await mkdtemp(path.join(tmpdir(), 'scrivener-credentials-'));
		await chmod(directory, 0o700);
		await makeCredentialDirectoryPrivate(directory);
		outcome = { value: await operation(directory) };
	} catch (error) {
		const expected =
			error &&
			typeof error === 'object' &&
			'code' in error &&
			typeof error.code === 'string' &&
			Object.values(ErrorCode).includes(error.code as ErrorCode);
		outcome = {
			error: expected
				? error
				: createError(
						ErrorCode.IO_ERROR,
						{ code: errorCode(error) },
						'Content credential file operation failed; check permissions and configured paths'
					),
		};
	}
	try {
		if (directory) await rm(directory, { recursive: true, force: true });
	} catch {
		outcome = {
			error: createError(
				ErrorCode.IO_ERROR,
				{ operationCode: 'error' in outcome ? errorCode(outcome.error) : undefined },
				'Private credential staging files could not be removed; inspect any completed output before retrying'
			),
		};
	} finally {
		activeOperations--;
	}
	if ('error' in outcome) throw outcome.error;
	return outcome.value;
}

async function probeNative(): Promise<{ sdkVersion: string }> {
	if (!nativeProbe) {
		nativeProbe = withStage(async (directory) => {
			const response = await invokeWorker({ operation: 'probe' }, directory);
			if (!response.ok || response.operation !== 'probe')
				throw createError(
					ErrorCode.DEPENDENCY_ERROR,
					undefined,
					'Unexpected content credential SDK response'
				);
			return { sdkVersion: response.sdkVersion };
		});
		nativeProbe.catch(() => {
			nativeProbe = undefined;
		});
	}
	return nativeProbe;
}

export async function getCredentialCapabilities(): Promise<CredentialCapabilities> {
	let sdkVersion: string | null = null;
	let unavailableReason: string | undefined;
	try {
		sdkVersion = (await probeNative()).sdkVersion;
	} catch (error) {
		if (
			[ErrorCode.RESOURCE_EXHAUSTED, ErrorCode.IO_ERROR].includes(
				errorCode(error) as ErrorCode
			)
		)
			throw error;
		unavailableReason = 'The native C2PA SDK is unavailable for this installation';
	}
	return {
		available: sdkVersion !== null,
		sdkVersion,
		...(unavailableReason ? { unavailableReason } : {}),
		formats: sdkVersion ? CREDENTIAL_FORMATS : [],
		modes: sdkVersion ? ['embedded', 'sidecar'] : [],
		compressedManifests: { generation: false, validation: sdkVersion !== null },
		signerConfigured: adminSigner() !== undefined,
		conformance: {
			status: 'not-assessed',
			maxAssuranceLevel: null,
			implementationClass: 'edge',
			attestationMethods: [],
		},
		limits: CREDENTIAL_LIMITS,
	};
}

async function snapshotAsset(
	assetPath: string,
	directory: string
): Promise<{ staged: string; revision: string; identity: string }> {
	const { bytes, identity } = await readStableFile(
		assetPath,
		CREDENTIAL_LIMITS.assetBytes,
		'Asset'
	);
	if (!bytes.length)
		throw createError(ErrorCode.INVALID_FORMAT, undefined, 'Asset must not be empty');
	const staged = path.join(directory, `source${path.extname(assetPath)}`);
	const revision = createHash('sha256').update(bytes).digest('hex');
	await writeFile(staged, bytes, { flag: 'wx', mode: 0o600 });
	return { staged, revision, identity };
}

export async function validateCredentialAsset(
	input: ValidateCredentialRequest,
	assessment?: CredentialAssessmentPolicy
): Promise<ValidateCredentialResult> {
	const assetPath = absolutePath(input.assetPath, 'Asset path');
	const format = resolveCredentialFormat(input.mimeType, assetPath);
	if (format.mimeType === 'application/x-c2pa-manifest-store')
		throw createError(
			ErrorCode.INVALID_INPUT,
			undefined,
			'Validate an asset with its manifestPath; a standalone manifest cannot prove asset integrity'
		);
	const manifestPath =
		input.manifestPath !== undefined
			? absolutePath(input.manifestPath, 'Manifest path')
			: undefined;
	if (input.includeCrjson !== undefined && typeof input.includeCrjson !== 'boolean')
		throw createError(ErrorCode.INVALID_INPUT, undefined, 'includeCrjson must be a boolean');
	if (
		assessment !== undefined &&
		(!assessment ||
			typeof assessment.validationTime !== 'string' ||
			assessment.validationTime.length > 64 ||
			!/^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/u.test(
				assessment.validationTime
			))
	)
		throw createError(ErrorCode.INVALID_INPUT, undefined, 'Use an RFC 3339 assessment time');
	const trustAnchorsPath = assessment
		? absolutePath(assessment.trustAnchorsPath, 'Assessment signing trust list')
		: adminTrustAnchors();
	const timestampTrustAnchorsPath = assessment
		? absolutePath(assessment.timestampTrustAnchorsPath, 'Assessment timestamp trust list')
		: adminTimestampTrustAnchors();
	return withStage(async (directory) => {
		const { staged, revision, identity } = await snapshotAsset(assetPath, directory);
		let stagedManifest: string | undefined;
		let manifestIdentity: string | undefined;
		if (manifestPath) {
			stagedManifest = path.join(directory, 'manifest.c2pa');
			const snapshot = await readStableFile(
				manifestPath,
				CREDENTIAL_LIMITS.manifestBytes,
				'Manifest'
			);
			manifestIdentity = snapshot.identity;
			await writeFile(stagedManifest, snapshot.bytes, { flag: 'wx', mode: 0o600 });
		}
		const response = await invokeWorker(
			{
				operation: 'validate',
				assetPath: staged,
				mimeType: format.mimeType,
				mode: manifestPath ? 'sidecar' : 'embedded',
				manifestPath: stagedManifest,
				trustAnchorsPath,
				timestampTrustAnchorsPath,
				includeCrjson: input.includeCrjson === true || assessment !== undefined,
				...(assessment ? { validationTime: assessment.validationTime } : {}),
			},
			directory
		);
		if (!response.ok || response.operation !== 'validate')
			throw createError(
				ErrorCode.DEPENDENCY_ERROR,
				undefined,
				'Unexpected validation response'
			);
		await assertUnchanged(assetPath, identity);
		if (manifestPath && manifestIdentity) await assertUnchanged(manifestPath, manifestIdentity);
		return {
			...response.validation,
			assetPath,
			mimeType: format.mimeType,
			sourceRevision: revision,
			sdkVersion: response.sdkVersion,
		};
	});
}

export async function signCredentialAsset(
	input: SignCredentialRequest
): Promise<SignCredentialResult> {
	const assetPath = absolutePath(input.assetPath, 'Asset path');
	const outputPath = absolutePath(input.outputPath, 'Output path');
	const sourceManifestPath =
		input.sourceManifestPath === undefined
			? undefined
			: absolutePath(input.sourceManifestPath, 'Source manifest path');
	if (
		input.preserveInvalidSource !== undefined &&
		typeof input.preserveInvalidSource !== 'boolean'
	)
		throw createError(
			ErrorCode.INVALID_INPUT,
			undefined,
			'preserveInvalidSource must be a boolean'
		);
	const mode = input.mode === undefined ? 'embedded' : input.mode;
	if (
		!['embedded', 'sidecar'].includes(mode) ||
		assetPath === outputPath ||
		sourceManifestPath === outputPath
	)
		throw createError(
			ErrorCode.INVALID_INPUT,
			undefined,
			'Select embedded or sidecar credentials and a distinct output path'
		);
	if (
		input.title !== undefined &&
		(typeof input.title !== 'string' || input.title.length > 500 || input.title.includes('\0'))
	)
		throw createError(
			ErrorCode.INVALID_INPUT,
			undefined,
			'Title must contain at most 500 characters without null bytes'
		);
	const format = resolveCredentialFormat(input.mimeType, assetPath);
	if (mode === 'embedded' && format.embedded !== 'supported')
		throw createError(
			ErrorCode.UNSUPPORTED_OPERATION,
			undefined,
			'Embedded credentials are not supported for this format; use a supported detached sidecar'
		);
	if (mode === 'sidecar' && !format.sidecar)
		throw createError(
			ErrorCode.UNSUPPORTED_OPERATION,
			undefined,
			'Detached credentials are not supported for this format'
		);
	if (mode === 'sidecar' && path.extname(outputPath).toLowerCase() !== '.c2pa')
		throw createError(
			ErrorCode.INVALID_INPUT,
			undefined,
			'Detached output must use the .c2pa extension'
		);
	if (
		mode === 'embedded' &&
		!format.extensions.includes(path.extname(outputPath).toLowerCase().slice(1))
	)
		throw createError(
			ErrorCode.INVALID_FORMAT,
			undefined,
			'Embedded output extension must match the selected asset format'
		);
	protectManuscriptOutput(outputPath);
	protectManuscriptOutput(await canonicalOutputPath(outputPath));
	const signer = adminSigner();
	if (!signer)
		throw createError(
			ErrorCode.CONFIGURATION_ERROR,
			undefined,
			'Signing requires administrator-configured SCRIVENER_C2PA_CERT_PATH, SCRIVENER_C2PA_KEY_PATH and SCRIVENER_C2PA_KEY_PASSWORD'
		);
	const trustAnchorsPath = adminTrustAnchors();
	const timestampTrustAnchorsPath = adminTimestampTrustAnchors();
	return withStage(async (directory) => {
		const { staged, revision, identity } = await snapshotAsset(assetPath, directory);
		let stagedSourceManifest: string | undefined;
		let sourceManifestIdentity: string | undefined;
		let sourceManifestRevision: string | undefined;
		if (sourceManifestPath) {
			const snapshot = await readStableFile(
				sourceManifestPath,
				CREDENTIAL_LIMITS.manifestBytes,
				'Source manifest'
			);
			stagedSourceManifest = path.join(directory, 'source.c2pa');
			sourceManifestIdentity = snapshot.identity;
			sourceManifestRevision = createHash('sha256').update(snapshot.bytes).digest('hex');
			await writeFile(stagedSourceManifest, snapshot.bytes, { flag: 'wx', mode: 0o600 });
		}
		const destinationPath = path.join(directory, `signed${path.extname(assetPath)}`);
		const manifestPath = path.join(directory, 'signed.c2pa');
		const response = await invokeWorker(
			{
				operation: 'sign',
				assetPath: staged,
				mimeType: format.mimeType,
				mode,
				...(mode === 'sidecar' ? { manifestPath } : { destinationPath }),
				title: input.title,
				signer,
				trustAnchorsPath,
				timestampTrustAnchorsPath,
				...(stagedSourceManifest ? { sourceManifestPath: stagedSourceManifest } : {}),
				preserveInvalidSource: input.preserveInvalidSource === true,
			},
			directory
		);
		if (
			!response.ok ||
			response.operation !== 'sign' ||
			(response.validation.integrity !== 'valid' &&
				!(
					input.preserveInvalidSource === true &&
					response.validation.activeIntegrity === 'valid' &&
					response.sourceValidation?.state === 'invalid'
				))
		)
			throw createError(
				ErrorCode.VALIDATION_FAILED,
				undefined,
				'Generated content credentials failed integrity verification'
			);
		const { bytes } = await readStableFile(
			mode === 'sidecar' ? manifestPath : destinationPath,
			mode === 'sidecar'
				? CREDENTIAL_LIMITS.manifestBytes
				: CREDENTIAL_LIMITS.assetBytes + CREDENTIAL_LIMITS.manifestBytes,
			'Signed output'
		);
		await assertUnchanged(assetPath, identity);
		if (sourceManifestPath && sourceManifestIdentity)
			await assertUnchanged(sourceManifestPath, sourceManifestIdentity);
		await mkdir(path.dirname(outputPath), { recursive: true });
		const parent = await realpath(path.dirname(outputPath));
		protectManuscriptOutput(path.join(parent, path.basename(outputPath)));
		await writeExclusiveCredentialFile(path.join(parent, path.basename(outputPath)), bytes);
		return {
			assetPath,
			outputPath,
			mimeType: format.mimeType,
			mode,
			bytes: bytes.length,
			sourceRevision: revision,
			...(sourceManifestRevision ? { sourceManifestRevision } : {}),
			sdkVersion: response.sdkVersion,
			validation: response.validation,
			...(response.sourceValidation ? { sourceValidation: response.sourceValidation } : {}),
		};
	});
}
