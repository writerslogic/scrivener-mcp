import type { ScrivenerDocument } from '../types/index.js';

/** Depth-first search for a node by id in a nested binder tree. */
export function findSubtree(nodes: ScrivenerDocument[], id: string): ScrivenerDocument | undefined {
	for (const node of nodes) {
		if (node.id === id) return node;
		if (node.children?.length) {
			const found = findSubtree(node.children, id);
			if (found) return found;
		}
	}
	return undefined;
}

/**
 * Find the Draft/Manuscript folder (BinderItem Type "DraftFolder") — the root of
 * the compilable manuscript. Returns undefined when the project has none (rare;
 * some templates rename or omit it), so callers can fall back to the whole binder.
 */
export function findDraftFolder(nodes: ScrivenerDocument[]): ScrivenerDocument | undefined {
	for (const node of nodes) {
		if ((node.type as string) === 'DraftFolder') return node;
		if (node.children?.length) {
			const found = findDraftFolder(node.children);
			if (found) return found;
		}
	}
	return undefined;
}
