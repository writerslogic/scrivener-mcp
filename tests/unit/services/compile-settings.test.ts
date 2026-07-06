/**
 * Locks the compile-settings reader for issue #14 against the real sample
 * project fixture: parses Settings/compile.xml and the .scrivx taxonomy
 * (labels/statuses/collections/section types), and verifies the defensive
 * accessors degrade to empty rather than throwing on missing/garbage input.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseStringPromise } from 'xml2js';
import {
	parseCompileXml,
	extractProjectTaxonomy,
	buildCompileMetadata,
	scrivColorToHex,
} from '../../../src/services/compile-settings.js';

const FIXTURE = path.join(process.cwd(), 'tests', 'sample-project.scriv');

function readFixture(rel: string): string {
	return fs.readFileSync(path.join(FIXTURE, rel), 'utf-8');
}

async function parsedScrivx(): Promise<unknown> {
	const parsed = await parseStringPromise(readFixture('sample-project.scrivx'), {
		explicitArray: false,
		mergeAttrs: true,
	});
	return (parsed as { ScrivenerProject?: unknown }).ScrivenerProject;
}

describe('scrivColorToHex', () => {
	it('converts a normalized-RGB triple to #RRGGBB', () => {
		expect(scrivColorToHex('1 0 0')).toBe('#ff0000');
		expect(scrivColorToHex('0.993495 0.701207 0.732587')).toBe('#fdb3bb');
	});

	it('clamps out-of-range channels', () => {
		expect(scrivColorToHex('2 -1 0.5')).toBe('#ff0080');
	});

	it('returns undefined for missing or malformed input', () => {
		expect(scrivColorToHex(undefined)).toBeUndefined();
		expect(scrivColorToHex('')).toBeUndefined();
		expect(scrivColorToHex('red green blue')).toBeUndefined();
		expect(scrivColorToHex('0.5 0.5')).toBeUndefined();
	});
});

describe('parseCompileXml (fixture)', () => {
	it('reads the current file type and global options', async () => {
		const result = await parseCompileXml(readFixture('Settings/compile.xml'));
		expect(result.currentFileType).toBe('pdf');
		expect(result.options.removeComments).toBe(true);
		expect(result.options.removeAnnotations).toBe(true);
	});

	it('enumerates compile formats with layout counts and front matter', async () => {
		const result = await parseCompileXml(readFixture('Settings/compile.xml'));
		expect(result.compileFormats.length).toBeGreaterThan(5);

		const manuscript = result.compileFormats.find((f) => f.id === 'manuscript-times');
		expect(manuscript).toBeDefined();
		expect(manuscript!.font).toBe('TimesNewRomanPSMT');
		expect(manuscript!.sectionLayoutCount).toBe(9);
		expect(manuscript!.hasFrontMatter).toBe(true);

		const outline = result.compileFormats.find((f) => f.id === 'outline-document');
		expect(outline!.hasFrontMatter).toBe(false);
	});

	it('rejects only genuinely unparseable XML', async () => {
		await expect(parseCompileXml('<not-closed')).rejects.toBeDefined();
	});

	it('tolerates well-formed XML with none of the expected elements', async () => {
		const result = await parseCompileXml('<CompileSettings/>');
		expect(result.compileFormats).toEqual([]);
		expect(result.options.removeComments).toBe(false);
	});
});

describe('extractProjectTaxonomy (fixture)', () => {
	it('extracts labels with colors and hex', async () => {
		const { labels } = extractProjectTaxonomy(await parsedScrivx());
		expect(labels).toContainEqual(
			expect.objectContaining({ id: '7', title: 'Red', hex: '#fdb3bb' })
		);
		// "No Label" has an id but no color.
		const noLabel = labels.find((l) => l.id === '-1');
		expect(noLabel!.title).toBe('No Label');
		expect(noLabel!.hex).toBeUndefined();
	});

	it('extracts statuses (which carry no color)', async () => {
		const { statuses } = extractProjectTaxonomy(await parsedScrivx());
		expect(statuses.map((s) => s.title)).toEqual(
			expect.arrayContaining(['To Do', 'In Progress', 'Done'])
		);
	});

	it('extracts collections with type and section types with names', async () => {
		const taxonomy = extractProjectTaxonomy(await parsedScrivx());
		expect(taxonomy.collections).toContainEqual(
			expect.objectContaining({ title: 'Binder', type: 'Binder' })
		);
		expect(taxonomy.sectionTypes).toContainEqual(expect.objectContaining({ name: 'Scene' }));
	});

	it('returns all-empty lists for a null / non-object project', () => {
		const empty = extractProjectTaxonomy(null);
		expect(empty).toEqual({ labels: [], statuses: [], collections: [], sectionTypes: [] });
	});
});

describe('buildCompileMetadata', () => {
	it('merges compile.xml with taxonomy when the file is present', async () => {
		const meta = await buildCompileMetadata(
			await parsedScrivx(),
			readFixture('Settings/compile.xml')
		);
		expect(meta.hasCompileSettings).toBe(true);
		expect(meta.currentFileType).toBe('pdf');
		expect(meta.compileFormats.length).toBeGreaterThan(0);
		expect(meta.labels.length).toBeGreaterThan(0);
	});

	it('degrades to taxonomy-only when compile.xml is absent', async () => {
		const meta = await buildCompileMetadata(await parsedScrivx(), undefined);
		expect(meta.hasCompileSettings).toBe(false);
		expect(meta.compileFormats).toEqual([]);
		expect(meta.currentFileType).toBeUndefined();
		// Taxonomy still comes through from the .scrivx.
		expect(meta.statuses.length).toBeGreaterThan(0);
	});
});
