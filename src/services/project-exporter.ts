import { getLogger } from '../core/logger.js';
import * as path from 'path';
import { createError, ErrorCode } from '../core/errors.js';
import { safeWriteFile } from '../utils/common.js';
import type { CompilationService } from './compilation-service.js';
import { exportBinary, type ExportSection } from './export/manuscript-exporters.js';
import type { ExportOptions, ScrivenerDocument, ScrivenerMetadata } from '../types/index.js';

const logger = getLogger('scrivener-project');

/** Binary (docx/epub/pdf) and structured project export. */
export class ProjectExporter {
	constructor(
		private readonly compilationService: CompilationService,
		private readonly getProjectStructure: () => Promise<ScrivenerDocument[]>,
		private readonly getProjectMetadata: () => Promise<ScrivenerMetadata>,
		private readonly readDocument: (documentId: string) => Promise<string>
	) {}

	async exportProject(
		format: string,
		outputPath?: string,
		options?: Partial<ExportOptions>
	): Promise<unknown> {
		if (format === 'docx' || format === 'epub' || format === 'pdf') {
			const sections = await this.gatherManuscriptSections();
			const meta = await this.getProjectMetadata();
			const buffer = await exportBinary(format, sections, {
				title: meta.title || 'Untitled',
				author: meta.author,
			});
			const filePath = await this.writeExportFile(buffer, format, outputPath, meta.title);
			return {
				format,
				path: filePath,
				bytes: buffer.length,
				metadata: {
					exportDate: new Date().toISOString(),
					format,
					documentCount: sections.filter((s) => !s.isFolder).length,
				},
			};
		}

		const structure = await this.getProjectStructure();
		return await this.compilationService.exportProject(structure, format, options);
	}

	/**
	 * Walk the binder in order, reading each text document's content, to build the
	 * ordered manuscript sections the binary exporters consume.
	 */
	private async gatherManuscriptSections(): Promise<ExportSection[]> {
		const structure = await this.getProjectStructure();
		const sections: ExportSection[] = [];

		const walk = async (docs: ScrivenerDocument[], depth: number): Promise<void> => {
			for (const doc of docs) {
				const isText = doc.type === 'Text';
				let text = '';
				if (isText) {
					try {
						text = await this.readDocument(doc.id);
					} catch (error) {
						logger.warn('Skipping unreadable document during export', {
							documentId: doc.id,
							error,
						});
					}
				}
				sections.push({ title: doc.title || 'Untitled', text, depth, isFolder: !isText });
				if (doc.children && doc.children.length > 0) {
					await walk(doc.children, depth + 1);
				}
			}
		};

		await walk(structure, 0);
		return sections;
	}

	/** Resolve the output path (given, or a default in the working directory) and write the export. */
	private async writeExportFile(
		buffer: Buffer,
		ext: string,
		outputPath: string | undefined,
		title: string | undefined
	): Promise<string> {
		if (outputPath && outputPath.includes('\0')) {
			throw createError(ErrorCode.INVALID_INPUT, { outputPath }, 'Invalid output path');
		}
		const safeTitle = (title || 'manuscript').replace(/[^\w.-]+/g, '_') || 'manuscript';
		const target = outputPath
			? path.resolve(outputPath)
			: path.join(process.cwd(), `${safeTitle}.${ext}`);
		await safeWriteFile(target, buffer);
		return target;
	}
}
