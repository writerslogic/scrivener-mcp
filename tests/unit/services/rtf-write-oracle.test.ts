import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentManager } from '../../../src/services/document-manager.js';
import { ProjectWriter } from '../../../src/services/project-writer.js';
import { ProjectLoader } from '../../../src/services/project-loader.js';
import { ProjectMetadataEditor } from '../../../src/services/project-metadata-editor.js';
import { MetadataManager } from '../../../src/services/metadata-manager.js';
import { ReviewService } from '../../../src/services/editorial/review-service.js';
import { PersistentStore } from '../../../src/services/editorial/persistent-store.js';

const nativeTest = process.platform === 'darwin' ? test : test.skip;
function decode(raw: string): string {
	const result = spawnSync('/usr/bin/textutil', ['-convert', 'txt', '-stdin', '-stdout'], {
		input: raw,
		encoding: 'utf8',
	});
	if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr);
	return result.stdout;
}

nativeTest(
	'native reader verifies create, notes, regeneration, preserving review and exact undo',
	async () => {
		const root = await mkdtemp(join(tmpdir(), 'rtf-write-oracle-'));
		const project = join(root, 'Oracle.scriv');
		await mkdir(project);
		await writeFile(
			join(project, 'Oracle.scrivx'),
			'<ScrivenerProject Identifier="oracle"><Binder><BinderItem UUID="11111111-1111-4111-8111-111111111111" Type="DraftFolder"><Title>Manuscript</Title></BinderItem></Binder></ScrivenerProject>'
		);
		const loader = new ProjectLoader(project);
		const documents = new DocumentManager(project);
		const store = new PersistentStore(join(project, '.scrivener-mcp', 'editorial.sqlite'));
		try {
			documents.setProjectStructure(await loader.loadProject());
			const writer = new ProjectWriter(
				project,
				documents,
				undefined,
				() => {},
				async () => ({ document: null, path: [], metadata: {}, location: 'unknown' }),
				false,
				(structure, files) => loader.saveProjectWithDocuments(structure, files)
			);
			const text = '  "Mara\'s café"\t東京 😀 e\u0301\u00a0\n';
			const id = await writer.createDocument('Original test scene', text, undefined, 'Text', {
				force: true,
			});
			const file = join(project, 'Files', 'Data', id, 'content.rtf');
			expect(decode(await readFile(file, 'utf8'))).toBe(text);
			const metadata = new ProjectMetadataEditor(
				project,
				loader,
				new MetadataManager(),
				(structure, files) => loader.saveProjectWithMetadata(structure, files),
				() => false
			);
			await metadata.updateMetadata(id, { notes: text });
			expect(
				decode(await readFile(join(project, 'Files', 'Data', id, 'notes.rtf'), 'utf8'))
			).toBe(text);
			const rich = String.raw`{\rtf1\ansi old {\b styled} text}`;
			await writeFile(file, rich);
			await expect(
				writer.writeDocument(
					id,
					{
						plainText: 'Reviewed text',
						formattedText: [{ text: 'Different saved text' }],
					},
					{ force: true, allowFormattingLoss: true }
				)
			).rejects.toThrow('Formatted RTF spans must concatenate');
			expect(await readFile(file, 'utf8')).toBe(rich);
			await writer.writeDocument(
				id,
				{ plainText: text, formattedText: [{ text, style: { bold: true } }] },
				{ force: true, allowFormattingLoss: true }
			);
			const regenerated = await readFile(file, 'utf8');
			expect(regenerated).toContain('WritersLogic Scrivener MCP');
			expect(regenerated).toContain('\\b ');
			expect(decode(regenerated)).toBe(text);
			const reviews = new ReviewService(documents, writer, store);
			const start = text.indexOf('café');
			const proposal = await reviews.propose({
				documentId: id,
				edits: [{ start, end: start + 4, text: 'harbor' }],
			});
			const preview = await reviews.preview(proposal.id);
			expect(preview.before).toBe(text);
			const applied = await reviews.apply(proposal.id, { force: true });
			expect(decode(await readFile(file, 'utf8'))).toBe(text.replace('café', 'harbor'));
			await reviews.undo(applied.id, { force: true });
			expect(await readFile(file, 'utf8')).toBe(regenerated);
		} finally {
			await documents.close();
			await loader.close();
			store.close();
			await rm(root, { recursive: true, force: true });
		}
	}
);
