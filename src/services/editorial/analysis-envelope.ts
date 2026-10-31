import { narrativeVersion } from './lens-native.cjs';
import { createHash } from 'node:crypto';
import type { SourceDocument } from './types.js';
import type { NarrativeControls } from './narrative-analysis.js';

export function analysisDigest(value: unknown): string {
	const canonical = (item: unknown): unknown => {
		if (Array.isArray(item)) return item.map(canonical);
		if (item && typeof item === 'object')
			return Object.fromEntries(
				Object.entries(item)
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
					.map(([key, value]) => [key, canonical(value)])
			);
		return item;
	};
	return createHash('sha256')
		.update(JSON.stringify(canonical(value)))
		.digest('hex');
}

const engineVersion = narrativeVersion();

export function analysisEnvelope(
	projectId: string | null,
	kind: 'manuscript' | 'document' | 'annotation',
	documents: Pick<SourceDocument, 'documentId' | 'revision'>[],
	controls: NarrativeControls,
	mode: 'configured' | 'raw' | 'author-evidence' | 'provider' | 'local',
	request: Record<string, unknown> = {},
	sourceFormat: 'saved-rtf' | 'supplied-text' = 'saved-rtf'
) {
	const sourceRevisions = documents.map(({ documentId, revision }) => ({ documentId, revision }));
	return {
		requestId: analysisDigest({
			projectId,
			kind,
			sourceRevisions,
			controls,
			mode,
			request,
			engineVersion,
			...(sourceFormat === 'supplied-text' ? { sourceFormat } : {}),
		}),
		projectId,
		createdAt: new Date().toISOString(),
		scope: { kind, documentIds: documents.map((document) => document.documentId) },
		sourceRevisions,
		sourceFormat,
		engine: {
			name:
				mode === 'provider'
					? 'provider'
					: mode === 'local'
						? 'scrivener-mcp'
						: 'narrative-lens',
			version: mode === 'provider' || mode === 'local' ? null : engineVersion,
			configurationHash: analysisDigest(
				mode === 'raw' || mode === 'local' ? request : (controls.configuration ?? {})
			),
			controlsHash: analysisDigest(controls),
		},
		policy: {
			mode,
			usesSavedProjectControls: mode === 'configured' || mode === 'author-evidence',
			authorIntentionsApplied:
				mode === 'configured' &&
				Object.values(controls.scenes ?? {}).some((scene) => scene.intentions?.length),
			suppressionsApplied:
				mode === 'configured' && Boolean(controls.configuration?.suppressions?.length),
			allowsRawNativeAnalysis: mode === 'raw',
			providerAccess: mode === 'provider',
			mutatesManuscript: false,
			revisionChecked: false,
		},
	};
}

export type AnalysisEnvelope = ReturnType<typeof analysisEnvelope>;
