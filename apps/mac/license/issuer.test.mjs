import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { open, privateKeyFromSeed, publicKeyFromBase64, rawPublicKey, seal } from './issuer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(path.join(here, 'test-vectors.json'), 'utf8'));
const publicKey = publicKeyFromBase64(vectors.publicKey);

test('the checked-in vectors verify and have not drifted from the generator', () => {
	assert.equal(open('license', vectors.license, publicKey).email, 'reader@example.com');
	assert.equal(open('receipt', vectors.receipt, publicKey).dev, vectors.device);
	assert.deepEqual(open('revocations', vectors.revocations, publicKey).ids, ['lic_other']);
	const key = privateKeyFromSeed(Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)));
	assert.equal(rawPublicKey(key), vectors.publicKey);
	assert.equal(seal('license', open('license', vectors.license, publicKey), key), vectors.license);
});

test('a token signed by another key, or relabelled as another kind, is rejected', () => {
	const other = generateKeyPairSync('ed25519').privateKey;
	const forged = seal('license', open('license', vectors.license, publicKey), other);
	assert.throws(() => open('license', forged, publicKey), /bad signature/);
	const relabelled = `DB1${vectors.revocations.slice('DBX1'.length)}`;
	assert.throws(() => open('license', relabelled, publicKey), /bad signature/);
});

test('a tampered payload is rejected', () => {
	const [prefix, payload, signature] = vectors.license.split('.');
	const tampered = Buffer.from(Buffer.from(payload, 'base64url').toString().replace('reader@', 'pirate@')).toString('base64url');
	assert.throws(() => open('license', `${prefix}.${tampered}.${signature}`, publicKey), /bad signature/);
});

test('keygen writes a private key readable only by its owner and refuses to overwrite or write into the repo', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'dbkeys-'));
	const out = path.join(dir, 'k.pem');
	const run = (target) => execFileSync('node', [path.join(here, 'issuer.mjs'), 'keygen', '--kid', 'x', '--out', target], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
	const output = run(out);
	assert.match(output, /LICENSE_PUBLIC_KEYS="x=[A-Za-z0-9+/=]{44}"/);
	assert.equal(statSync(out).mode & 0o777, 0o600);
	assert.throws(() => run(out), /already exists/);
	assert.throws(() => run(path.join(here, 'inside-repo.pem')), /inside the repository/);
});
