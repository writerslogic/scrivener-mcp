import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectLoader } from '../project-loader.js';
import { DocumentTree } from '../document-tree.js';
import { RTFHandler } from '../parsers/rtf-handler.js';
import { getDocumentPath } from '../../utils/scrivener-utils.js';
import { findDraftFolder } from '../../utils/binder-tree.js';
import { PersistentStore } from './persistent-store.js';
import { ProjectSource } from './project-source.js';
import type { ManuscriptSource } from './types.js';
import type { ScrivenerDocument } from '../../types/index.js';

export function manuscriptDocuments(tree: ScrivenerDocument[]): ScrivenerDocument[] {
	const flatten = (nodes: ScrivenerDocument[]): ScrivenerDocument[] =>
		nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
	return flatten(findDraftFolder(tree)?.children ?? tree).filter(
		(document) => document.type === 'Text' && document.includeInCompile !== false
	);
}

export function registerProject(store: PersistentStore, source: ManuscriptSource): void {
	const prior = store.get<{ projectPath: string }>('registered-projects', source.projectId);
	if (prior && prior.projectPath !== source.projectPath && existsSync(prior.projectPath))
		throw new Error(
			'This copied project shares an editorial identity with another existing project. Keep the original editorial history separate before registering the copy as a new series project.'
		);
	store.put('registered-projects', source.projectId, {
		projectId: source.projectId,
		projectPath: source.projectPath,
	});
}

export async function resolveRegisteredProject(
	store: PersistentStore,
	projectId: string
): Promise<ManuscriptSource | undefined> {
	const record = store.get<{ projectId: string; projectPath: string }>(
		'registered-projects',
		projectId
	);
	if (!record) return undefined;
	const file = join(record.projectPath, '.scrivener-mcp', 'editorial.sqlite');
	if (!existsSync(file)) return undefined;
	const projectStore = new PersistentStore(file);
	try {
		if (projectStore.get<string>('identity', 'project') !== projectId) return undefined;
		const loader = new ProjectLoader(record.projectPath);
		const rtf = new RTFHandler();
		const source = new ProjectSource(
			record.projectPath,
			projectStore,
			async () => {
				const structure = await loader.loadProject();
				const tree = new DocumentTree(record.projectPath, rtf, () => structure);
				return manuscriptDocuments(await tree.getProjectStructure());
			},
			(id) => readFile(getDocumentPath(record.projectPath, id), 'utf8')
		);
		return source;
	} finally {
		projectStore.close();
	}
}
