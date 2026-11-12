import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readStableCredentialFile } from '../../src/services/content-credentials/local-files.js';
import { RTFHandler } from '../../src/services/parsers/rtf-handler.js';

export type NovelCorpus = { id: number; title: string; file: string; sha256: string; url: string };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export async function createNovelProject(entry: NovelCorpus, directory: string) {
	const path = join(resolve(directory), entry.file);
	const { bytes: raw } = await readStableCredentialFile(path, 4 * 1024 * 1024, 'Novel corpus');
	assert.equal(hash(raw), entry.sha256);
	const decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw).replace(/\r\n?/g, '\n');
	const body = decoded.match(
		/\*\*\* START OF THE PROJECT GUTENBERG EBOOK[^\n]*\n([\s\S]*?)\*\*\* END OF THE PROJECT GUTENBERG EBOOK/
	)?.[1];
	assert(body !== undefined);
	const scenes: string[] = [];
	for (let start = 0; start < body.length;) {
		let end = Math.min(start + 16000, body.length);
		if (end < body.length) {
			const paragraph = body.lastIndexOf('\n\n', end - 2);
			if (paragraph > start + 8000) end = paragraph + 2;
			if (/[\uDC00-\uDFFF]/.test(body[end])) end--;
		}
		scenes.push(body.slice(start, end));
		start = end;
	}
	assert.equal(scenes.join(''), body);
	const root = await mkdtemp(join(tmpdir(), 'scrivener-novel-'));
	try {
		const project = join(root, 'Novel.scriv');
		await mkdir(project);
		const rtf = new RTFHandler();
		const ids = scenes.map(
			(_, index) => `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
		);
		const file = (id: string) => join(project, 'Files', 'Data', id, 'content.rtf');
		for (const [index, text] of scenes.entries()) {
			await mkdir(dirname(file(ids[index])), { recursive: true });
			const encoded = rtf.convertToRTF(text);
			assert.equal(hash((await rtf.parseRTF(encoded)).plainText), hash(text));
			await writeFile(file(ids[index]), encoded);
		}
		await writeFile(
			join(project, 'Novel.scrivx'),
			`<?xml version="1.0" encoding="UTF-8"?>
<ScrivenerProject Version="2.0"><Binder><BinderItem UUID="20000000-0000-4000-8000-000000000001" Type="DraftFolder"><Title>Draft</Title><Children>
${ids.map((id, index) => `<BinderItem UUID="${id}" Type="Text"><Title>Part ${index + 1}</Title></BinderItem>`).join('')}
</Children></BinderItem></Binder></ScrivenerProject>`
		);
		return { root, project, body, scenes, ids, rtf, file };
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}
