import { constants, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	createRawCredentialSigner,
	credentialContextSettings,
	decryptCredentialKey,
	handleCredentialWorkerRequest,
	normalizeCredentialValidation,
	validateCredentialWorkerRequest,
} from '../../../src/services/content-credentials/sdk-worker.js';

const report = (validationState: string = 'Valid') => ({
	active_manifest: 'urn:fixture:manifest', manifests: { 'urn:fixture:manifest': { title: 'Fixture' } },
	validation_state: validationState,
	validation_results: { activeManifest: { success: [{ code: 'claimSignature.validated' }, { code: 'assertion.dataHash.match' }], informational: [], failure: [] as Array<{ code: string }> } },
});

it('keeps unsigned, invalid, untrusted and explicitly trusted validation states distinct', () => {
	expect(normalizeCredentialValidation(null, false)).toMatchObject({ state: 'unsigned', integrity: 'not-evaluated', trust: 'not-evaluated', report: null });
	expect(normalizeCredentialValidation(report(), false)).toMatchObject({ state: 'untrusted', integrity: 'valid', trust: 'untrusted', trustPolicy: 'none' });
	expect(normalizeCredentialValidation(report('Trusted'), false)).toMatchObject({ state: 'untrusted', trust: 'untrusted' });
	expect(normalizeCredentialValidation(report('Trusted'), true)).toMatchObject({ state: 'valid', integrity: 'valid', trust: 'trusted', trustPolicy: 'configured-roots' });
	const invalid = report('Invalid');
	invalid.validation_results.activeManifest.failure.push({ code: 'assertion.dataHash.mismatch' });
	expect(normalizeCredentialValidation(invalid, true)).toMatchObject({ state: 'invalid', integrity: 'invalid', trust: 'not-evaluated', validationCodes: ['assertion.dataHash.match', 'assertion.dataHash.mismatch', 'claimSignature.validated'], report: invalid });
});

it('does not treat trust failures or assertion text as evidence of trusted integrity', () => {
	const untrusted = report();
	untrusted.validation_results.activeManifest.failure.push({ code: 'signingCredential.untrusted' });
	expect(normalizeCredentialValidation(untrusted, true)).toMatchObject({ state: 'untrusted', integrity: 'valid', trust: 'untrusted' });
	const spoofed = { ...report(), manifests: { 'urn:fixture:manifest': { assertions: [{ data: { code: 'signingCredential.trusted', validation_state: 'Trusted' } }] } } };
	expect(normalizeCredentialValidation(spoofed, true)).toMatchObject({ state: 'untrusted', validationCodes: ['assertion.dataHash.match', 'claimSignature.validated'] });
	const contradictory = report('Trusted');
	contradictory.validation_results.activeManifest.failure.push({ code: 'claimSignature.mismatch' });
	expect(normalizeCredentialValidation(contradictory, true)).toMatchObject({ state: 'invalid', integrity: 'invalid' });
	expect(normalizeCredentialValidation({ ...report('Trusted'), active_manifest: 'constructor' }, true)).toMatchObject({ state: 'invalid', integrity: 'not-evaluated' });
	const { validation_state: _state, ...missingState } = report();
	expect(normalizeCredentialValidation(missingState, true)).toMatchObject({ state: 'invalid', integrity: 'not-evaluated' });
});

it('requires current asset-binding and signature evidence even when the native state says Trusted', () => {
	for (const code of ['claimSignature.validated', 'assertion.dataHash.match']) {
		const value = report('Trusted');
		value.validation_results.activeManifest.success = [{ code }];
		Object.assign(value.validation_results, { ingredientDeltas: [{ validationDeltas: { success: [{ code: 'claimSignature.validated' }, { code: 'assertion.dataHash.match' }] } }] });
		expect(normalizeCredentialValidation(value, true)).toMatchObject({ state: 'invalid', integrity: 'not-evaluated', trust: 'not-evaluated' });
	}
	const contradiction = { ...report('Trusted'), validation_status: [{ code: 'assertion.dataHash.mismatch' }] };
	expect(normalizeCredentialValidation(contradiction, true)).toMatchObject({ state: 'invalid', integrity: 'invalid' });
});

it.each([1023, 1024])('bounds normalized validation code collections at %i', (count) => {
	const value = report();
	value.validation_results.activeManifest.success = Array.from({ length: count }, (_, index) => ({ code: `fixture.code${index}` }));
	expect(normalizeCredentialValidation(value, false).validationCodes).toHaveLength(count);
	value.validation_results.activeManifest.success.push({ code: 'fixture.code0' });
	expect(normalizeCredentialValidation(value, false).validationCodes).toHaveLength(count);
});

it('rejects excess codes, malformed codes and excessive report depth', () => {
	const value = report();
	value.validation_results.activeManifest.success = Array.from({ length: 1025 }, (_, index) => ({ code: `fixture.code${index}` }));
	expect(() => normalizeCredentialValidation(value, false)).toThrow(/too many validation codes/i);
	value.validation_results.activeManifest.success = [{ code: 'not a valid code' }];
	expect(() => normalizeCredentialValidation(value, false)).toThrow(/code exceeds/i);
	let nested: Record<string, unknown> = {};
	for (let index = 0; index < 66; index++) nested = { child: nested };
	expect(() => normalizeCredentialValidation({ ...report(), nested }, false)).toThrow(/bounds/i);
});


it('enforces the exact serialized native report size limit', () => {
	const base = { ...report(), padding: '' };
	const overhead = Buffer.byteLength(JSON.stringify(base));
	for (const length of [8 * 1024 * 1024 - 1, 8 * 1024 * 1024]) {
		const value = { ...base, padding: 'x'.repeat(length - overhead) };
		expect(normalizeCredentialValidation(value, false).integrity).toBe('valid');
	}
	expect(() => normalizeCredentialValidation({ ...base, padding: 'x'.repeat(8 * 1024 * 1024 + 1 - overhead) }, false)).toThrow(/bounds/i);
});

it('disables remote manifests, OCSP, thumbnails and unconfigured trust anchors', () => {
	expect(credentialContextSettings()).toMatchObject({ verify: { remoteManifestFetch: false, ocspFetch: false, verifyAfterReading: true, verifyAfterSign: true }, cawgTrust: { verifyTrustList: false }, builder: { thumbnail: { enabled: false } } });
	expect(credentialContextSettings().trust).not.toHaveProperty('trustAnchors');
});

it('rejects malformed IPC and signing requests without loading native code or echoing secrets', async () => {
	const secret = 'fixture-password-must-not-appear';
	const request = { operation: 'sign', assetPath: join(tmpdir(), 'asset.png'), mimeType: 'image/png', mode: 'embedded', destinationPath: join(tmpdir(), 'output.png'), signer: { certificatePath: join(tmpdir(), 'certificate.pem'), privateKeyPath: join(tmpdir(), 'key.pem'), password: secret.repeat(200) } };
	const result = await handleCredentialWorkerRequest(request);
	expect(result).toMatchObject({ ok: false, code: 'REQUEST_INVALID' });
	expect(JSON.stringify(result)).not.toContain(secret);
	expect(request.signer.password).toBe('');
	expect(() => validateCredentialWorkerRequest({ operation: 'probe', assetPath: 'unexpected' })).toThrow(/unsupported fields/i);
	expect(() => validateCredentialWorkerRequest({ operation: 'validate', assetPath: 'https://example.test/asset', mimeType: 'image/png', mode: 'embedded' })).toThrow(/local file paths/i);
	expect(() => validateCredentialWorkerRequest({ operation: 'validate', assetPath: join(tmpdir(), 'asset'), mimeType: 'image/png', mode: 'sidecar' })).toThrow(/inconsistent/i);
});

it('unlocks only encrypted PKCS8 data and wipes owned key/password buffers', () => {
	const { privateKey, publicKey } = generateKeyPairSync('ed25519');
	const encrypted = Buffer.from(String(privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'fixture-password' })));
	const password = Buffer.from('fixture-password');
	const unlocked = decryptCredentialKey(encrypted, password);
	expect(createPublicKey(unlocked).equals(publicKey)).toBe(true);
	expect(encrypted.every((byte) => byte === 0)).toBe(true);
	expect(password.every((byte) => byte === 0)).toBe(true);
	const unencrypted = Buffer.from('-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----\n');
	const rejectedPassword = Buffer.from('fixture-password');
	expect(() => decryptCredentialKey(unencrypted, rejectedPassword)).toThrow(/encrypted PKCS8/i);
	expect(unencrypted.every((byte) => byte === 0)).toBe(true);
	expect(rejectedPassword.every((byte) => byte === 0)).toBe(true);
});

it('produces independently verifiable P1363 ECDSA, PSS and Ed25519 signatures', async () => {
	const payload = Buffer.from('C2PA callback signing fixture');
	const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
	const ecSigner = createRawCredentialSigner(ec.privateKey);
	const ecSignature = await ecSigner.sign(payload);
	expect(ecSigner.algorithm).toBe('es256');
	expect(ecSignature).toHaveLength(64);
	expect(verify('sha256', payload, { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, ecSignature)).toBe(true);
	const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const rsaSigner = createRawCredentialSigner(rsa.privateKey);
	const rsaSignature = await rsaSigner.sign(payload);
	expect(rsaSigner.algorithm).toBe('ps256');
	expect(verify('sha256', payload, { key: rsa.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, rsaSignature)).toBe(true);
	const ed = generateKeyPairSync('ed25519');
	const edSignature = await createRawCredentialSigner(ed.privateKey).sign(payload);
	expect(verify(null, payload, ed.publicKey, edSignature)).toBe(true);
	expect(verify(null, Buffer.from('modified'), ed.publicKey, edSignature)).toBe(false);
});
