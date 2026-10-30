#!/usr/bin/env node
import { generateKeyPair, createHash, createPublicKey } from 'node:crypto';
import { isAbsolute, resolve, sep } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { validateCredentialAsset } from '../services/content-credentials/service.js';
import {
	readStableCredentialFile,
	writeExclusiveCredentialFile,
} from '../services/content-credentials/local-files.js';
import {
	CREDENTIAL_LIMITS,
	MAX_CONFIGURATION_BYTES,
} from '../services/content-credentials/limits.js';
import {
	encryptCredentialSigningKey,
	inspectEncryptedCredentialKey,
	reencryptCredentialSigningKey,
} from '../services/content-credentials/key-policy.js';
import { ApplicationError } from '../core/errors.js';

const generate = promisify(generateKeyPair);

function local(value: unknown): string {
	if (
		typeof value !== 'string' ||
		!isAbsolute(value) ||
		value.length > 4096 ||
		value.includes('\0')
	)
		throw new Error('Use an absolute local path without NUL characters.');
	return resolve(value);
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		strict: true,
		options: {
			asset: { type: 'string' },
			manifest: { type: 'string' },
			mime: { type: 'string' },
			'trust-list': { type: 'string' },
			'tsa-trust-list': { type: 'string' },
			time: { type: 'string' },
			out: { type: 'string' },
			key: { type: 'string' },
			help: { type: 'boolean' },
		},
	});
	if (values.help) {
		process.stdout.write(
			'scrivener-c2pa validate --asset ABS --trust-list ABS --tsa-trust-list ABS --time RFC3339 [--manifest ABS] [--mime MIME] [--out ABS]\nscrivener-c2pa keygen --out ABS (password from SCRIVENER_C2PA_KEY_PASSWORD)\nscrivener-c2pa inspect-key --key ABS\nscrivener-c2pa reencrypt-key --key ABS --out ABS (old/new passwords from SCRIVENER_C2PA_OLD_KEY_PASSWORD / SCRIVENER_C2PA_KEY_PASSWORD)\n'
		);
		return;
	}
	if (positionals.length !== 1)
		throw new Error('Select validate, keygen, inspect-key or reencrypt-key.');
	const command = positionals[0];
	if (command === 'validate') {
		if (typeof values.time !== 'string' || values.key !== undefined)
			throw new Error('Validation requires both trust lists and an RFC 3339 time.');
		const result = await validateCredentialAsset(
			{
				assetPath: local(values.asset),
				...(values.manifest ? { manifestPath: local(values.manifest) } : {}),
				...(values.mime ? { mimeType: values.mime } : {}),
				includeCrjson: true,
			},
			{
				trustAnchorsPath: local(values['trust-list']),
				timestampTrustAnchorsPath: local(values['tsa-trust-list']),
				validationTime: values.time,
			}
		);
		if (!result.crjson) throw new Error('The product did not return crJSON.');
		const bytes = Buffer.from(`${JSON.stringify(result.crjson, null, 2)}\n`);
		if (bytes.length > CREDENTIAL_LIMITS.manifestBytes)
			throw new Error('The crJSON report exceeds its supported bounds.');
		if (values.out) await writeExclusiveCredentialFile(local(values.out), bytes);
		else process.stdout.write(bytes);
		return;
	}
	if (command === 'inspect-key') {
		if (Object.keys(values).some((key) => key !== 'key'))
			throw new Error('inspect-key accepts only --key.');
		const { bytes } = await readStableCredentialFile(
			local(values.key),
			MAX_CONFIGURATION_BYTES,
			'Signing key',
			{ privateKey: true }
		);
		try {
			process.stdout.write(
				`${JSON.stringify({ profile: inspectEncryptedCredentialKey(bytes), access: 'restricted', passwordChecked: false, conformance: 'not-assessed' })}\n`
			);
		} finally {
			bytes.fill(0);
		}
		return;
	}
	if (command === 'keygen') {
		if (Object.keys(values).some((key) => key !== 'out'))
			throw new Error('keygen accepts only --out.');
		const out = local(values.out);
		if (out.split(sep).some((part) => part.toLowerCase().endsWith('.scriv')))
			throw new Error('Do not store signing keys inside manuscripts.');
		const password = process.env.SCRIVENER_C2PA_KEY_PASSWORD;
		if (!password)
			throw new Error(
				'Configure a private SCRIVENER_C2PA_KEY_PASSWORD of at least 16 bytes.'
			);
		const { privateKey } = await generate('ec', { namedCurve: 'prime256v1' });
		const encrypted = await encryptCredentialSigningKey(privateKey, password);
		try {
			const profile = inspectEncryptedCredentialKey(encrypted);
			await writeExclusiveCredentialFile(out, encrypted, { allowProjectExports: false });
			const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
			process.stdout.write(
				`${JSON.stringify({ created: true, publicKeySha256: createHash('sha256').update(publicKey).digest('hex'), profile, conformance: 'not-assessed' })}\n`
			);
		} finally {
			encrypted.fill(0);
		}
		return;
	}
	if (command === 'reencrypt-key') {
		if (Object.keys(values).some((key) => !['key', 'out'].includes(key)))
			throw new Error('reencrypt-key accepts only --key and --out.');
		const oldPassword = process.env.SCRIVENER_C2PA_OLD_KEY_PASSWORD;
		const newPassword = process.env.SCRIVENER_C2PA_KEY_PASSWORD;
		if (!oldPassword || !newPassword)
			throw new Error('Configure both old and new key passwords privately.');
		const out = local(values.out);
		const { bytes } = await readStableCredentialFile(
			local(values.key),
			MAX_CONFIGURATION_BYTES,
			'Old signing key',
			{ privateKey: true }
		);
		const result = await reencryptCredentialSigningKey(bytes, oldPassword, newPassword);
		try {
			await writeExclusiveCredentialFile(out, result.encrypted, {
				allowProjectExports: false,
			});
			process.stdout.write(
				`${JSON.stringify({ created: true, keyIdentityPreserved: true, publicKeySha256: result.publicKeySha256, profile: inspectEncryptedCredentialKey(result.encrypted) })}\n`
			);
		} finally {
			result.encrypted.fill(0);
		}
		return;
	}
	throw new Error('Select validate, keygen, inspect-key or reencrypt-key.');
}

void main().catch((error: unknown) => {
	const code = error instanceof ApplicationError ? error.code : 'C2PA_COMMAND_FAILED';
	const message =
		error instanceof ApplicationError
			? error.message
			: 'C2PA command failed; run --help and check private key policy, absolute paths and input limits. No key material or manuscript content is included.';
	process.stderr.write(`${JSON.stringify({ ok: false, code, message })}\n`);
	process.exitCode = 1;
});
