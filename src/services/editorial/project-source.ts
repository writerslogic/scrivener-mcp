import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { ScrivenerDocument } from '../../types/index.js';
import type { PersistentStore } from './persistent-store.js';
import type { ManuscriptSource, SourceDocument } from './types.js';
import { RTFHandler } from '../parsers/rtf-handler.js';
import { createError, ErrorCode } from '../../core/errors.js';

export const MAX_SOURCE_DOCUMENTS = 10000;
export const MAX_SOURCE_CHARACTERS = 64 * 1024 * 1024;

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
		private readonly readRaw: (documentId: string) => Promise<string>,
		private readonly allDocuments?: () => Promise<ScrivenerDocument[]>
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
		const documents = this.selectDocuments(await this.documents());
		const result: SourceDocument[] = [];
		let characters = 0;
		for (let order = 0; order < documents.length; order++) {
			const document = await this.materialize(documents[order], order);
			characters += document.text.length;
			if (characters > MAX_SOURCE_CHARACTERS)
				throw new Error(
					'Manuscript scope exceeds the 64 Mi UTF-16 character analysis budget'
				);
			result.push(document);
		}
		return result;
	}

	async read(documentId: string): Promise<SourceDocument> {
		const documents = this.selectDocuments(await this.documents());
		const order = documents.findIndex((document) => document.id === documentId);
		if (order < 0) {
			const supplemental = this.selectDocuments(
				(await this.allDocuments?.()) ?? [],
				false
			).find((document) => document.id === documentId);
			if (!supplemental)
				throw createError(
					ErrorCode.DOCUMENT_NOT_FOUND,
					{},
					'Document is not in the selected project scope'
				);
			return this.materialize(supplemental, Number.MAX_SAFE_INTEGER);
		}
		return this.materialize(documents[order], order);
	}

	private selectDocuments(
		documents: ScrivenerDocument[],
		manuscript = true
	): ScrivenerDocument[] {
		const selected = documents.filter((document) => document.type === 'Text');
		if (manuscript && selected.length > MAX_SOURCE_DOCUMENTS)
			throw new Error('Manuscript scope exceeds 10000 documents');
		const identities = new Set<string>();
		for (const document of selected) {
			if (typeof document.id !== 'string' || !document.id)
				throw new Error('Binder contains an invalid document identity');
			const identity = document.id.toLowerCase();
			if (identities.has(identity))
				throw new Error('Binder contains duplicate document identities');
			identities.add(identity);
		}
		return selected;
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
