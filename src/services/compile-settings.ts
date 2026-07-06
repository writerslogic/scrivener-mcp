/**
 * Reads Scrivener's compile-format definitions (Settings/compile.xml) and the
 * project taxonomy (labels, statuses, collections, section types) from the
 * parsed .scrivx. Scrivener does not publish a schema for these files, so every
 * accessor is defensive: missing, renamed, single-vs-array, and attribute-only
 * shapes all degrade to empty rather than throwing. This surfaces the settings
 * as read-only metadata; it does not attempt to reproduce Scrivener's compile.
 */

import { parseStringPromise } from 'xml2js';

/** A Scrivener label (colored binder tag). */
export interface CompileLabel {
	id: string;
	title: string;
	/** Raw normalized-RGB string as stored ("r g b", each 0..1), if present. */
	color?: string;
	/** `color` converted to `#RRGGBB` for convenience, if parseable. */
	hex?: string;
}

/** A Scrivener status (workflow state; no color in the format). */
export interface CompileStatus {
	id: string;
	title: string;
}

/** A saved collection (Binder, saved search, or arbitrary group). */
export interface ProjectCollection {
	id: string;
	title: string;
	type: string;
	color?: string;
	hex?: string;
}

/** A user-defined section type (Scene, Chapter, Part Heading, ...). */
export interface SectionType {
	id: string;
	name: string;
}

/** One compile format (a named set of section layouts and options). */
export interface CompileFormat {
	id: string;
	font?: string;
	/** Number of section-type → layout assignments this format defines. */
	sectionLayoutCount: number;
	/** True when the format injects default front/back matter. */
	hasFrontMatter: boolean;
}

/** Aggregated, read-only view of a project's compile and taxonomy settings. */
export interface CompileMetadata {
	/** False when Settings/compile.xml is absent or unreadable. */
	hasCompileSettings: boolean;
	/** Default output file type of the last-used compile (e.g. "pdf"). */
	currentFileType?: string;
	options?: {
		removeComments: boolean;
		removeAnnotations: boolean;
	};
	compileFormats: CompileFormat[];
	sectionTypes: SectionType[];
	labels: CompileLabel[];
	statuses: CompileStatus[];
	collections: ProjectCollection[];
}

/** xml2js options matched to the rest of the codebase (see project-loader). */
const PARSE_OPTS = { explicitArray: false, mergeAttrs: true } as const;

/** Coerce xml2js's single-or-array-or-missing shape into a plain array. */
function asArray<T>(value: T | T[] | undefined | null): T[] {
	if (value === undefined || value === null) return [];
	return Array.isArray(value) ? value : [value];
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

/** With mergeAttrs, element text lands on `_`; fall back to a plain string node. */
function textOf(node: unknown): string {
	if (typeof node === 'string') return node;
	const rec = asRecord(node);
	return asString(rec._) ?? '';
}

function isYes(value: unknown): boolean {
	return asString(value)?.toLowerCase() === 'yes';
}

/**
 * Convert Scrivener's normalized-RGB color string ("0.99 0.70 0.73") to
 * `#RRGGBB`. Returns undefined for missing or malformed input.
 */
export function scrivColorToHex(color: string | undefined): string | undefined {
	if (!color) return undefined;
	const parts = color.trim().split(/\s+/);
	if (parts.length < 3) return undefined;
	const channels: string[] = [];
	for (let i = 0; i < 3; i++) {
		const f = Number(parts[i]);
		if (!Number.isFinite(f)) return undefined;
		const clamped = Math.min(1, Math.max(0, f));
		channels.push(
			Math.round(clamped * 255)
				.toString(16)
				.padStart(2, '0')
		);
	}
	return `#${channels.join('')}`;
}

/**
 * Parse Settings/compile.xml. Returns just the compile-format portion of the
 * metadata; taxonomy comes from the .scrivx (see extractProjectTaxonomy).
 * Never throws on malformed XML shape — only a genuinely unparseable document
 * rejects, which the caller treats as "no compile settings".
 */
export async function parseCompileXml(xml: string): Promise<{
	currentFileType?: string;
	options: { removeComments: boolean; removeAnnotations: boolean };
	compileFormats: CompileFormat[];
}> {
	const parsed = asRecord(await parseStringPromise(xml, PARSE_OPTS));
	const root = asRecord(parsed.CompileSettings);
	const projectSettings = asRecord(root.ProjectSettings);
	const options = asRecord(projectSettings.Options);

	const formats = asArray(asRecord(root.FormatSettings).Format).map((raw): CompileFormat => {
		const fmt = asRecord(raw);
		const layouts = asArray(asRecord(fmt.SectionLayouts).Type);
		return {
			id: asString(fmt.ID) ?? '',
			font: asString(fmt.Font),
			sectionLayoutCount: layouts.length,
			hasFrontMatter: 'FrontAndBackMatter' in fmt,
		};
	});

	return {
		currentFileType: asString(root.CurrentFileType),
		options: {
			removeComments: isYes(options.RemoveComments),
			removeAnnotations: isYes(options.RemoveAnnotations),
		},
		compileFormats: formats,
	};
}

/**
 * Extract labels, statuses, collections, and section types from an
 * already-parsed .scrivx `ScrivenerProject` object. Defensive throughout: any
 * missing branch yields an empty list.
 */
export function extractProjectTaxonomy(scrivenerProject: unknown): {
	labels: CompileLabel[];
	statuses: CompileStatus[];
	collections: ProjectCollection[];
	sectionTypes: SectionType[];
} {
	const project = asRecord(scrivenerProject);

	const labels = asArray(asRecord(asRecord(project.LabelSettings).Labels).Label).map(
		(raw): CompileLabel => {
			const label = asRecord(raw);
			const color = asString(label.Color);
			return {
				id: asString(label.ID) ?? '',
				title: textOf(label),
				color,
				hex: scrivColorToHex(color),
			};
		}
	);

	const statuses = asArray(asRecord(asRecord(project.StatusSettings).StatusItems).Status).map(
		(raw): CompileStatus => {
			const status = asRecord(raw);
			return { id: asString(status.ID) ?? '', title: textOf(status) };
		}
	);

	const collections = asArray(asRecord(project.Collections).Collection).map(
		(raw): ProjectCollection => {
			const collection = asRecord(raw);
			const color = asString(collection.Color);
			return {
				id: asString(collection.ID) ?? '',
				title: asString(collection.Title) ?? '',
				type: asString(collection.Type) ?? '',
				color,
				hex: scrivColorToHex(color),
			};
		}
	);

	const sectionTypes = asArray(asRecord(asRecord(project.SectionTypes).TypeDefinitions).Type).map(
		(raw): SectionType => {
			const type = asRecord(raw);
			return { id: asString(type.ID) ?? '', name: textOf(type) };
		}
	);

	return { labels, statuses, collections, sectionTypes };
}

/**
 * Merge the taxonomy from the parsed .scrivx with the compile.xml contents
 * (pass undefined when the file is absent) into a single metadata view.
 */
export async function buildCompileMetadata(
	scrivenerProject: unknown,
	compileXml: string | undefined
): Promise<CompileMetadata> {
	const taxonomy = extractProjectTaxonomy(scrivenerProject);

	if (!compileXml) {
		return { hasCompileSettings: false, compileFormats: [], ...taxonomy };
	}

	const compile = await parseCompileXml(compileXml);
	return {
		hasCompileSettings: true,
		currentFileType: compile.currentFileType,
		options: compile.options,
		compileFormats: compile.compileFormats,
		...taxonomy,
	};
}
