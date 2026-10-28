import { createHash } from 'node:crypto';
import type { SourceDocument, SourcePassage } from './types.js';

export function sourceKey(source: Pick<SourcePassage, 'projectId' | 'documentId'>): string {
	return JSON.stringify([source.projectId, source.documentId]);
}

export function passageKey(passage: SourcePassage): string {
	return JSON.stringify([
		passage.projectId,
		passage.documentId,
		passage.revision,
		passage.start,
		passage.end,
	]);
}

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

function validPassageRange(text: string, start: number, end: number): boolean {
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start < 0 ||
		end <= start ||
		end > text.length ||
		end - start > 10000
	)
		return false;
	return [start, end].every((offset) => {
		const previous = text.charCodeAt(offset - 1);
		const current = text.charCodeAt(offset);
		return !(
			previous >= 0xd800 &&
			previous <= 0xdbff &&
			current >= 0xdc00 &&
			current <= 0xdfff
		);
	});
}

export function sourcePassage(document: SourceDocument, start: number, end: number): SourcePassage {
	if (!validPassageRange(document.text, start, end)) {
		throw new Error(
			'Source passage must be a non-empty range of at most 10000 UTF-16 code units within the document without splitting a Unicode character'
		);
	}
	let line = 1;
	for (
		let newline = document.text.indexOf('\n');
		newline >= 0 && newline < start;
		newline = document.text.indexOf('\n', newline + 1)
	)
		line++;
	return {
		projectId: document.projectId,
		documentId: document.documentId,
		revision: document.revision,
		title: document.title,
		path: document.path,
		start,
		end,
		line,
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
		document.projectId !== passage.projectId ||
		document.documentId !== passage.documentId ||
		document.revision !== passage.revision ||
		!validPassageRange(document.text, passage.start, passage.end) ||
		document.text.slice(passage.start, passage.end) !== passage.quote
	)
		return 'stale';
	return 'current';
}
