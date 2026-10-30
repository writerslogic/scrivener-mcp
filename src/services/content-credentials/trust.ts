import { X509Certificate } from 'node:crypto';
import { MAX_TRUST_CERTIFICATES, MAX_TRUST_CONFIGURATION_BYTES } from './limits.js';

export function parseCredentialTrustList(bytes: Buffer): string {
	if (bytes.length > MAX_TRUST_CONFIGURATION_BYTES) throw new Error('TRUST_ANCHORS_LIMIT');
	const text = bytes.toString('utf8');
	const pattern = /-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----/gu;
	const blocks = text.match(pattern) ?? [];
	if (blocks.length > MAX_TRUST_CERTIFICATES) throw new Error('TRUST_ANCHORS_LIMIT');
	const remainder = text.replace(pattern, '');
	if (
		!remainder
			.split(/\r?\n/u)
			.every((line) => !line.trim() || /^\s*(?:#|Subject[ \t]).*$/u.test(line))
	)
		throw new Error('TRUST_ANCHORS_INVALID');
	const unique = new Map<string, string>();
	for (const block of blocks) {
		const certificate = new X509Certificate(block);
		unique.set(certificate.fingerprint256, certificate.toString());
	}
	return [...unique.values()].join('\n');
}

export function credentialWireSettings(anchors?: string, timestampAnchors?: string): string {
	const lists = [
		{
			trust_kind: 'manifest',
			trust_uri: 'urn:scrivener-mcp:manifest-trust',
			trust_anchors: anchors,
		},
		{
			trust_kind: 'tsa',
			trust_uri: 'urn:scrivener-mcp:timestamp-trust',
			trust_anchors: timestampAnchors,
		},
	].filter((item) => item.trust_anchors);
	return JSON.stringify({
		verify: {
			verify_after_reading: true,
			verify_after_sign: true,
			verify_trust: true,
			verify_timestamp_trust: true,
			ocsp_fetch: false,
			remote_manifest_fetch: false,
		},
		trust: { anchors: lists },
		builder: { generate_c2pa_archive: true, thumbnail: { enabled: false } },
	});
}
