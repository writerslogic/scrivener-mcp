import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { ScrivenerDocument } from '../../types/index.js';
import type { PersistentStore } from './persistent-store.js';
import type { ManuscriptSource, SourceDocument, SourceScopeOptions } from './types.js';
import { RTFHandler } from '../parsers/rtf-handler.js';
import { createError, ErrorCode } from '../../core/errors.js';
import { getOrCreateProjectIdentity } from './project-identity.js';

export const MAX_SOURCE_DOCUMENTS = 10000;
export const MAX_SOURCE_CHARACTERS = 64 * 1024 * 1024;

export function savedRevision(raw: string): string {
	return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export class ProjectSource implements ManuscriptSource {
	readonly projectId: string;
	readonly projectPath: string;
	private readonly rtf = new RTFHandler();
	private readonly textCache = new Map<string, { revision: string; text: string }>();
	private cachedCharacters = 0;

	constructor(
		projectPath: string,
		store: PersistentStore,
		private readonly documents: () => Promise<ScrivenerDocument[]>,
		private readonly readRaw: (documentId: string) => Promise<string>,
		private readonly allDocuments?: () => Promise<ScrivenerDocument[]>
	) {
		this.projectPath = realpathSync(projectPath);
		this.projectId = getOrCreateProjectIdentity(store);
	}

	async list(options: SourceScopeOptions = {}): Promise<SourceDocument[]> {
		if (
			!options ||
			typeof options !== 'object' ||
			Array.isArray(options) ||
			Object.keys(options).some(
				(key) => !['scope', 'maxDocuments', 'maxCharacters'].includes(key)
			)
		)
			throw new Error('Invalid source scope options');
		const scope = options.scope === undefined ? 'draft' : options.scope;
		const maxDocuments =
			options.maxDocuments === undefined ? MAX_SOURCE_DOCUMENTS : options.maxDocuments;
		const maxCharacters =
			options.maxCharacters === undefined ? MAX_SOURCE_CHARACTERS : options.maxCharacters;
		if (
			!['draft', 'all'].includes(scope) ||
			!Number.isSafeInteger(maxDocuments) ||
			maxDocuments < 1 ||
			maxDocuments > MAX_SOURCE_DOCUMENTS ||
			!Number.isSafeInteger(maxCharacters) ||
			maxCharacters < 1 ||
			maxCharacters > MAX_SOURCE_CHARACTERS
		)
			throw new Error('Source scope requires bounded positive document and character limits');
		if (scope === 'all' && !this.allDocuments)
			throw new Error('All-document source scope is unavailable');
		const documents = this.selectDocuments(
			await (scope === 'all' ? this.allDocuments!() : this.documents())
		);
		if (documents.length > maxDocuments)
			throw new Error('Source exceeds the requested document budget');
		const result: SourceDocument[] = [];
		let characters = 0;
		for (let order = 0; order < documents.length; order++) {
			const document = await this.materialize(documents[order], order);
			characters += document.text.length;
			if (characters > maxCharacters)
				throw new Error('Source exceeds the requested UTF-16 character analysis budget');
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
		const revision = savedRevision(raw);
		const cached = this.textCache.get(document.id);
		let text: string;
		if (cached?.revision === revision) {
			text = cached.text;
			this.textCache.delete(document.id);
			this.textCache.set(document.id, cached);
		} else {
			text = raw ? (await this.rtf.parseRTF(raw)).plainText : '';
			if (cached) {
				this.cachedCharacters -= cached.text.length;
				this.textCache.delete(document.id);
			}
			this.textCache.set(document.id, { revision, text });
			this.cachedCharacters += text.length;
			while (
				this.cachedCharacters > 16 * 1024 * 1024 ||
				this.textCache.size > MAX_SOURCE_DOCUMENTS
			) {
				const oldest = this.textCache.keys().next().value!;
				this.cachedCharacters -= this.textCache.get(oldest)!.text.length;
				this.textCache.delete(oldest);
			}
		}
		return {
			projectId: this.projectId,
			documentId: document.id,
			title: document.title,
			path: document.path,
			revision,
			text,
			order,
			metadata: {
				...document.metadata,
				...document.customMetadata,
				...(document.sectionTypeId ? { sectionTypeId: document.sectionTypeId } : {}),
			},
		};
	}
}
