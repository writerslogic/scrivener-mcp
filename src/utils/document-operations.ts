import { generateScrivenerUUID, getDocumentType } from './scrivener-utils.js';
import { createError, ErrorCode } from '../core/errors.js';
import { getLogger, type LogContext } from '../core/logger.js';
import { validateInput } from './common.js';
import { exposeXmlAttributes } from './scrivener-xml.js';
import type { BinderItem, BinderContainer, ProjectStructure } from '../types/internal.js';
import {
	addBinderItem,
	appendBinderChild,
	findBinderItemById,
	iterateBinderItems,
	removeBinderItem,
	validateProjectStructure,
} from '../services/document-manager-helpers.js';

const logger = getLogger('document-operations');
type TimedBinderItem = BinderItem & { Created?: string; Modified?: string };

export interface DocumentCreationOptions {
	title: string;
	content?: string;
	parentId?: string;
	type?: 'Text' | 'Folder';
	metadata?: {
		synopsis?: string;
		notes?: string;
		label?: string;
		status?: string;
		keywords?: string[];
	};
}

export interface DocumentCreationResult {
	id: string;
	path: string[];
	created: Date;
}

export interface DocumentOperationContext {
	projectStructure: unknown;
	projectPath: string;
	writeDocument?: (id: string, content: string) => Promise<void>;
	saveProject?: () => Promise<void>;
	commitCreation?: (
		structure: ProjectStructure,
		documents: readonly { documentId: string; content: string }[]
	) => Promise<void>;
}

/** Runs an operation and persists its binder changes when a save callback is provided. */
export async function withDocumentTransaction<T>(
	operation: () => Promise<T>,
	context: DocumentOperationContext,
	operationName = 'document operation'
): Promise<T> {
	const startTime = Date.now();
	try {
		const result = await operation();
		await context.saveProject?.();
		logger.info(`Transaction completed: ${operationName} (${Date.now() - startTime}ms)`);
		return result;
	} catch (error) {
		logger.error(
			`Transaction failed: ${operationName} (${Date.now() - startTime}ms)`,
			error as LogContext
		);
		throw createError(
			ErrorCode.TRANSACTION_ERROR,
			error instanceof Error ? error : undefined,
			`Failed to complete ${operationName}${error instanceof Error ? `: ${error.message}` : ''}`
		);
	}
}

function getBinder(context: DocumentOperationContext): BinderContainer {
	const structure = context.projectStructure as ProjectStructure | undefined;
	validateProjectStructure(structure);
	return structure.ScrivenerProject.Binder;
}

function findItemPath(
	container: BinderContainer,
	id: string,
	ancestors: string[] = []
): { item: BinderItem; path: string[] } | undefined {
	for (const item of iterateBinderItems(container)) {
		const path = [...ancestors, item.Title || ''];
		if (item.UUID === id || item.ID === id) return { item, path };
		if (item.Children) {
			const found = findItemPath(item.Children, id, path);
			if (found) return found;
		}
	}
	return undefined;
}

function requireFolder(item: BinderItem | undefined, id: string): BinderItem {
	if (!item) throw createError(ErrorCode.NOT_FOUND, undefined, `Parent folder not found: ${id}`);
	if (getDocumentType(item.Type) !== 'Folder')
		throw createError(ErrorCode.INVALID_REQUEST, undefined, 'Parent must be a folder');
	return item;
}

interface CreationPlan {
	options: DocumentCreationOptions;
	item: TimedBinderItem;
	result: DocumentCreationResult;
}

function planCreation(options: DocumentCreationOptions, binder: BinderContainer): CreationPlan {
	validateInput(
		{ ...options },
		{
			title: { type: 'string', required: true, minLength: 1, maxLength: 255 },
			content: { type: 'string', maxLength: 10_000_000 },
			parentId: { type: 'string' },
			type: { type: 'string', enum: ['Text', 'Folder'] },
		}
	);
	if (options.parentId) {
		requireFolder(findBinderItemById(binder, options.parentId), options.parentId);
	}
	const created = new Date();
	const id = generateScrivenerUUID();
	const type = options.type ?? 'Text';
	const item: TimedBinderItem = {
		UUID: id,
		Type: type,
		Title: options.title,
		Created: created.toISOString(),
		Modified: created.toISOString(),
		Children: type === 'Folder' ? { BinderItem: [] } : undefined,
	};
	if (options.metadata) {
		item.MetaData = {
			...options.metadata,
			IncludeInCompile: 'Yes',
			NotesTextSelection: [0, 0],
			StatusID: options.metadata.status || 'N/A',
		} as BinderItem['MetaData'];
	}
	return {
		options,
		item,
		result: { id, path: [options.title], created },
	};
}

function applyCreation(
	plan: CreationPlan,
	context: DocumentOperationContext
): DocumentCreationResult {
	const { options, item, result } = plan;
	const binder = getBinder(context);
	let parent: BinderItem | undefined;
	if (options.parentId) {
		const found = findItemPath(binder, options.parentId);
		parent = requireFolder(found?.item, options.parentId);
		result.path = [...found!.path, options.title];
	} else {
		const first = iterateBinderItems(binder).next().value as BinderItem | undefined;
		if (first?.Type === 'Folder') {
			parent = first;
			result.path = [first.Title || 'Draft', options.title];
		}
	}
	if (parent) {
		appendBinderChild(parent, item);
		if (options.parentId) (parent as TimedBinderItem).Modified = item.Modified;
	} else {
		addBinderItem(binder, item);
	}
	return result;
}

export async function createDocument(
	options: DocumentCreationOptions,
	context: DocumentOperationContext
): Promise<DocumentCreationResult> {
	return (await commitCreations([options], context, 'create document'))[0];
}

export async function createDocuments(
	documents: DocumentCreationOptions[],
	context: DocumentOperationContext
): Promise<DocumentCreationResult[]> {
	return commitCreations(documents, context, 'batch create documents');
}

function commitCreations(
	documents: DocumentCreationOptions[],
	context: DocumentOperationContext,
	operationName: string
): Promise<DocumentCreationResult[]> {
	return withDocumentTransaction(
		async () => {
			if (!Array.isArray(documents) || documents.length < 1 || documents.length > 100)
				throw new Error('Create between 1 and 100 documents in one operation');
			getBinder(context);
			const live = context.projectStructure as ProjectStructure;
			const candidate = structuredClone(live);
			exposeXmlAttributes(candidate);
			const stagedContext = { ...context, projectStructure: candidate };
			const binder = getBinder(stagedContext);
			const plans = documents.map((options) => planCreation(options, binder));
			const contents = plans
				.filter((plan) => plan.item.Type === 'Text')
				.map((plan) => ({ documentId: plan.result.id, content: plan.options.content ?? '' }));
			if (contents.length && context.writeDocument && !context.commitCreation)
				throw new Error('Document content creation requires an atomic commitCreation callback');
			const results = plans.map((plan) => applyCreation(plan, stagedContext));
			if (context.commitCreation) {
				await context.commitCreation(candidate, contents);
				live.ScrivenerProject!.Binder = candidate.ScrivenerProject!.Binder;
			} else {
				const originalBinder = live.ScrivenerProject!.Binder;
				live.ScrivenerProject!.Binder = candidate.ScrivenerProject!.Binder;
				try {
					await context.saveProject?.();
				} catch (error) {
					live.ScrivenerProject!.Binder = originalBinder;
					throw error;
				}
			}
			return results;
		},
		{ ...context, saveProject: undefined },
		operationName
	);
}

function moveBinderItem(binder: BinderContainer, documentId: string, targetParentId: string): void {
	const item = findBinderItemById(binder, documentId);
	if (!item)
		throw createError(ErrorCode.NOT_FOUND, undefined, `Document not found: ${documentId}`);
	const parent = requireFolder(findBinderItemById(binder, targetParentId), targetParentId);
	if (item === parent || (item.Children && findBinderItemById(item.Children, targetParentId)))
		throw createError(
			ErrorCode.INVALID_REQUEST,
			undefined,
			'Cannot move a document into itself or its descendant'
		);
	const removed = removeBinderItem(binder, documentId);
	if (!removed) throw new Error('Document disappeared before it could be moved');
	appendBinderChild(parent, removed);
	const now = new Date().toISOString();
	(item as TimedBinderItem).Modified = now;
	(parent as TimedBinderItem).Modified = now;
}

export async function moveDocument(
	documentId: string,
	targetParentId: string,
	context: DocumentOperationContext
): Promise<void> {
	return withDocumentTransaction(
		async () => moveBinderItem(getBinder(context), documentId, targetParentId),
		context,
		`move document ${documentId}`
	);
}

export async function deleteDocument(
	documentId: string,
	context: DocumentOperationContext,
	moveToTrash = true
): Promise<void> {
	return withDocumentTransaction(
		async () => {
			const binder = getBinder(context);
			if (!findBinderItemById(binder, documentId))
				throw createError(
					ErrorCode.NOT_FOUND,
					undefined,
					`Document not found: ${documentId}`
				);
			if (!moveToTrash) {
				if (!removeBinderItem(binder, documentId))
					throw new Error('Document disappeared before it could be deleted');
				return;
			}
			let trash = [...iterateBinderItems(binder)].find(
				(item) =>
					item.Type === 'TrashFolder' ||
					(item.Title === 'Trash' && item.Type === 'Folder')
			);
			if (!trash) {
				const now = new Date().toISOString();
				trash = {
					UUID: generateScrivenerUUID(),
					Type: 'Folder',
					Title: 'Trash',
					Created: now,
					Modified: now,
					Children: { BinderItem: [] },
				} as TimedBinderItem;
				addBinderItem(binder, trash);
			}
			const trashId = trash.UUID ?? trash.ID;
			if (!trashId) throw new Error('Trash folder has no document ID');
			moveBinderItem(binder, documentId, trashId);
		},
		context,
		`delete document ${documentId}`
	);
}
