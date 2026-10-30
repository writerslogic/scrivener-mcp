import { rootCertificates } from 'node:tls';
import { parseCredentialTrustList } from '../../../src/services/content-credentials/trust.js';

const certificate = rootCertificates[0];

it('accepts official-list subject lines and comments, canonicalizes and deduplicates certificates', () => {
	const actual = parseCredentialTrustList(
		Buffer.from(`Subject CN=Public test input\n# list metadata\n${certificate}\n${certificate}`)
	);
	expect(actual.match(/BEGIN CERTIFICATE/gu)).toHaveLength(1);
	expect(parseCredentialTrustList(Buffer.from(actual))).toBe(actual);
	expect(() =>
		parseCredentialTrustList(Buffer.from(`unexpected directive\n${certificate}`))
	).toThrow('TRUST_ANCHORS_INVALID');
});

it.each([255, 256, 257])(
	'bounds trust-list certificate parsing at %i before deduplication',
	(count) => {
		const pending = () =>
			parseCredentialTrustList(Buffer.from(Array(count).fill(certificate).join('\n')));
		if (count <= 256) expect(pending().match(/BEGIN CERTIFICATE/gu)).toHaveLength(1);
		else expect(pending).toThrow('TRUST_ANCHORS_LIMIT');
	}
);

it.each([2097151, 2097152, 2097153])('bounds trust-list bytes at %i', (size) => {
	const pending = () => parseCredentialTrustList(Buffer.alloc(size, 32));
	if (size <= 2097152) expect(pending()).toBe('');
	else expect(pending).toThrow('TRUST_ANCHORS_LIMIT');
});
