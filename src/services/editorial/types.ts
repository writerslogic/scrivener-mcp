export interface SourceDocument {
	projectId: string;
	documentId: string;
	title: string;
	path: string;
	revision: string;
	text: string;
	order: number;
	metadata: Record<string, string>;
}

export interface SourcePassage {
	projectId: string;
	documentId: string;
	revision: string;
	title: string;
	path: string;
	start: number;
	end: number;
	line: number;
	quote: string;
}

export interface SourceScopeOptions {
	scope?: 'draft' | 'all';
	maxDocuments?: number;
	maxCharacters?: number;
}

export interface ManuscriptSource {
	readonly projectId: string;
	readonly projectPath: string;
	list(options?: SourceScopeOptions): Promise<SourceDocument[]>;
	read(documentId: string): Promise<SourceDocument>;
	readMany?(
		documentIds: readonly string[],
		options?: SourceScopeOptions
	): Promise<SourceDocument[]>;
}

export type FactKind = 'character' | 'alias' | 'location' | 'world-rule' | 'chronology';
export type FactConfidence = 'confirmed' | 'inferred' | 'uncertain';

export interface StoryFact {
	id: string;
	scope: { kind: 'project' | 'series'; id: string };
	kind: FactKind;
	subject: string;
	predicate: string;
	value: string;
	confidence: FactConfidence;
	sources: SourcePassage[];
	storyTime?: string;
	intentional?: boolean;
	supersedes?: string;
	updatedAt: string;
}
