import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { release } from 'node:os';
import { parseArgs } from 'node:util';
import { RTFHandler } from '../dist/services/parsers/rtf-handler.js';

const { values } = parseArgs({
	options: {
		project: { type: 'string' },
		output: { type: 'string' },
		'corpus-version': { type: 'string' },
	},
});
assert(process.platform === 'darwin', 'This independent oracle requires macOS textutil');
assert(
	values.project && values.output && values['corpus-version'],
	'Supply --project, --corpus-version and --output'
);
const root = resolve(values.project);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const files = [];
async function collect(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		assert(!entry.isSymbolicLink(), 'Corpus must not contain symbolic links');
		const path = join(directory, entry.name);
		if (entry.isDirectory()) await collect(path);
		else if (entry.isFile() && entry.name.endsWith('.rtf')) files.push(path);
		assert(files.length <= 2000, 'Corpus exceeds 2000 RTF files');
	}
}
await collect(root);
assert(files.length > 0, 'Corpus has no RTF files');
const handler = new RTFHandler();
const records = [];
for (const path of files.sort()) {
	const bytes = await readFile(path);
	assert(bytes.length <= 10 * 1024 * 1024, 'RTF file exceeds 10 MiB');
	const record = { file: relative(root, path), rawSha256: hash(bytes), bytes: bytes.length };
	const native = execFileSync('/usr/bin/textutil', ['-convert', 'txt', '-stdin', '-stdout'], {
		input: bytes,
		encoding: 'utf8',
		timeout: 15000,
		maxBuffer: 16 * 1024 * 1024,
	});
	record.nativeTextSha256 = hash(native);
	record.nativeUtf16Length = native.length;
	let parsed;
	try {
		parsed = await handler.parseRTF(bytes.toString('utf8'));
	} catch (error) {
		record.status = 'refused';
		record.reason = String(error.message).slice(0, 500);
	}
	if (parsed) {
		assert.equal(parsed.formattedText.map((run) => run.text).join(''), parsed.plainText);
		record.parsedTextSha256 = hash(parsed.plainText);
		record.parsedUtf16Length = parsed.plainText.length;
		record.status = native === parsed.plainText ? 'exact' : 'different';
		if (record.status === 'different') {
			let start = 0;
			while (
				start < Math.min(native.length, parsed.plainText.length) &&
				native[start] === parsed.plainText[start]
			)
				start++;
			record.firstDifferenceUtf16 = start;
			record.nativeCodePoints = [...native.slice(start, start + 8)].map((point) =>
				point.codePointAt(0)
			);
			record.parsedCodePoints = [...parsed.plainText.slice(start, start + 8)].map((point) =>
				point.codePointAt(0)
			);
		}
	}
	records.push(record);
}
const summary = Object.fromEntries(
	['exact', 'different', 'refused'].map((status) => [
		status,
		records.filter((record) => record.status === status).length,
	])
);
const implementations = ['rtf-handler.js', 'rtf-text.js', 'rtf-validation.js'];
const report = {
	measuredAt: new Date().toISOString(),
	runtime: process.version,
	platform: `${process.platform}-${process.arch}`,
	osRelease: release(),
	corpus: {
		path: root,
		version: values['corpus-version'],
		files: files.length,
		manifestSha256: hash(
			JSON.stringify(records.map(({ file, rawSha256 }) => ({ file, rawSha256 })))
		),
	},
	implementation: await Promise.all(
		implementations.map(async (file) => ({
			file,
			sha256: hash(
				await readFile(new URL(`../dist/services/parsers/${file}`, import.meta.url))
			),
		}))
	),
	oracle: '/usr/bin/textutil -convert txt -stdin -stdout (macOS Cocoa)',
	summary,
	records,
	limitations: [
		'Read-only locally installed corpus; source text is not redistributed.',
		'Exact plain text and internal span alignment only; no native Scrivener GUI save/reopen or style equivalence certification.',
		'Refusals are explicit unsupported inputs, not passing fidelity observations. Differences require review before a fidelity claim.',
	],
};
await mkdir(dirname(resolve(values.output)), { recursive: true });
await writeFile(resolve(values.output), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(summary));
if (summary.different) process.exitCode = 1;
