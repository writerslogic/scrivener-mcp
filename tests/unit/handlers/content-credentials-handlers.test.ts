import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { ZodError } from 'zod';
import { contentCredentialsHandlers } from '../../../src/handlers/content-credentials-handlers.js';
import type { HandlerContext, ToolDefinition } from '../../../src/handlers/types.js';
import {
	getCredentialCapabilities,
	signCredentialAsset,
	validateCredentialAsset,
} from '../../../src/services/content-credentials/service.js';
import type {
	CredentialCapabilities,
	CredentialValidation,
	SignCredentialResult,
	ValidateCredentialResult,
} from '../../../src/services/content-credentials/types.js';

jest.mock('../../../src/services/content-credentials/service.js', () => ({
	getCredentialCapabilities: jest.fn(),
	signCredentialAsset: jest.fn(),
	validateCredentialAsset: jest.fn(),
}));

const capabilities = jest.mocked(getCredentialCapabilities);
const sign = jest.mocked(signCredentialAsset);
const validate = jest.mocked(validateCredentialAsset);
const context = { project: null, memoryManager: null } as HandlerContext;
const assetPath = join(tmpdir(), 'credential-source.jpg');
const outputPath = join(tmpdir(), 'credential-output.jpg');
const revision = 'a'.repeat(64);
const report = { active_manifest: 'urn:c2pa:fixture', assertions: ['raw-report-content'] };
const validation: CredentialValidation = {
	state: 'untrusted',
	integrity: 'valid',
	trust: 'untrusted',
	trustPolicy: 'none',
	activeManifest: 'urn:c2pa:fixture',
	validationCodes: ['signingCredential.untrusted'],
	report,
};
const signed: SignCredentialResult = {
	assetPath,
	outputPath,
	mimeType: 'image/jpeg',
	mode: 'embedded',
	bytes: 1234,
	sourceRevision: revision,
	sdkVersion: 'fixture-sdk',
	validation,
};
const validated: ValidateCredentialResult = {
	...validation,
	assetPath,
	mimeType: 'image/jpeg',
	sourceRevision: revision,
	sdkVersion: 'fixture-sdk',
};
const tool = (name: string): ToolDefinition => {
	const found = contentCredentialsHandlers.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`Missing credentials handler: ${name}`);
	return found;
};

beforeEach(() => {
	jest.resetAllMocks();
});

describe('content credentials tool boundaries', () => {
	it('reports unavailable native support and unassessed conformance without an open project', async () => {
		const unavailable: CredentialCapabilities = {
			available: false,
			sdkVersion: null,
			unavailableReason: 'The native SDK is unavailable on this platform.',
			formats: [
				{
					mimeType: 'image/jpeg',
					extensions: ['jpg', 'jpeg'],
					category: 'image',
					embedded: 'supported',
					sidecar: true,
				},
			],
			modes: ['embedded', 'sidecar'],
			compressedManifests: { generation: false, validation: true },
			signerConfigured: false,
			conformance: {
				status: 'not-assessed',
				maxAssuranceLevel: null,
				implementationClass: 'edge',
				attestationMethods: [],
			},
			limits: { assetBytes: 1024, manifestBytes: 512, timeoutMs: 1000 },
		};
		capabilities.mockResolvedValue(unavailable);
		const result = await tool('c2pa_capabilities').handler({}, context);
		expect(result.structuredContent).toEqual(unavailable);
		expect(result.content[0].text).toContain('unavailable');
		expect(result.content[0].text).toContain('not assessed');
	});

	it.each([false, true])(
		'returns normalized signing evidence with includeReport=%s',
		async (includeReport) => {
			sign.mockResolvedValue(signed);
			const result = await tool('sign_content_credentials').handler(
				{ assetPath, outputPath, ...(includeReport ? { includeReport } : {}) },
				context
			);
			const { report: raw, ...summary } = validation;
			expect(result.structuredContent).toEqual({
				...signed,
				validation: includeReport ? { ...summary, report: raw } : summary,
			});
			if (!includeReport) expect(JSON.stringify(result)).not.toContain('raw-report-content');
			expect(result.content[0].text).toContain('trust: untrusted');
		}
	);

	it('preserves detached signing mode and the explicit output destination', async () => {
		const destination = join(tmpdir(), 'signed.c2pa');
		sign.mockImplementation(async (request) => ({
			...signed,
			mode: request.mode ?? 'embedded',
			outputPath: request.outputPath,
		}));
		const result = await tool('sign_content_credentials').handler(
			{ assetPath, outputPath: destination, mode: 'sidecar' },
			context
		);
		expect(result.structuredContent).toMatchObject({
			mode: 'sidecar',
			outputPath: destination,
			sourceRevision: revision,
			validation: { integrity: 'valid', trust: 'untrusted' },
		});
	});

	it.each([false, true])(
		'returns normalized detached validation with includeReport=%s',
		async (includeReport) => {
			validate.mockImplementation(async (request) => {
				if (!request.manifestPath)
					throw new Error('A detached manifest was required by this fixture.');
				return validated;
			});
			const result = await tool('validate_content_credentials').handler(
				{
					assetPath,
					manifestPath: join(tmpdir(), 'detached.c2pa'),
					...(includeReport ? { includeReport } : {}),
				},
				context
			);
			const { report: raw, ...summary } = validated;
			expect(result.structuredContent).toEqual(
				includeReport ? { ...summary, report: raw } : summary
			);
			if (!includeReport) expect(JSON.stringify(result)).not.toContain('raw-report-content');
		}
	);

	it.each([
		'certificatePath',
		'privateKeyPath',
		'password',
		'trustAnchorsPath',
		'timestampTrustAnchorsPath',
		'validationTime',
		'url',
	])('rejects caller-controlled %s without exposing its value', async (key) => {
		const secret = 'secret-value-that-must-not-appear';
		for (const [name, args] of [
			['c2pa_capabilities', {}],
			['sign_content_credentials', { assetPath, outputPath }],
			['validate_content_credentials', { assetPath }],
		] as const) {
			const error: unknown = await tool(name)
				.handler({ ...args, [key]: secret }, context)
				.catch((failure: unknown) => failure);
			expect(error).toBeInstanceOf(ZodError);
			expect(String(error)).not.toContain(secret);
		}
	});

	it.each([
		{ assetPath: 'relative.jpg', outputPath },
		{ assetPath: 'https://assets.example/source.jpg', outputPath },
		{ assetPath: `${assetPath}\0`, outputPath },
		{ assetPath, outputPath: resolve(assetPath, '..', 'credential-source.jpg') },
		{ assetPath, outputPath: 'relative-output.jpg' },
		{ assetPath, outputPath, title: 'x'.repeat(501) },
		{ assetPath, outputPath, includeReport: 'true' },
		{ assetPath, outputPath, mode: 'compressed' },
		{ assetPath, outputPath, mimeType: 'image/jpeg; charset=utf-8' },
	])('rejects invalid signing paths, controls and ranges: %j', async (args) => {
		await expect(
			tool('sign_content_credentials').handler(args, context)
		).rejects.toBeInstanceOf(ZodError);
	});

	it.each([4095, 4096])(
		'accepts a %s-character absolute path at the handler boundary',
		async (length) => {
			const root = parse(assetPath).root;
			const path = root + 'a'.repeat(length - root.length);
			sign.mockImplementation(async (request) => ({
				...signed,
				assetPath: request.assetPath,
			}));
			const result = await tool('sign_content_credentials').handler(
				{ assetPath: path, outputPath, title: 'x'.repeat(length === 4095 ? 499 : 500) },
				context
			);
			expect(result.structuredContent?.assetPath).toBe(path);
		}
	);

	it('rejects oversized asset/output paths and relative detached manifests', async () => {
		const oversized = parse(assetPath).root + 'a'.repeat(4097 - parse(assetPath).root.length);
		for (const args of [
			{ assetPath: oversized, outputPath },
			{ assetPath, outputPath: oversized },
		]) {
			await expect(
				tool('sign_content_credentials').handler(args, context)
			).rejects.toBeInstanceOf(ZodError);
		}
		await expect(
			tool('validate_content_credentials').handler(
				{ assetPath, manifestPath: 'relative.c2pa' },
				context
			)
		).rejects.toBeInstanceOf(ZodError);
	});

	it('preserves actionable safe administrator configuration errors from the domain', async () => {
		const error = new Error(
			'Content Credentials signing requires configuration by the server administrator.'
		);
		sign.mockRejectedValue(error);
		await expect(
			tool('sign_content_credentials').handler({ assetPath, outputPath }, context)
		).rejects.toBe(error);
	});
});
