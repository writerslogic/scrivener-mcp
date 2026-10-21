#!/usr/bin/env node
// Issues and checks Draftbridge licenses. Reference implementation of the token format in
// docs/licensing.md; the license service must produce byte-identical tokens.
//
//   node issuer.mjs keygen --kid 2026a --out ~/secure/draftbridge-2026a.pem
//   node issuer.mjs issue --key KEY.pem --kid 2026a --email a@b.co --id lic_123 [--seats 3] [--iat UNIX]
//   node issuer.mjs receipt --key KEY.pem --kid 2026a --license TOKEN --device HASH
//   node issuer.mjs revocations --key KEY.pem --kid 2026a --ids lic_1,lic_2
//   node issuer.mjs verify --pub BASE64_PUBLIC_KEY --kid 2026a TOKEN
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORMATS = {
	license: { prefix: 'DB1', domain: 'draftbridge-license-v1' },
	receipt: { prefix: 'DBR1', domain: 'draftbridge-receipt-v1' },
	revocations: { prefix: 'DBX1', domain: 'draftbridge-revocations-v1' },
};

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');

export function seal(kind, payload, privateKey) {
	const { prefix, domain } = FORMATS[kind];
	const text = b64url(JSON.stringify(payload));
	const signature = sign(null, Buffer.from(`${domain}\n${text}`), privateKey);
	return `${prefix}.${text}.${b64url(signature)}`;
}

export function open(kind, token, publicKey) {
	const { prefix, domain } = FORMATS[kind];
	const parts = token.trim().split('.');
	if (parts.length !== 3 || parts[0] !== prefix) throw new Error('malformed');
	const ok = verify(null, Buffer.from(`${domain}\n${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url'));
	if (!ok) throw new Error('bad signature');
	return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
}

export function publicKeyFromBase64(text) {
	const raw = Buffer.from(text, 'base64');
	if (raw.length !== 32) throw new Error('an Ed25519 public key is 32 bytes');
	return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
}

export function rawPublicKey(privateKey) {
	return createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
}

export function privateKeyFromSeed(seed) {
	return createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
}

function args(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i];
		else out._.push(argv[i]);
	}
	return out;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const expand = (p) => path.resolve(p.replace(/^~(?=$|\/)/, homedir()));

function need(options, ...names) {
	for (const name of names) if (!options[name]) throw new Error(`missing --${name}`);
}

function main() {
	const [command, ...rest] = process.argv.slice(2);
	const o = args(rest);
	const now = () => Math.floor(Date.now() / 1000);

	if (command === 'keygen') {
		need(o, 'kid', 'out');
		const out = expand(o.out);
		if (out.startsWith(repoRoot + path.sep)) throw new Error('Refusing to write a private key inside the repository.');
		const { privateKey } = generateKeyPairSync('ed25519');
		try {
			// 'wx' creates the file or fails, so there is no check-then-write gap.
			writeFileSync(out, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
		} catch (error) {
			if (error.code === 'EEXIST') throw new Error(`${out} already exists.`);
			throw error;
		}
		chmodSync(out, 0o600);
		console.log(`Private key written to ${out}. Back it up somewhere safe; losing it means re-keying every build.`);
		console.log(`LICENSE_PUBLIC_KEYS="${o.kid}=${rawPublicKey(privateKey)}"`);
		return;
	}

	if (command === 'verify') {
		need(o, 'pub');
		const token = o._[0];
		const payload = open(o.token_kind ?? 'license', token, publicKeyFromBase64(o.pub));
		console.log(JSON.stringify(payload, null, 2));
		return;
	}

	need(o, 'key', 'kid');
	const privateKey = createPrivateKey(readFileSync(expand(o.key)));

	if (command === 'issue') {
		need(o, 'email', 'id');
		console.log(seal('license', {
			v: 1, kid: o.kid, id: o.id, email: o.email, iat: Number(o.iat ?? now()), seats: Number(o.seats ?? 3), product: 'draftbridge',
		}, privateKey));
	} else if (command === 'receipt') {
		need(o, 'license', 'device');
		const license = open('license', o.license, createPublicKey(privateKey));
		console.log(seal('receipt', { v: 1, kid: o.kid, id: license.id, dev: o.device, iat: Number(o.iat ?? now()) }, privateKey));
	} else if (command === 'revocations') {
		console.log(seal('revocations', { v: 1, kid: o.kid, iat: Number(o.iat ?? now()), ids: (o.ids ?? '').split(',').filter(Boolean) }, privateKey));
	} else {
		console.error('commands: keygen, issue, receipt, revocations, verify');
		process.exit(2);
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(`Error: ${error.message}`);
		process.exit(1);
	}
}
