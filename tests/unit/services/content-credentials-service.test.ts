import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApplicationError, ErrorCode } from '../../../src/core/errors.js';
import {
	CREDENTIAL_LIMITS,
	signCredentialAsset,
	validateCredentialAsset,
} from '../../../src/services/content-credentials/service.js';

const ENVIRONMENT = [
	'SCRIVENER_C2PA_CERT_PATH',
	'SCRIVENER_C2PA_KEY_PATH',
	'SCRIVENER_C2PA_KEY_PASSWORD',
	'SCRIVENER_C2PA_TRUST_ANCHORS_PATH',
	'TMPDIR',
	'TEMP',
	'TMP',
] as const;
const SOURCE = Buffer.from('Private manuscript content that must not appear in credential errors.');
let root: string;
let stages: string;
let assetPath: string;
let environment: Map<string, string | undefined>;

async function rejected(operation: Promise<unknown>, code: ErrorCode): Promise<ApplicationError> {
	let failure: unknown;
	try {
		await operation;
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(ApplicationError);
	expect(failure).toMatchObject({ code });
	return failure as ApplicationError;
}

async function sparseFile(file: string, length: number): Promise<void> {
	const handle = await fs.open(file, 'wx');
	try {
		await handle.truncate(length);
	} finally {
		await handle.close();
	}
}

beforeEach(async () => {
	environment = new Map(ENVIRONMENT.map((key) => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(tmpdir(), 'scrivener-credential-service-'));
	stages = path.join(root, 'private-stages');
	assetPath = path.join(root, 'private-source.png');
	await fs.mkdir(stages);
	await fs.writeFile(assetPath, SOURCE);
	for (const key of ENVIRONMENT) delete process.env[key];
	for (const key of ['TMPDIR', 'TEMP', 'TMP']) process.env[key] = stages;
});

afterEach(async () => {
	for (const [key, value] of environment) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await fs.rm(root, { recursive: true, force: true });
});

test.each(['asset', 'output', 'manifest'] as const)(
	'rejects nonabsolute, null and null-byte %s paths before creating staging files',
	async (field) => {
		for (const value of ['', 'relative.png', null, path.join(root, 'private\0source.png')]) {
			const invalid = value as unknown as string;
			const operation = field === 'asset'
				? validateCredentialAsset({ assetPath: invalid, mimeType: 'image/png' })
				: field === 'manifest'
					? validateCredentialAsset({ assetPath, manifestPath: invalid })
					: signCredentialAsset({ assetPath, outputPath: invalid });
			await rejected(operation, ErrorCode.PATH_INVALID);
		}
		expect(await fs.readdir(stages)).toEqual([]);
		expect(await fs.readFile(assetPath)).toEqual(SOURCE);
	}
);

test('rejects equivalent source/output paths and incompatible formats without modifying the source', async () => {
	await rejected(signCredentialAsset({
		assetPath,
		outputPath: path.join(root, 'unused', '..', path.basename(assetPath)),
	}), ErrorCode.INVALID_INPUT);
	await expect(signCredentialAsset({ assetPath, outputPath: path.join(root, 'output.jpg'), mimeType: 'image/jpeg' }))
		.rejects.toThrow(/MIME type conflicts with the file extension/);
	await rejected(signCredentialAsset({ assetPath, outputPath: path.join(root, 'output.jpg') }), ErrorCode.INVALID_FORMAT);
	await rejected(signCredentialAsset({ assetPath, outputPath: path.join(root, 'output.png'), mode: 'sidecar' }), ErrorCode.INVALID_INPUT);
	expect(await fs.readFile(assetPath)).toEqual(SOURCE);
	expect((await fs.readdir(root)).sort()).toEqual(['private-source.png', 'private-stages']);
});

test('requires complete administrator signing configuration without discovering keys or disclosing values', async () => {
	const outputPath = path.join(root, 'output.png');
	await rejected(signCredentialAsset({ assetPath, outputPath }), ErrorCode.CONFIGURATION_ERROR);
	const password = 'private-test-password-must-not-appear';
	process.env.SCRIVENER_C2PA_KEY_PASSWORD = password;
	const error = await rejected(signCredentialAsset({ assetPath, outputPath }), ErrorCode.CONFIGURATION_ERROR);
	expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain(password);
	expect(await fs.readFile(assetPath)).toEqual(SOURCE);
	await expect(fs.lstat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
	expect(await fs.readdir(stages)).toEqual([]);
});

test('protects Scrivener internals while permitting the dedicated export directory', async () => {
	const project = path.join(root, 'Story.SCRIV');
	const manuscript = path.join(project, 'Files', 'Data', 'scene.png');
	await fs.mkdir(path.dirname(manuscript), { recursive: true });
	await fs.writeFile(manuscript, SOURCE);
	for (const relative of [
		'scene.png',
		path.join('Files', 'Data', 'scene.png'),
		path.join('Snapshots', 'scene.png'),
		path.join('exports', 'scene.png'),
		path.join('.scrivener-mcp', 'exports-hidden', 'scene.png'),
		path.join('.scrivener-mcp', 'exports', '..', 'scene.png'),
	]) {
		await rejected(signCredentialAsset({ assetPath, outputPath: path.join(project, relative) }), ErrorCode.PATH_INVALID);
	}
	await rejected(signCredentialAsset({
		assetPath,
		outputPath: path.join(project, '.scrivener-mcp', 'exports', 'signed.png'),
	}), ErrorCode.CONFIGURATION_ERROR);
	expect(await fs.readFile(manuscript)).toEqual(SOURCE);
	expect(await fs.readdir(stages)).toEqual([]);
});

test('rejects symlinked output ancestors that lead into manuscript internals, including missing descendants', async () => {
	const project = path.join(root, 'Story.scriv');
	const internal = path.join(project, 'Files', 'Data');
	const exports = path.join(project, '.scrivener-mcp', 'exports');
	await fs.mkdir(internal, { recursive: true });
	await fs.mkdir(exports, { recursive: true });
	const alias = path.join(root, 'output-alias');
	const allowed = path.join(root, 'export-alias');
	await fs.symlink(internal, alias, 'junction');
	await fs.symlink(exports, allowed, 'junction');
	for (const suffix of ['signed.png', path.join('missing', 'deeper', 'signed.png')]) {
		await rejected(signCredentialAsset({ assetPath, outputPath: path.join(alias, suffix) }), ErrorCode.PATH_INVALID);
	}
	await rejected(signCredentialAsset({ assetPath, outputPath: path.join(allowed, 'signed.png') }), ErrorCode.CONFIGURATION_ERROR);
	expect(await fs.readdir(internal)).toEqual([]);
	expect(await fs.readdir(exports)).toEqual([]);
	expect(await fs.readdir(stages)).toEqual([]);
});

test('rejects empty, nonregular, missing and oversized sources with private staging fully removed', async () => {
	const empty = path.join(root, 'empty.png');
	const directory = path.join(root, 'directory.png');
	const oversized = path.join(root, 'oversized.png');
	await fs.writeFile(empty, '');
	await fs.mkdir(directory);
	await sparseFile(oversized, CREDENTIAL_LIMITS.assetBytes + 1);
	for (const [file, code] of [
		[empty, ErrorCode.INVALID_FORMAT],
		[directory, ErrorCode.INVALID_FORMAT],
		[path.join(root, 'missing-private-name.png'), ErrorCode.IO_ERROR],
		[oversized, ErrorCode.DOCUMENT_TOO_LARGE],
	] as const) {
		const error = await rejected(validateCredentialAsset({ assetPath: file }), code);
		const returned = JSON.stringify({ message: error.message, code: error.code, details: error.details });
		expect(returned).not.toContain(root);
		expect(returned).not.toContain(SOURCE.toString());
		expect(await fs.readdir(stages)).toEqual([]);
	}
	expect((await fs.stat(oversized)).size).toBe(CREDENTIAL_LIMITS.assetBytes + 1);
});

const fileSymlinkTest = process.platform === 'win32' ? test.skip : test;
fileSymlinkTest('rejects a symbolic link to a regular source without reading or altering its target', async () => {
	const alias = path.join(root, 'source-alias.png');
	await fs.symlink(assetPath, alias, 'file');
	await rejected(validateCredentialAsset({ assetPath: alias }), ErrorCode.INVALID_FORMAT);
	expect(await fs.readFile(assetPath)).toEqual(SOURCE);
	expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
	expect(await fs.readdir(stages)).toEqual([]);
});

test('removes a copied source when a detached manifest fails filesystem validation and redacts returned errors', async () => {
	const manifestPath = path.join(root, 'private-manifest.c2pa');
	await sparseFile(manifestPath, CREDENTIAL_LIMITS.manifestBytes + 1);
	const error = await rejected(validateCredentialAsset({ assetPath, manifestPath }), ErrorCode.DOCUMENT_TOO_LARGE);
	expect(error.message).toMatch(/manifest exceeds/i);
	expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain(root);
	expect(JSON.stringify(error)).not.toContain(SOURCE.toString());
	expect(await fs.readFile(assetPath)).toEqual(SOURCE);
	expect((await fs.stat(manifestPath)).size).toBe(CREDENTIAL_LIMITS.manifestBytes + 1);
	expect(await fs.readdir(stages)).toEqual([]);
});
