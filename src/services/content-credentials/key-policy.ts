import {
	createCipheriv,
	createPrivateKey,
	createPublicKey,
	createHash,
	pbkdf2,
	randomBytes,
	type KeyObject,
} from 'node:crypto';
import { promisify } from 'node:util';
import {
	fromBER,
	Integer,
	Null,
	ObjectIdentifier,
	OctetString,
	Sequence,
	type BaseBlock,
} from 'asn1js';
import { MAX_CONFIGURATION_BYTES } from './limits.js';

export const CREDENTIAL_KEY_POLICY = Object.freeze({
	cipher: 'aes-256-cbc',
	kdf: 'pbkdf2-sha256',
	minimumIterations: 600000,
	maximumIterations: 2000000,
	minimumSaltBytes: 16,
	maximumSaltBytes: 64,
	minimumPasswordBytes: 16,
});

const PBES2 = '1.2.840.113549.1.5.13';
const PBKDF2 = '1.2.840.113549.1.5.12';
const HMAC_SHA256 = '1.2.840.113549.2.9';
const AES256_CBC = '2.16.840.1.101.3.4.1.42';
const derive = promisify(pbkdf2);

function invalid(): never {
	throw new Error('SIGNER_KEY_POLICY');
}

function sequence(value: BaseBlock | undefined, minimum: number, maximum = minimum): BaseBlock[] {
	if (!(value instanceof Sequence)) return invalid();
	const elements = value.valueBlock.value;
	if (elements.length < minimum || elements.length > maximum) return invalid();
	return elements;
}

function oid(value: BaseBlock | undefined, expected: string): void {
	if (!(value instanceof ObjectIdentifier) || value.valueBlock.toString() !== expected) invalid();
}

function octets(value: BaseBlock | undefined, minimum: number, maximum = minimum): number {
	if (!(value instanceof OctetString) || value.idBlock.isConstructed) return invalid();
	const length = value.valueBlock.valueHexView.length;
	if (length < minimum || length > maximum) return invalid();
	return length;
}

function integer(value: BaseBlock | undefined): number {
	if (!(value instanceof Integer) || value.valueBlock.isHexOnly) return invalid();
	const number = value.valueBlock.valueDec;
	if (!Number.isSafeInteger(number) || number < 1) return invalid();
	return number;
}

export function inspectEncryptedCredentialKey(
	bytes: Buffer,
	options: { legacyImport?: boolean } = {}
): {
	cipher: string;
	kdf: string;
	iterations: number;
	saltBytes: number;
} {
	if (!bytes.length || bytes.length > MAX_CONFIGURATION_BYTES) invalid();
	const match =
		/^\s*-----BEGIN ENCRYPTED PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)-----END ENCRYPTED PRIVATE KEY-----\s*$/u.exec(
			bytes.toString('ascii')
		);
	if (!match) invalid();
	const der = Buffer.from(match[1].replace(/\s/gu, ''), 'base64');
	try {
		const parsed = fromBER(der, {
			maxDepth: 8,
			maxNodes: 64,
			maxContentLength: MAX_CONFIGURATION_BYTES,
			parseEmbedded: false,
			copyInput: false,
		});
		if (parsed.offset !== der.length || parsed.result.error) invalid();
		const top = sequence(parsed.result, 2);
		const algorithm = sequence(top[0], 2);
		oid(algorithm[0], PBES2);
		const parameters = sequence(algorithm[1], 2);
		const kdf = sequence(parameters[0], 2);
		oid(kdf[0], PBKDF2);
		const derivation = sequence(kdf[1], 3, 4);
		const saltBytes = octets(
			derivation[0],
			options.legacyImport ? 8 : CREDENTIAL_KEY_POLICY.minimumSaltBytes,
			CREDENTIAL_KEY_POLICY.maximumSaltBytes
		);
		const iterations = integer(derivation[1]);
		if (
			iterations < (options.legacyImport ? 1 : CREDENTIAL_KEY_POLICY.minimumIterations) ||
			iterations > CREDENTIAL_KEY_POLICY.maximumIterations
		)
			invalid();
		const prfIndex = derivation.length === 4 ? 3 : 2;
		if (prfIndex === 3 && integer(derivation[2]) !== 32) invalid();
		const prf = sequence(derivation[prfIndex], 1, 2);
		oid(prf[0], HMAC_SHA256);
		if (prf.length === 2 && !(prf[1] instanceof Null)) invalid();
		const cipher = sequence(parameters[1], 2);
		oid(cipher[0], AES256_CBC);
		octets(cipher[1], 16);
		if (octets(top[1], 16, MAX_CONFIGURATION_BYTES) % 16 !== 0) invalid();
		return {
			cipher: CREDENTIAL_KEY_POLICY.cipher,
			kdf: CREDENTIAL_KEY_POLICY.kdf,
			iterations,
			saltBytes,
		};
	} finally {
		der.fill(0);
	}
}

export async function encryptCredentialSigningKey(
	key: KeyObject,
	password: string
): Promise<Buffer> {
	const secret = Buffer.from(password, 'utf8');
	if (
		key.type !== 'private' ||
		secret.length < CREDENTIAL_KEY_POLICY.minimumPasswordBytes ||
		secret.length > 4096
	) {
		secret.fill(0);
		return invalid();
	}
	const plaintext = key.export({ type: 'pkcs8', format: 'der' });
	const salt = randomBytes(16);
	const iv = randomBytes(16);
	let derived: Buffer | undefined;
	try {
		derived = await derive(secret, salt, CREDENTIAL_KEY_POLICY.minimumIterations, 32, 'sha256');
		const cipher = createCipheriv('aes-256-cbc', derived, iv);
		const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		const encoded = new Sequence({
			value: [
				new Sequence({
					value: [
						new ObjectIdentifier({ value: PBES2 }),
						new Sequence({
							value: [
								new Sequence({
									value: [
										new ObjectIdentifier({ value: PBKDF2 }),
										new Sequence({
											value: [
												new OctetString({ valueHex: salt }),
												new Integer({
													value: CREDENTIAL_KEY_POLICY.minimumIterations,
												}),
												new Sequence({
													value: [
														new ObjectIdentifier({
															value: HMAC_SHA256,
														}),
														new Null(),
													],
												}),
											],
										}),
									],
								}),
								new Sequence({
									value: [
										new ObjectIdentifier({ value: AES256_CBC }),
										new OctetString({ valueHex: iv }),
									],
								}),
							],
						}),
					],
				}),
				new OctetString({ valueHex: ciphertext }),
			],
		}).toBER(false);
		const base64 = Buffer.from(encoded)
			.toString('base64')
			.match(/.{1,64}/gu)
			?.join('\n');
		if (!base64) return invalid();
		return Buffer.from(
			`-----BEGIN ENCRYPTED PRIVATE KEY-----\n${base64}\n-----END ENCRYPTED PRIVATE KEY-----\n`
		);
	} finally {
		secret.fill(0);
		plaintext.fill(0);
		derived?.fill(0);
	}
}

export async function reencryptCredentialSigningKey(
	encrypted: Buffer,
	oldPassword: string,
	newPassword: string
): Promise<{ encrypted: Buffer; publicKeySha256: string }> {
	const oldSecret = Buffer.from(oldPassword, 'utf8');
	try {
		if (!oldSecret.length || oldSecret.length > 4096) return invalid();
		inspectEncryptedCredentialKey(encrypted, { legacyImport: true });
		const privateKey = createPrivateKey({
			key: encrypted,
			format: 'pem',
			type: 'pkcs8',
			passphrase: oldSecret,
		});
		const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
		return {
			encrypted: await encryptCredentialSigningKey(privateKey, newPassword),
			publicKeySha256: createHash('sha256').update(publicKey).digest('hex'),
		};
	} finally {
		oldSecret.fill(0);
		encrypted.fill(0);
	}
}
