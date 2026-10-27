import JSZip from 'jszip';
import { parseStringPromise } from 'xml2js';
import { posix } from 'node:path';
import type { ExportSection } from './manuscript-exporters.js';

export type ExportPreset = 'submission-manuscript' | 'beta-reader' | 'ebook';

export interface PresetOptions {
	preset: ExportPreset;
	documentIds?: string[];
	frontMatterIds?: string[];
	includeAnnotations?: boolean;
	allowWarnings?: boolean;
}

export interface ExportFinding {
	code: string;
	severity: 'warning' | 'error';
	documentId?: string;
	message: string;
}

export const EXPORT_PRESETS = {
	'submission-manuscript': {
		format: 'docx',
		font: 'Times New Roman',
		fontSize: 24,
		line: 480,
		paragraphAfter: 0,
		firstLine: 720,
	},
	'beta-reader': {
		format: 'docx',
		font: 'Calibri',
		fontSize: 24,
		line: 360,
		paragraphAfter: 120,
		firstLine: 0,
	},
	ebook: {
		format: 'epub',
		font: 'serif',
		fontSize: 24,
		line: 240,
		paragraphAfter: 120,
		firstLine: 0,
	},
} as const;

export function validatePresetOptions(options: PresetOptions): void {
	if (!options || !Object.prototype.hasOwnProperty.call(EXPORT_PRESETS, options.preset))
		throw new Error('Unknown manuscript export preset');
	for (const ids of [options.documentIds, options.frontMatterIds]) {
		if (
			ids !== undefined &&
			(!Array.isArray(ids) ||
				ids.length > 10000 ||
				ids.some((id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) ||
				new Set(ids).size !== ids.length)
		)
			throw new Error('Export scope must contain unique document UUIDs (maximum 10000)');
	}
	for (const flag of [options.includeAnnotations, options.allowWarnings]) {
		if (flag !== undefined && typeof flag !== 'boolean')
			throw new Error('Export flags must be boolean');
	}
}

function values(value: unknown): Record<string, unknown>[] {
	return (Array.isArray(value) ? value : value ? [value] : []) as Record<string, unknown>[];
}

export async function validateExport(
	buffer: Buffer,
	format: 'docx' | 'epub' | 'pdf'
): Promise<string[]> {
	if (buffer.length > 128 * 1024 * 1024)
		throw new Error('Export exceeds the validation size limit');
	if (format === 'pdf') {
		if (buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error('Invalid generated PDF');
		return ['PDF signature'];
	}
	const zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
	const read = async (name: string): Promise<string> => {
		const file = zip.file(name);
		if (!file) throw new Error(`Generated archive is missing ${name}`);
		return file.async('string');
	};
	if (format === 'docx') {
		await parseStringPromise(await read('[Content_Types].xml'));
		await parseStringPromise(await read('word/document.xml'));
		await parseStringPromise(await read('word/styles.xml'));
		return ['ZIP CRC', 'OOXML content types', 'document XML', 'styles XML'];
	}
	if ((await read('mimetype')) !== 'application/epub+zip')
		throw new Error('Invalid EPUB mimetype');
	if (buffer.readUInt16LE(8) !== 0 || buffer.subarray(30, 38).toString() !== 'mimetype')
		throw new Error('EPUB mimetype must be the first uncompressed ZIP entry');
	const container = await parseStringPromise(await read('META-INF/container.xml'), {
		explicitArray: false,
	});
	const rootfile = container.container?.rootfiles?.rootfile?.$?.['full-path'] as
		string | undefined;
	if (!rootfile || rootfile.startsWith('/') || rootfile.includes('..'))
		throw new Error('Invalid EPUB package location');
	const packageXml = await parseStringPromise(await read(rootfile), { explicitArray: false });
	const pkg = packageXml.package;
	if (!pkg?.metadata || !pkg.manifest || !pkg.spine)
		throw new Error('EPUB metadata, manifest or spine is missing');
	const items = values(pkg.manifest.item);
	const ids = new Set<string>();
	for (const item of items) {
		const attrs = item.$ as Record<string, string>;
		if (!attrs?.id || ids.has(attrs.id) || !attrs.href)
			throw new Error('Invalid EPUB manifest item');
		ids.add(attrs.id);
		const location = posix.normalize(
			posix.join(posix.dirname(rootfile), decodeURIComponent(attrs.href))
		);
		if (location.startsWith('../') || location.startsWith('/'))
			throw new Error('Invalid EPUB manifest path');
		const content = await read(location);
		if (attrs['media-type'] === 'application/xhtml+xml') await parseStringPromise(content);
	}
	const spine = values(pkg.spine.itemref);
	if (!spine.length || spine.some((item) => !ids.has((item.$ as Record<string, string>)?.idref)))
		throw new Error('EPUB spine contains an invalid reference');
	return [
		'ZIP CRC',
		'first stored mimetype',
		'container XML',
		'package metadata',
		'manifest resources',
		'spine references',
		'XHTML syntax',
	];
}

export function styleCoverage(sections: ExportSection[]): ExportFinding[] {
	return sections.flatMap((section) =>
		section.formattedText?.length &&
		section.formattedText.map((run) => run.text).join('') !== section.text
			? [
					{
						code: 'style-alignment',
						severity: 'warning' as const,
						documentId: section.id,
						message:
							'Parsed formatting runs do not align with the saved text; this section will use the preset body style.',
					},
				]
			: []
	);
}
