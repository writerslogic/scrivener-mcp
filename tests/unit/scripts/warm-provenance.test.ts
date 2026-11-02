import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const evidence = JSON.parse(
	readFileSync('assets/c2pa-supply-chain/warm/npm-provenance.json', 'utf8')
);
const association = JSON.parse(readFileSync('assets/c2pa-supply-chain/upstream.json', 'utf8'))
	.sourceAssociation.warm;
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const runner = `import { validateWarmProvenance } from './scripts/create-c2pa-inventory.mjs';
let text = ''; for await (const chunk of process.stdin) text += chunk;
const input = JSON.parse(text);
try { validateWarmProvenance(input.evidence, input.association, input.lock); process.stdout.write('valid'); }
catch (error) { process.stdout.write(error.code); }`;
function check(value: typeof evidence): string {
	return execFileSync(process.execPath, ['--input-type=module', '-e', runner], {
		input: JSON.stringify({ evidence: value, association, lock }),
		encoding: 'utf8',
	});
}
it('binds every published Warm package to its locked tarball integrity and source commit', () => {
	expect(check(evidence)).toBe('valid');
});
it.each(['missing', 'duplicate', 'integrity', 'commit', 'subject', 'workflow'])(
	'rejects %s provenance',
	(fault) => {
		const changed = structuredClone(evidence);
		if (fault === 'missing') changed.packages.pop();
		if (fault === 'duplicate') changed.packages[1] = changed.packages[0];
		if (fault === 'integrity')
			changed.packages[0].integrity = 'sha512-' + 'a'.repeat(86) + '==';
		if (fault === 'commit') changed.packages[0].commit = '0'.repeat(40);
		if (fault === 'subject') changed.packages[0].subject.digest.sha512 = '0'.repeat(128);
		if (fault === 'workflow')
			changed.packages[0].workflow.repository = 'https://github.com/other/warm';
		expect(check(changed)).toMatch(/INVALID_UPSTREAM_METADATA|UPSTREAM_VERSION_MISMATCH/);
	}
);
