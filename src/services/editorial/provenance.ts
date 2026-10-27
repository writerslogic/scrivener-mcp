import { createHash } from 'node:crypto';
import type { SourceDocument, SourcePassage } from './types.js';

export function stableStoryId(...parts: string[]): string {
	return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function storyIdentifier(value: unknown, label: string): string {
	if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) {
		throw new Error(`${label} must be a bounded identifier`);
	}
	return value;
}

export function storyText(value: unknown, label: string, max = 2000): string {
	if (
		typeof value !== 'string' ||
		value.trim().length === 0 ||
		value.length > max ||
		value.includes('\0')
	) {
		throw new Error(`${label} must contain 1 to ${max} characters without null bytes`);
	}
	return value.trim();
}

export function sourcePassage(document: SourceDocument, start: number, end: number): SourcePassage {
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start < 0 ||
		end <= start ||
		end > document.text.length ||
		end - start > 10000
	) {
		throw new Error(
			'Source passage must be a non-empty range of at most 10000 UTF-16 code units within the document'
		);
	}
	return {
		projectId: document.projectId,
		documentId: document.documentId,
		revision: document.revision,
		title: document.title,
		path: document.path,
		start,
		end,
		line: document.text.slice(0, start).split('\n').length,
		quote: document.text.slice(start, end),
	};
}

export function verifyPassage(document: SourceDocument, passage: SourcePassage): SourcePassage {
	if (
		!passage ||
		typeof passage !== 'object' ||
		passage.projectId !== document.projectId ||
		passage.documentId !== document.documentId ||
		passage.revision !== document.revision
	) {
		throw new Error(
			'Source identity or saved revision no longer matches the proposed provenance'
		);
	}
	const canonical = sourcePassage(document, passage.start, passage.end);
	if (canonical.quote !== passage.quote)
		throw new Error('Source quotation does not match the manuscript range');
	return canonical;
}

export function passageState(
	document: SourceDocument | undefined,
	passage: SourcePassage
): 'current' | 'stale' | 'unavailable' {
	if (!document) return 'unavailable';
	if (
		document.revision !== passage.revision ||
		document.text.slice(passage.start, passage.end) !== passage.quote
	)
		return 'stale';
	return 'current';
}
