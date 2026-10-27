import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { ScrivenerDocument } from '../../types/index.js';
import type { PersistentStore } from './persistent-store.js';
import type { ManuscriptSource, SourceDocument } from './types.js';
import { RTFHandler } from '../parsers/rtf-handler.js';

export function savedRevision(raw: string): string {
	return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export class ProjectSource implements ManuscriptSource {
	readonly projectId: string;
	readonly projectPath: string;
	private readonly rtf = new RTFHandler();

	constructor(
		projectPath: string,
		store: PersistentStore,
		private readonly documents: () => Promise<ScrivenerDocument[]>,
		private readonly readRaw: (documentId: string) => Promise<string>
	) {
		this.projectPath = realpathSync(projectPath);
		this.projectId = store.transaction(() => {
			const existing = store.get<string>('identity', 'project');
			if (existing) return existing;
			const identity = randomUUID();
			store.put('identity', 'project', identity);
			return identity;
		});
	}

	async list(): Promise<SourceDocument[]> {
		const documents = (await this.documents()).filter((document) => document.type === 'Text');
		const result: SourceDocument[] = [];
		for (let order = 0; order < documents.length; order++) {
			result.push(await this.materialize(documents[order], order));
		}
		return result;
	}

	async read(documentId: string): Promise<SourceDocument> {
		const documents = (await this.documents()).filter((document) => document.type === 'Text');
		const order = documents.findIndex((document) => document.id === documentId);
		if (order < 0) throw new Error('Document is not in the selected project scope');
		return this.materialize(documents[order], order);
	}

	private async materialize(document: ScrivenerDocument, order: number): Promise<SourceDocument> {
		const raw = await this.readRaw(document.id);
		if (Buffer.byteLength(raw) > 10 * 1024 * 1024)
			throw new Error('Document exceeds the analysis size limit');
		return {
			projectId: this.projectId,
			documentId: document.id,
			title: document.title,
			path: document.path,
			revision: savedRevision(raw),
			text: raw ? (await this.rtf.parseRTF(raw)).plainText : '',
			order,
			metadata: {
				...document.metadata,
				...document.customMetadata,
				...(document.sectionTypeId ? { sectionTypeId: document.sectionTypeId } : {}),
			},
		};
	}
}
