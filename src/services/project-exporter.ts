import * as path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { createError, ErrorCode } from '../core/errors.js';
import { safeWriteFile } from '../utils/common.js';
import { findDraftFolder } from '../utils/binder-tree.js';
import type { CompilationService } from './compilation-service.js';
import { exportBinary, type ExportSection } from './export/manuscript-exporters.js';
import {
	EXPORT_PRESETS,
	styleCoverage,
	validateExport,
	validatePresetOptions,
	type PresetOptions,
	type ExportFinding,
} from './export/export-presets.js';
import { RTFHandler } from './parsers/rtf-handler.js';
import type { CompileMetadata } from './compile-settings.js';
import type { ExportOptions, ScrivenerDocument, ScrivenerMetadata } from '../types/index.js';

function withoutExportNotes(raw: string): string {
	const ranges: Array<{ start: number; end: number }> = [];
	const opened = new Map<string, number>();
	for (let index = 0; index < raw.length; index++) {
		if (raw[index] === '\\') {
			index++;
			continue;
		}
		if (raw[index] !== '{') continue;
		const marker = /^\{(?:\\\*)?\\Scrv_(annot|comm|inl|fn)(_end)?\b/.exec(
			raw.slice(index, index + 64)
		);
		if (!marker) continue;
		if (!marker[2]) {
			opened.set(marker[1], index);
			continue;
		}
		const start = opened.get(marker[1]);
		if (start === undefined) continue;
		let end = index + marker[0].length;
		while (end < raw.length && raw[end] !== '}') end++;
		if (end < raw.length) ranges.push({ start, end: end + 1 });
		opened.delete(marker[1]);
	}
	const merged: Array<{ start: number; end: number }> = [];
	for (const range of ranges.sort((left, right) => left.start - right.start)) {
		const prior = merged[merged.length - 1];
		if (prior && range.start <= prior.end) prior.end = Math.max(prior.end, range.end);
		else merged.push({ ...range });
	}
	for (const range of merged.reverse()) raw = raw.slice(0, range.start) + raw.slice(range.end);
	return raw;
}

export class ProjectExporter {
	constructor(
		private readonly compilationService: CompilationService,
		private readonly getProjectStructure: () => Promise<ScrivenerDocument[]>,
		private readonly getProjectMetadata: () => Promise<ScrivenerMetadata>,
		private readonly readDocument: (documentId: string) => Promise<string>,
		private readonly projectPath?: string,
		private readonly readRaw?: (documentId: string) => Promise<string>,
		private readonly getCompileMetadata?: () => Promise<CompileMetadata>
	) {}

	async exportProject(
		format: string,
		outputPath?: string,
		options?: Partial<ExportOptions>
	): Promise<unknown> {
		if (options?.preset)
			return this.exportPreset({ ...options, preset: options.preset }, outputPath);
		if (format === 'docx' || format === 'epub' || format === 'pdf') {
			const sections = await this.gatherManuscriptSections();
			const meta = await this.getProjectMetadata();
			const buffer = await exportBinary(format, sections, {
				title: meta.title || 'Untitled',
				author: meta.author,
			});
			const validation = await validateExport(buffer, format);
			const filePath = await this.writeExportFile(buffer, format, outputPath, meta.title);
			return {
				format,
				path: filePath,
				bytes: buffer.length,
				metadata: {
					exportDate: new Date().toISOString(),
					format,
					documentCount: sections.filter((s) => !s.isFolder).length,
					validation,
				},
			};
		}
		if (format !== 'markdown' && format !== 'html' && format !== 'json')
			throw createError(
				ErrorCode.INVALID_INPUT,
				undefined,
				`Unsupported export format: ${format}`
			);
		return this.compilationService.exportProject(
			await this.hydrateTextDocuments(await this.getProjectStructure()),
			format,
			options
		);
	}

	private async hydrateTextDocuments(
		documents: ScrivenerDocument[]
	): Promise<ScrivenerDocument[]> {
		const hydrated: ScrivenerDocument[] = [];
		for (const document of documents) {
			const copy = { ...document };
			if (document.type === 'Text') copy.content = await this.readDocument(document.id);
			if (document.children)
				copy.children = await this.hydrateTextDocuments(document.children);
			hydrated.push(copy);
		}
		return hydrated;
	}

	async preflight(options: PresetOptions): Promise<{
		preset: string;
		format: 'docx' | 'epub';
		documentIds: string[];
		findings: ExportFinding[];
		ready: boolean;
	}> {
		const { sections, findings } = await this.prepare(options);
		return {
			preset: options.preset,
			format: EXPORT_PRESETS[options.preset].format,
			documentIds: sections.flatMap((s) => (s.id && !s.isFolder ? [s.id] : [])),
			findings,
			ready:
				!findings.some((finding) => finding.severity === 'error') &&
				(findings.length === 0 || options.allowWarnings === true),
		};
	}

	async exportPreset(
		options: PresetOptions,
		outputPath?: string
	): Promise<Record<string, unknown>> {
		const { sections, findings } = await this.prepare(options);
		if (
			findings.some((finding) => finding.severity === 'error') ||
			(findings.length && !options.allowWarnings)
		)
			throw new Error(
				'Export preflight requires attention; run preflight and acknowledge supported warnings with allowWarnings'
			);
		const format = EXPORT_PRESETS[options.preset].format;
		const meta = await this.getProjectMetadata();
		const buffer = await exportBinary(format, sections, {
			title: meta.title || 'Untitled',
			author: meta.author,
			preset: options.preset,
		});
		const validation = await validateExport(buffer, format);
		const filePath = await this.writeExportFile(
			buffer,
			format,
			outputPath,
			`${meta.title || 'manuscript'}-${options.preset}`
		);
		return {
			format,
			preset: options.preset,
			path: filePath,
			bytes: buffer.length,
			findings,
			metadata: {
				exportDate: new Date().toISOString(),
				documentCount: sections.filter((s) => !s.isFolder).length,
				validation,
			},
		};
	}

	private async prepare(
		options: PresetOptions
	): Promise<{ sections: ExportSection[]; findings: ExportFinding[] }> {
		validatePresetOptions(options);
		const sections = await this.gatherManuscriptSections(options);
		const findings: ExportFinding[] = styleCoverage(sections);
		if (!sections.some((section) => !section.isFolder))
			findings.push({
				code: 'empty-scope',
				severity: 'error',
				message: 'The selected scope contains no compilable text documents.',
			});
		if (this.readRaw) {
			const rtf = new RTFHandler();
			for (const section of sections) {
				if (!section.id || section.isFolder) continue;
				const raw = await this.readRaw(section.id);
				if (/\\(?:pict|object)\b/.test(raw))
					findings.push({
						code: 'embedded-media',
						severity: 'warning',
						documentId: section.id,
						message:
							'Embedded images and objects are omitted by these text-focused presets.',
					});
				if (/\\footnote\b/.test(raw))
					findings.push({
						code: 'native-footnote',
						severity: 'warning',
						documentId: section.id,
						message:
							'Native RTF footnote anchors cannot be mapped reliably; compile this construct in Scrivener if precise placement is required.',
					});
				if (/\\(?:trowd|field)\b/.test(raw))
					findings.push({
						code: 'complex-layout',
						severity: 'warning',
						documentId: section.id,
						message:
							'Tables and fields are reduced to parsed text; their layout or dynamic behavior is unsupported.',
					});
				const annotations = rtf.preserveScrivenerAnnotations(raw);
				const notes = [...annotations.entries()].filter(
					([key]) => key.startsWith('fn_') || options.includeAnnotations === true
				);
				if (notes.length) {
					section.notes = notes.map(
						([key, text]) =>
							`${key.startsWith('fn_') ? 'Note' : 'Editorial annotation'}: ${text}`
					);
					findings.push({
						code: 'note-placement',
						severity: 'warning',
						documentId: section.id,
						message:
							'Supported Scrivener note markers are exported as labeled notes after their source scene, without native inline anchors.',
					});
				}
			}
		}
		return { sections, findings };
	}

	private async gatherManuscriptSections(options?: PresetOptions): Promise<ExportSection[]> {
		const structure = await this.getProjectStructure();
		const draft = findDraftFolder(structure);
		const sections: ExportSection[] = [];
		const taxonomy = this.getCompileMetadata ? await this.getCompileMetadata() : undefined;
		const selected = options?.documentIds ? new Set(options.documentIds) : undefined;
		const front = new Set(options?.frontMatterIds ?? []);
		const seen = new Set<string>();
		const rtf = new RTFHandler();
		const append = async (
			doc: ScrivenerDocument,
			depth: number,
			frontMatter = false
		): Promise<void> => {
			const isText = doc.type === 'Text';
			if (isText && doc.includeInCompile === false && !frontMatter) return;
			if (isText && selected && !selected.has(doc.id) && !frontMatter) return;
			if (seen.has(doc.id)) return;
			seen.add(doc.id);
			const raw = isText && this.readRaw ? await this.readRaw(doc.id) : undefined;
			const formatted =
				raw !== undefined
					? await rtf.parseRTF(options ? withoutExportNotes(raw) : raw)
					: undefined;
			const name = taxonomy?.sectionTypes
				.find((type) => type.id === doc.sectionTypeId)
				?.name.toLowerCase();
			const sectionType = frontMatter
				? 'front-matter'
				: name?.includes('part')
					? 'part'
					: name?.includes('chapter')
						? 'chapter'
						: !isText
							? 'chapter'
							: 'scene';
			sections.push({
				id: doc.id,
				title: doc.title || 'Untitled',
				text: isText ? (formatted?.plainText ?? (await this.readDocument(doc.id))) : '',
				depth,
				isFolder: !isText,
				sectionType,
				formattedText: formatted?.formattedText,
			});
		};
		const walk = async (docs: ScrivenerDocument[], depth: number): Promise<void> => {
			for (const doc of docs) {
				if (selected && doc.type !== 'Text') {
					const containsSelected = (node: ScrivenerDocument): boolean =>
						selected.has(node.id) || (node.children ?? []).some(containsSelected);
					if (!containsSelected(doc)) continue;
				}
				if (!front.has(doc.id)) await append(doc, depth);
				if (doc.children?.length) await walk(doc.children, depth + 1);
			}
		};
		const flat = (docs: ScrivenerDocument[]): ScrivenerDocument[] =>
			docs.flatMap((doc) => [doc, ...flat(doc.children ?? [])]);
		const all = flat(structure);
		for (const id of front) {
			const doc = all.find((item) => item.id === id && item.type === 'Text');
			if (!doc) throw new Error('Front matter document is outside the active binder');
			await append(doc, 0, true);
		}
		await walk(draft?.children ?? structure, 0);
		if (selected && [...selected].some((id) => !seen.has(id)))
			throw new Error('Export scope contains an unknown or excluded manuscript document');
		return sections;
	}

	private async writeExportFile(
		buffer: Buffer,
		ext: string,
		outputPath: string | undefined,
		title: string | undefined
	): Promise<string> {
		if (outputPath && (outputPath.includes('\0') || outputPath.length > 4096))
			throw createError(ErrorCode.INVALID_INPUT, {}, 'Invalid output path');
		const safeTitle = (title || 'manuscript').replace(/[^\w.-]+/g, '_') || 'manuscript';
		const base = this.projectPath
			? path.join(this.projectPath, '.scrivener-mcp', 'exports')
			: process.cwd();
		const target = outputPath
			? path.resolve(outputPath)
			: path.join(base, `${safeTitle}.${ext}`);
		if (path.extname(target).toLowerCase() !== `.${ext}`)
			throw new Error('Export file extension does not match its format');
		try {
			if ((await lstat(target)).isSymbolicLink())
				throw new Error('Export destination must not be a symlink');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		let existing = path.dirname(target);
		while (true) {
			try {
				await lstat(existing);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
				const parent = path.dirname(existing);
				if (parent === existing)
					throw new Error('Export destination has no accessible parent', {
						cause: error,
					});
				existing = parent;
			}
		}
		const canonicalTarget = path.join(
			await realpath(existing),
			path.relative(existing, target)
		);
		if (this.projectPath) {
			const relative = path.relative(this.projectPath, target);
			const canonicalProject = await realpath(this.projectPath);
			const canonicalRelative = path.relative(canonicalProject, canonicalTarget);
			const inside = (value: string): boolean =>
				value !== '..' && !value.startsWith(`..${path.sep}`) && !path.isAbsolute(value);
			const exportPrefix = `.scrivener-mcp${path.sep}exports${path.sep}`;
			if (inside(canonicalRelative) && !canonicalRelative.startsWith(exportPrefix))
				throw new Error(
					'Export destination resolves inside protected Scrivener project data'
				);
			if (inside(relative) && canonicalRelative !== relative)
				throw new Error('Exports inside a project must not traverse symlink directories');
			if (
				!relative.startsWith(`..${path.sep}`) &&
				relative !== '..' &&
				!path.isAbsolute(relative) &&
				!relative.startsWith(`.scrivener-mcp${path.sep}exports${path.sep}`)
			)
				throw new Error(
					'Exports inside a Scrivener project must use .scrivener-mcp/exports'
				);
		}
		await safeWriteFile(target, buffer);
		return target;
	}
}
