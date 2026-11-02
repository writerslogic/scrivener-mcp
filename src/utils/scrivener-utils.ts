import * as crypto from 'crypto';
import { constants as fsConstants, lstatSync, realpathSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
	validateInput,
	isValidUUID,
	AppError,
	ErrorCode,
	buildPath,
	formatBytes,
} from './common.js';
import { DOCUMENT_TYPES } from '../core/constants.js';
import type { BinderItem, BinderContainer, MetaDataItem } from '../types/internal.js';

/**
 * Scrivener-specific utility functions
 * Enhanced with better type safety, error handling, and organization
 */

/** Scrivener file extensions */
export const SCRIVENER_EXTENSIONS = {
	PROJECT: '.scriv',
	RTF: '.rtf',
	TEXT: '.txt',
	XML: '.scrivx',
} as const;

export const SCRIVENER_FOLDERS = {
	DRAFT: 'DraftFolder',
	RESEARCH: 'ResearchFolder',
	TRASH: 'TrashFolder',
	FOLDER: 'Folder',
} as const;

/** Maximum limits for Scrivener */
export const SCRIVENER_LIMITS = {
	MAX_TITLE_LENGTH: 255,
	MAX_CONTENT_SIZE: 10 * 1024 * 1024, // 10MB
	MAX_SYNOPSIS_LENGTH: 5000,
	MAX_NOTES_LENGTH: 100000,
} as const;

export interface ResolvedScrivenerProjectPath {
	projectPath: string;
	scrivxPath: string;
}

/**
 * Normalize a project path while preserving native Windows drive-letter paths.
 */
export function normalizeScrivenerPath(inputPath: string): string {
	if (!inputPath) {
		throw new AppError('Project path is required', ErrorCode.INVALID_INPUT);
	}

	return path.resolve(path.normalize(inputPath.replace(/\0/g, '')));
}

/**
 * Return the Scrivener project name without .scriv or .scrivx.
 */
export function getScrivenerProjectName(projectPath: string): string {
	const normalizedPath = path.normalize(projectPath.replace(/\0/g, ''));
	const extension = path.extname(normalizedPath);
	const lowerExtension = extension.toLowerCase();

	if (
		lowerExtension === SCRIVENER_EXTENSIONS.PROJECT ||
		lowerExtension === SCRIVENER_EXTENSIONS.XML
	) {
		return path.basename(normalizedPath, extension);
	}

	return path.basename(normalizedPath);
}

export function getDefaultScrivxPath(projectPath: string): string {
	const normalizedPath = normalizeScrivenerPath(projectPath);

	if (path.extname(normalizedPath).toLowerCase() === SCRIVENER_EXTENSIONS.XML) {
		return normalizedPath;
	}

	return path.join(normalizedPath, `${getScrivenerProjectName(normalizedPath)}.scrivx`);
}

async function isFile(filePath: string): Promise<boolean> {
	try {
		return (await fs.stat(filePath)).isFile();
	} catch {
		return false;
	}
}

/**
 * Discover the .scrivx file inside a Scrivener project directory.
 *
 * Scrivener projects usually use <ProjectName>.scriv/<ProjectName>.scrivx, but
 * migrated projects and case-different Windows folders can carry a different
 * casing or a single alternate .scrivx file. Prefer explicit/default names and
 * then fall back only when there is exactly one .scrivx candidate.
 */
export async function findScrivxPath(
	projectPath: string,
	preferredScrivxPath?: string
): Promise<string> {
	const normalizedProjectPath = normalizeScrivenerPath(projectPath);
	const defaultScrivxPath = getDefaultScrivxPath(normalizedProjectPath);

	if (preferredScrivxPath) {
		const normalizedPreferredPath = normalizeScrivenerPath(preferredScrivxPath);
		if (await isFile(normalizedPreferredPath)) {
			return normalizedPreferredPath;
		}
	}

	const entries = await fs.readdir(normalizedProjectPath, { withFileTypes: true });
	const scrivxEntries = entries.filter(
		(entry) =>
			entry.isFile() && path.extname(entry.name).toLowerCase() === SCRIVENER_EXTENSIONS.XML
	);

	const defaultScrivxName = path.basename(defaultScrivxPath).toLowerCase();
	const defaultEntry = scrivxEntries.find(
		(entry) => entry.name.toLowerCase() === defaultScrivxName
	);
	if (defaultEntry) {
		return path.join(normalizedProjectPath, defaultEntry.name);
	}

	const projectName = getScrivenerProjectName(normalizedProjectPath).toLowerCase();
	const matchingEntry = scrivxEntries.find(
		(entry) => path.basename(entry.name, path.extname(entry.name)).toLowerCase() === projectName
	);
	if (matchingEntry) {
		return path.join(normalizedProjectPath, matchingEntry.name);
	}

	if (scrivxEntries.length === 1) {
		return path.join(normalizedProjectPath, scrivxEntries[0].name);
	}
	if (
		scrivxEntries.length === 0 &&
		entries.some(
			(entry) =>
				entry.isDirectory() &&
				path.extname(entry.name).toLowerCase() === SCRIVENER_EXTENSIONS.PROJECT
		)
	)
		throw new AppError(
			`"${normalizedProjectPath}" looks like a parent folder. Pass the .scriv project folder or its .scrivx file.`,
			ErrorCode.INVALID_INPUT,
			{ projectPath: normalizedProjectPath }
		);

	throw new AppError(
		`Scrivener project file not found at "${defaultScrivxPath}"`,
		ErrorCode.NOT_FOUND,
		{ projectPath: normalizedProjectPath, expectedScrivxPath: defaultScrivxPath }
	);
}

/**
 * Resolve either a .scriv directory or direct .scrivx file to both paths.
 */
export async function resolveScrivenerProjectPath(
	inputPath: string
): Promise<ResolvedScrivenerProjectPath> {
	const normalizedPath = normalizeScrivenerPath(inputPath);
	const stats = await fs.stat(normalizedPath).catch((error: unknown) => {
		throw new AppError(
			`Project path does not exist: ${normalizedPath}`,
			ErrorCode.FILE_NOT_FOUND,
			{
				path: normalizedPath,
				cause: error,
			}
		);
	});

	if (stats.isFile()) {
		if (path.extname(normalizedPath).toLowerCase() !== SCRIVENER_EXTENSIONS.XML) {
			throw new AppError(
				`Expected a .scriv project folder or .scrivx file: ${normalizedPath}`,
				ErrorCode.INVALID_INPUT,
				{ path: normalizedPath }
			);
		}

		return {
			projectPath: path.dirname(normalizedPath),
			scrivxPath: normalizedPath,
		};
	}

	if (!stats.isDirectory()) {
		throw new AppError(
			`Expected a .scriv project folder or .scrivx file: ${normalizedPath}`,
			ErrorCode.INVALID_INPUT,
			{ path: normalizedPath }
		);
	}

	return {
		projectPath: normalizedPath,
		scrivxPath: await findScrivxPath(normalizedPath),
	};
}

export const PROJECT_ARTIFACT_READ_FLAGS =
	fsConstants.O_RDONLY |
	(fsConstants.O_NOFOLLOW ?? 0) |
	(fsConstants.O_NONBLOCK ?? 0) |
	(fsConstants.O_NOCTTY ?? 0);

export function assertValidProjectDocumentId(documentId: string): void {
	if (typeof documentId !== 'string' || !isValidScrivenerDocumentId(documentId)) {
		throw new AppError('Invalid document ID', ErrorCode.INVALID_INPUT, { documentId });
	}
}

export function assertProjectArtifactPath(projectPath: string, filePath: string): string {
	if (typeof filePath !== 'string' || filePath.includes('\0')) {
		throw new AppError('Invalid project artifact path', ErrorCode.PATH_INVALID, { filePath });
	}
	const root = normalizeScrivenerPath(projectPath);
	const target = path.resolve(filePath);
	const relative = path.relative(root, target);
	if (
		relative === '' ||
		relative.startsWith(`..${path.sep}`) ||
		relative === '..' ||
		path.isAbsolute(relative)
	) {
		throw new AppError('Project artifact path leaves the project', ErrorCode.PATH_INVALID, {
			projectPath: root,
			filePath: target,
		});
	}

	const realRoot = realpathSync(root);
	let current = realRoot;
	for (const component of relative.split(path.sep)) {
		if (!component) continue;
		current = path.join(current, component);
		try {
			if (lstatSync(current).isSymbolicLink()) {
				throw new AppError(
					'Refusing a symlink in a project artifact path',
					ErrorCode.PATH_INVALID,
					{
						filePath: target,
					}
				);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	}
	return target;
}

export async function readProjectTextFile(
	projectPath: string,
	filePath: string,
	options: { maxBytes: number; optional?: boolean }
): Promise<string | undefined> {
	if (
		!Number.isSafeInteger(options.maxBytes) ||
		options.maxBytes < 0 ||
		options.maxBytes > 64 * 1024 * 1024
	)
		throw new AppError('Invalid project artifact byte limit', ErrorCode.INVALID_INPUT);
	const target = assertProjectArtifactPath(projectPath, filePath);
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(target, PROJECT_ARTIFACT_READ_FLAGS);
		const stat = await handle.stat();
		if (
			!stat.isFile() ||
			!Number.isSafeInteger(stat.size) ||
			stat.size < 0 ||
			stat.size > options.maxBytes
		) {
			throw new AppError(
				'Project artifact is not a supported regular file',
				ErrorCode.DOCUMENT_INVALID,
				{
					filePath: target,
					size: stat.size,
					maxBytes: options.maxBytes,
				}
			);
		}
		if (process.platform === 'win32' || !fsConstants.O_NOFOLLOW) {
			const entry = await fs.lstat(target, { bigint: true });
			const identity = await handle.stat({ bigint: true });
			if (
				entry.isSymbolicLink() ||
				!entry.isFile() ||
				!identity.isFile() ||
				entry.ino !== identity.ino
			) {
				throw new AppError(
					'Project artifact changed while opening',
					ErrorCode.PATH_INVALID,
					{
						filePath: target,
					}
				);
			}
		}
		const buffer = Buffer.alloc(stat.size + 1);
		let count = 0;
		while (count < buffer.length) {
			const read = await handle.read(buffer, count, buffer.length - count, count);
			if (!read.bytesRead) break;
			count += read.bytesRead;
		}
		const final = await handle.stat();
		if (count !== stat.size || final.size !== stat.size || final.mtimeMs !== stat.mtimeMs) {
			throw new AppError('Project artifact changed during read', ErrorCode.IO_ERROR, {
				filePath: target,
			});
		}
		const bytes = buffer.subarray(0, count);
		const text = bytes.toString('utf8');
		if (!Buffer.from(text, 'utf8').equals(bytes)) {
			throw new AppError('Project artifact is not valid UTF-8', ErrorCode.INVALID_FORMAT, {
				filePath: target,
			});
		}
		return text;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT' && options.optional)
			return undefined;
		throw error;
	} finally {
		await handle?.close();
	}
}

export function getDocumentPath(projectPath: string, documentId: string): string {
	validateInput(
		{ documentId },
		{
			documentId: {
				type: 'string',
				required: true,
				custom: (id: unknown) => {
					if (typeof id !== 'string') return 'Document ID must be a string';
					// Allow simple test IDs in test environment
					if (process.env.NODE_ENV === 'test' && /^[a-zA-Z0-9_-]+$/.test(id as string)) {
						return true;
					}
					return isValidScrivenerDocumentId(id) || 'Invalid document ID';
				},
			},
		}
	);

	return buildPath(projectPath, 'Files', 'Data', documentId, 'content.rtf');
}

export function getSynopsisPath(projectPath: string, documentId: string): string {
	return buildPath(projectPath, 'Files', 'Data', documentId, 'synopsis.txt');
}

export function getNotesPath(projectPath: string, documentId: string): string {
	return buildPath(projectPath, 'Files', 'Data', documentId, 'notes.rtf');
}

export function getDocumentPaths(
	projectPath: string,
	documentId: string
): {
	content: string;
	synopsis: string;
	notes: string;
	directory: string;
	comments: string;
} {
	if (!projectPath) {
		throw new AppError('Project path is required', ErrorCode.INVALID_INPUT);
	}

	const directory = buildPath(projectPath, 'Files', 'Data', documentId);

	// Note: snapshots are NOT under Files/Data/<uuid>; they live in the package's
	// top-level Snapshots/<uuid>.snapshots/ directory (see services/snapshots.ts).
	return {
		content: buildPath(directory, 'content.rtf'),
		synopsis: buildPath(directory, 'synopsis.txt'),
		notes: buildPath(directory, 'notes.rtf'),
		directory,
		comments: buildPath(directory, 'comments.xml'),
	};
}

export function generateScrivenerUUID(): string {
	return crypto.randomUUID().toUpperCase();
}

export function isScrivenerUUID(id: string): boolean {
	// Use common utility - Scrivener UUIDs are standard UUIDs
	return isValidUUID(id);
}

export function isScrivenerNumericId(id: string): boolean {
	return /^\d+$/.test(id);
}

export function isValidScrivenerDocumentId(id: string): boolean {
	// Use common utility with numeric ID support
	return isValidUUID(id, { allowNumeric: true });
}

const binderCache = new Map<string, BinderItem>();

export function findBinderItem(
	container: BinderContainer | undefined,
	documentId: string,
	useCache = true
): BinderItem | null {
	if (useCache && binderCache.has(documentId)) {
		return binderCache.get(documentId)!;
	}

	if (!container || !container.BinderItem) {
		return null;
	}

	const items = Array.isArray(container.BinderItem)
		? container.BinderItem
		: [container.BinderItem];

	for (const item of items) {
		if (item.UUID === documentId) {
			if (useCache) {
				binderCache.set(documentId, item);
				if (binderCache.size > 1000) {
					const keysToDelete = [...binderCache.keys()].slice(0, 500);
					for (const key of keysToDelete) {
						binderCache.delete(key);
					}
				}
			}
			return item;
		}

		// Recursively search children
		if (item.Children) {
			const found = findBinderItem(item.Children, documentId, useCache);
			if (found) {
				return found;
			}
		}
	}

	return null;
}

export function clearBinderCache(): void {
	binderCache.clear();
}

/**
 * Traverse binder and apply callback to each item
 */
export function traverseBinder(
	container: BinderContainer | undefined,
	callback: (item: BinderItem, depth: number, parent?: BinderItem) => void,
	depth = 0,
	parent?: BinderItem
): void {
	if (!container || !container.BinderItem) {
		return;
	}

	const items = Array.isArray(container.BinderItem)
		? container.BinderItem
		: [container.BinderItem];

	for (const item of items) {
		callback(item, depth, parent);

		if (item.Children) {
			traverseBinder(item.Children, callback, depth + 1, item);
		}
	}
}

export function flattenBinder(container: BinderContainer | undefined): BinderItem[] {
	const items: BinderItem[] = [];

	traverseBinder(container, (item) => {
		items.push(item);
	});

	return items;
}

export function findBinderParent(
	container: BinderContainer | undefined,
	documentId: string
): BinderItem | null {
	let foundParent: BinderItem | null = null;

	traverseBinder(container, (item, _depth, parent) => {
		if (item.UUID === documentId && parent) {
			foundParent = parent;
		}
	});

	return foundParent;
}

/**
 * Get binder path (breadcrumb) for an item
 * Uses a single traversal to build a parent map instead of O(n^2) repeated searches.
 */
export function getBinderPath(
	container: BinderContainer | undefined,
	documentId: string
): BinderItem[] {
	if (!container) return [];

	const parentMap = new Map<string, BinderItem>();
	traverseBinder(container, (item, _depth, parent) => {
		if (item.UUID && parent) {
			parentMap.set(item.UUID, parent);
		}
	});

	const path: BinderItem[] = [];
	let current = findBinderItem(container, documentId);

	while (current) {
		path.unshift(current);
		const currentUUID = current.UUID;
		if (!currentUUID) break;
		current = parentMap.get(currentUUID) || null;
	}

	return path;
}

export function findMetadataField(
	metadataItems: MetaDataItem[] | MetaDataItem | undefined,
	fieldId: string
): MetaDataItem | undefined {
	if (!metadataItems) {
		return undefined;
	}

	const items = Array.isArray(metadataItems) ? metadataItems : [metadataItems];
	return items.find((item) => (item.FieldID ?? item.ID ?? item.id) === fieldId);
}

export function getMetadataValue(
	metadataItems: MetaDataItem[] | MetaDataItem | undefined,
	fieldId: string
): string | undefined {
	const item = findMetadataField(metadataItems, fieldId);
	return item?.Value;
}

export function parseMetadata(
	metadataItems: MetaDataItem[] | MetaDataItem | string | undefined
): Record<string, string> {
	const metadata = new Map<string, string>();

	if (!metadataItems) {
		return {};
	}

	if (typeof metadataItems === 'string') {
		const lines = metadataItems.split('\n');
		for (const line of lines) {
			const colonIndex = line.indexOf(':');
			if (colonIndex !== -1) {
				const key = line.substring(0, colonIndex).trim();
				const value = line.substring(colonIndex + 1).trim();
				if (key) {
					metadata.set(key, value);
				}
			}
		}
		return Object.fromEntries(metadata);
	}

	const items = Array.isArray(metadataItems) ? metadataItems : [metadataItems];

	for (const item of items) {
		const fieldId = item.FieldID ?? item.ID ?? item.id;
		if (typeof fieldId === 'string' && fieldId && typeof item.Value === 'string') {
			metadata.set(fieldId, item.Value);
		}
	}

	return Object.fromEntries(metadata);
}

export function buildMetadataItems(metadata: Record<string, string | undefined>): MetaDataItem[] {
	const items: MetaDataItem[] = [];

	for (const [fieldId, value] of Object.entries(metadata)) {
		if (value !== undefined) {
			items.push({
				FieldID: fieldId,
				Value: value,
			});
		}
	}

	return items;
}

export function getDocumentType(typeCode?: string): 'Text' | 'Folder' | 'Other' {
	switch (typeCode) {
		case DOCUMENT_TYPES.TEXT:
		case 'Document':
			return DOCUMENT_TYPES.TEXT;
		case DOCUMENT_TYPES.FOLDER:
		case 'DraftFolder':
		case 'ResearchFolder':
		case 'TrashFolder':
			return DOCUMENT_TYPES.FOLDER;
		default:
			return DOCUMENT_TYPES.OTHER;
	}
}

export function isFolderType(type?: string): boolean {
	return type !== undefined && (Object.values(SCRIVENER_FOLDERS) as string[]).includes(type);
}

export function isInTrash(item: BinderItem): boolean {
	if (!item) return false;

	return item.Type === SCRIVENER_FOLDERS.TRASH || item.Title === 'Trash' || item.UUID === 'Trash';
}

export function shouldIncludeInCompile(item: BinderItem): boolean {
	if (item.MetaData?.IncludeInCompile === 'No') {
		return false;
	}

	// Exclude trash items
	if (isInTrash(item)) {
		return false;
	}

	// Exclude research folder
	if (item.Type === 'ResearchFolder') {
		return false;
	}

	return true;
}

export function searchBinder(
	container: BinderContainer | undefined,
	predicate: (item: BinderItem) => boolean
): BinderItem[] {
	const results: BinderItem[] = [];

	traverseBinder(container, (item) => {
		if (predicate(item)) {
			results.push(item);
		}
	});

	return results;
}

export function findDocumentsByType(
	container: BinderContainer | undefined,
	type: 'Text' | 'Folder' | 'Other'
): BinderItem[] {
	return searchBinder(container, (item) => getDocumentType(item.Type) === type);
}

export function findDocumentsByTitle(
	container: BinderContainer | undefined,
	searchTerm: string,
	exact = false
): BinderItem[] {
	const term = searchTerm.toLowerCase();

	return searchBinder(container, (item) => {
		const title = item.Title?.toLowerCase() || '';
		return exact ? title === term : title.includes(term);
	});
}

/**
 * Validation schema for document operations
 */
export const documentValidationSchema = {
	documentId: {
		type: 'string' as const,
		required: true,
		custom: (id: unknown) => {
			if (typeof id !== 'string') return 'Document ID must be a string';
			return isValidScrivenerDocumentId(id) || 'Invalid document ID format';
		},
	},
	title: {
		type: 'string' as const,
		required: true,
		minLength: 1,
		maxLength: SCRIVENER_LIMITS.MAX_TITLE_LENGTH,
	},
	content: {
		type: 'string' as const,
		required: false,
		custom: (value: unknown) => {
			if (typeof value === 'string' && value.length > SCRIVENER_LIMITS.MAX_CONTENT_SIZE) {
				return `Content exceeds maximum size of ${formatBytes(SCRIVENER_LIMITS.MAX_CONTENT_SIZE)}`;
			}
			return true;
		},
	},
};

export function validateDocumentInput(input: unknown): void {
	validateInput(input as Record<string, unknown>, documentValidationSchema);
}

export function getBinderStatistics(container: BinderContainer | undefined): {
	totalItems: number;
	folders: number;
	documents: number;
	inTrash: number;
	totalWords: number;
} {
	let totalItems = 0;
	let folders = 0;
	let documents = 0;
	let inTrash = 0;
	let totalWords = 0;

	traverseBinder(container, (item) => {
		totalItems++;

		if (isFolderType(item.Type)) {
			folders++;
		} else if (item.Type === DOCUMENT_TYPES.TEXT || item.Type === 'Document') {
			documents++;
		}

		if (isInTrash(item)) {
			inTrash++;
		}

		const metadata = parseMetadata(item.MetaData?.CustomMetaData?.MetaDataItem);
		const wordCount = parseInt(metadata.WordCount || '0');
		if (!isNaN(wordCount)) {
			totalWords += wordCount;
		}
	});

	return { totalItems, folders, documents, inTrash, totalWords };
}

export function getTextStatistics(item: BinderItem): {
	words: number;
	characters: number;
	paragraphs: number;
} {
	// Text stats are typically in custom metadata
	const metadata = parseMetadata(item.MetaData?.CustomMetaData?.MetaDataItem);
	return {
		words: parseInt(metadata.WordCount || metadata.words || '0'),
		characters: parseInt(metadata.CharCount || metadata.characters || '0'),
		paragraphs: parseInt(metadata.ParagraphCount || metadata.paragraphs || '0'),
	};
}

export function generateSeededUUID(seed: string): string {
	const hash = crypto.createHash('md5').update(seed).digest('hex');

	return [
		hash.substring(0, 8),
		hash.substring(8, 12),
		`4${hash.substring(13, 16)}`,
		((parseInt(hash.substring(16, 17), 16) & 0x3) | 0x8).toString(16) + hash.substring(17, 20),
		hash.substring(20, 32),
	]
		.join('-')
		.toUpperCase();
}

export default {
	// Constants
	SCRIVENER_EXTENSIONS,
	SCRIVENER_FOLDERS,
	SCRIVENER_LIMITS,

	normalizeScrivenerPath,
	getScrivenerProjectName,
	getDefaultScrivxPath,
	findScrivxPath,
	resolveScrivenerProjectPath,

	getDocumentPath,
	getSynopsisPath,
	getNotesPath,
	getDocumentPaths,

	generateScrivenerUUID,
	generateSeededUUID,
	isScrivenerUUID,
	isScrivenerNumericId,
	isValidScrivenerDocumentId,

	findBinderItem,
	clearBinderCache,
	traverseBinder,
	flattenBinder,
	findBinderParent,
	getBinderPath,
	getBinderStatistics,

	findMetadataField,
	getMetadataValue,
	parseMetadata,
	buildMetadataItems,
	getTextStatistics,

	getDocumentType,
	isFolderType,
	isInTrash,
	shouldIncludeInCompile,

	searchBinder,
	findDocumentsByType,
	findDocumentsByTitle,

	// Validation
	documentValidationSchema,
	validateDocumentInput,
};
