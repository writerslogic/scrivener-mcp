import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { fromBER, Integer, ObjectIdentifier, OctetString, Sequence } from 'asn1js';
import {
	encryptCredentialSigningKey,
	inspectEncryptedCredentialKey,
	reencryptCredentialSigningKey,
} from '../../../src/services/content-credentials/key-policy.js';

const password = 'private-fixture-password-only';
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
let encrypted: Buffer;

beforeAll(async () => {
	encrypted = await encryptCredentialSigningKey(pair.privateKey, password);
});

function modified(change: (parameters: Sequence) => void): Buffer {
	const der = Buffer.from(encrypted.toString().replace(/-----[^\n]+-----|\s/gu, ''), 'base64');
	const parsed = fromBER(der, { parseEmbedded: false }).result as Sequence;
	const encryption = parsed.valueBlock.value[0] as Sequence;
	const parameters = encryption.valueBlock.value[1] as Sequence;
	change(parameters);
	return Buffer.from(
		`-----BEGIN ENCRYPTED PRIVATE KEY-----\n${Buffer.from(parsed.toBER(false)).toString('base64')}\n-----END ENCRYPTED PRIVATE KEY-----\n`
	);
}

it('creates a profile that Node independently decrypts to the original signing identity', () => {
	const restored = createPrivateKey({
		key: encrypted,
		format: 'pem',
		type: 'pkcs8',
		passphrase: password,
	});
	expect(createPublicKey(restored).equals(pair.publicKey)).toBe(true);
	expect(inspectEncryptedCredentialKey(encrypted)).toMatchObject({
		cipher: 'aes-256-cbc',
		kdf: 'pbkdf2-sha256',
		iterations: 600000,
		saltBytes: 16,
	});
});

it.each([
	[599999, false],
	[600000, true],
	[600001, true],
	[1999999, true],
	[2000000, true],
	[2000001, false],
])('enforces the PBKDF2 cost boundary at %i', (iterations, accepted) => {
	const bytes = modified((parameters) => {
		const kdf = parameters.valueBlock.value[0] as Sequence;
		const derivation = kdf.valueBlock.value[1] as Sequence;
		derivation.valueBlock.value[1] = new Integer({ value: iterations as number });
	});
	if (accepted) expect(inspectEncryptedCredentialKey(bytes).iterations).toBe(iterations);
	else expect(() => inspectEncryptedCredentialKey(bytes)).toThrow('SIGNER_KEY_POLICY');
});

it.each([
	[15, false],
	[16, true],
	[17, true],
	[63, true],
	[64, true],
	[65, false],
])('enforces salt allocation and entropy bounds at %i bytes', (length, accepted) => {
	const bytes = modified((parameters) => {
		const kdf = parameters.valueBlock.value[0] as Sequence;
		const derivation = kdf.valueBlock.value[1] as Sequence;
		derivation.valueBlock.value[0] = new OctetString({
			valueHex: new Uint8Array(length as number),
		});
	});
	if (accepted) expect(inspectEncryptedCredentialKey(bytes).saltBytes).toBe(length);
	else expect(() => inspectEncryptedCredentialKey(bytes)).toThrow('SIGNER_KEY_POLICY');
});

it('rejects unsupported cipher parameters, trailing DER, excessive PEM size and weak legacy imports during signing', () => {
	const unsupported = modified((parameters) => {
		const cipher = parameters.valueBlock.value[1] as Sequence;
		cipher.valueBlock.value[0] = new ObjectIdentifier({ value: '2.16.840.1.101.3.4.1.2' });
	});
	expect(() => inspectEncryptedCredentialKey(unsupported)).toThrow();
	const originalDer = Buffer.from(
		encrypted.toString().replace(/-----[^\n]+-----|\s/gu, ''),
		'base64'
	);
	const trailing = Buffer.from(
		`-----BEGIN ENCRYPTED PRIVATE KEY-----\n${Buffer.concat([originalDer, Buffer.from([0])]).toString('base64')}\n-----END ENCRYPTED PRIVATE KEY-----\n`
	);
	expect(() => inspectEncryptedCredentialKey(trailing)).toThrow();

	const malformedIv = modified((parameters) => {
		const cipher = parameters.valueBlock.value[1] as Sequence;
		cipher.valueBlock.value[1] = new OctetString({ valueHex: new Uint8Array(17) });
	});
	expect(() => inspectEncryptedCredentialKey(malformedIv)).toThrow();
	const legacy = Buffer.from(
		pair.privateKey.export({
			type: 'pkcs8',
			format: 'pem',
			cipher: 'aes-256-cbc',
			passphrase: password,
		})
	);
	expect(() => inspectEncryptedCredentialKey(legacy)).toThrow();
	for (const size of [128 * 1024 - 1, 128 * 1024]) {
		const padded = Buffer.concat([encrypted, Buffer.alloc(size - encrypted.length, 32)]);
		expect(inspectEncryptedCredentialKey(padded).iterations).toBe(600000);
	}
	expect(() =>
		inspectEncryptedCredentialKey(
			Buffer.concat([encrypted, Buffer.alloc(128 * 1024 + 1 - encrypted.length, 32)])
		)
	).toThrow();
});

it('migrates an existing encrypted key without changing its certificate identity or writing plaintext', async () => {
	const legacy = Buffer.from(
		pair.privateKey.export({
			type: 'pkcs8',
			format: 'pem',
			cipher: 'aes-256-cbc',
			passphrase: 'legacy-secret',
		})
	);
	const migrated = await reencryptCredentialSigningKey(legacy, 'legacy-secret', password);
	expect(legacy.every((byte) => byte === 0)).toBe(true);
	const restored = createPrivateKey({
		key: migrated.encrypted,
		format: 'pem',
		type: 'pkcs8',
		passphrase: password,
	});
	expect(createPublicKey(restored).equals(pair.publicKey)).toBe(true);
	expect(migrated.publicKeySha256).toBe(
		createHash('sha256')
			.update(pair.publicKey.export({ type: 'spki', format: 'der' }))
			.digest('hex')
	);
	expect(inspectEncryptedCredentialKey(migrated.encrypted).iterations).toBe(600000);
});

it.each([15, 16, 17])('applies the password byte boundary at %i', async (length) => {
	const pending = encryptCredentialSigningKey(pair.privateKey, 'x'.repeat(length));
	if (length < 16) await expect(pending).rejects.toThrow('SIGNER_KEY_POLICY');
	else expect(inspectEncryptedCredentialKey(await pending).iterations).toBe(600000);
});
