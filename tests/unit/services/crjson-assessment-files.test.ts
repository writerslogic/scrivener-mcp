import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCrjsonAssessmentFiles } from '../../../src/services/content-credentials/crjson-assessment-files.js';

let directory: string;
const output = {
	assessmentBytes: Buffer.from('{"assessment":true}\n'),
	nativeEvidenceBytes: Buffer.from('{"native":true}\n'),
};
const destinations = () =>
	[join(directory, 'assessment.json'), join(directory, 'native.json')] as const;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'scrivener-assessment-files-'));
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

test('publishes both exact artifacts as exclusive files without leftover staging', async () => {
	const paths = destinations();
	const publish = await prepareCrjsonAssessmentFiles(...paths);
	await publish(output);
	expect(await readFile(paths[0])).toEqual(output.assessmentBytes);
	expect(await readFile(paths[1])).toEqual(output.nativeEvidenceBytes);
	expect((await readdir(directory)).sort()).toEqual(['assessment.json', 'native.json']);
});

test('rejects existing destinations before publishing either artifact', async () => {
	const paths = destinations();
	await writeFile(paths[0], 'original');
	await expect(prepareCrjsonAssessmentFiles(...paths)).rejects.toThrow('two new files');
	expect(await readFile(paths[0], 'utf8')).toBe('original');
	await expect(readFile(paths[1])).rejects.toMatchObject({ code: 'ENOENT' });
});

test('rejects lexical and symlink aliases of the same destination', async () => {
	const [assessment] = destinations();
	await expect(prepareCrjsonAssessmentFiles(assessment, assessment)).rejects.toThrow(
		'different output paths'
	);
	const alias = join(directory, 'alias');
	await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
	await expect(
		prepareCrjsonAssessmentFiles(assessment, join(alias, 'assessment.json'))
	).rejects.toThrow('different output paths');
});

test.each(['relative.json', '/bad\0path', '/x.scriv/Files/report.json'])(
	'rejects unsafe output %s before publication',
	async (path) => {
		await expect(prepareCrjsonAssessmentFiles(path, destinations()[1])).rejects.toThrow();
		expect(await readdir(directory)).toEqual([]);
	}
);

test('a native-sidecar race preserves the competing file and publishes no assessment', async () => {
	const paths = destinations();
	const publish = await prepareCrjsonAssessmentFiles(...paths);
	await writeFile(paths[1], 'competing evidence');
	await expect(publish(output)).rejects.toThrow('already exists');
	expect(await readFile(paths[1], 'utf8')).toBe('competing evidence');
	await expect(readFile(paths[0])).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a second-file failure retains native evidence and gives an explicit recovery instruction', async () => {
	const paths = destinations();
	const publish = await prepareCrjsonAssessmentFiles(...paths);
	await writeFile(paths[0], 'competing assessment');
	await expect(publish(output)).rejects.toThrow(
		'Native evidence was retained; inspect both destinations and retry with two new paths'
	);
	expect(await readFile(paths[0], 'utf8')).toBe('competing assessment');
	expect(await readFile(paths[1])).toEqual(output.nativeEvidenceBytes);
	expect((await readdir(directory)).sort()).toEqual(['assessment.json', 'native.json']);
});
