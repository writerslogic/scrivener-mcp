import { dashboardHandler } from '../../../src/handlers/dashboard-handlers.js';
import type { HandlerContext } from '../../../src/handlers/types.js';
import type { EditorialServices } from '../../../src/scrivener-project.js';
import type { SourceDocument, StoryFact } from '../../../src/services/editorial/types.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const DOCUMENT = '22222222-2222-4222-8222-222222222222';
const REVISION = 'a'.repeat(64);
const nativeExec = RegExp.prototype.exec;

interface Appearance {
	name: string;
	mentions: Array<{ start: number; end: number; quote: string }>;
	truncated: boolean;
}
interface Dashboard {
	scenes: Array<{ documentId: string; revision: string; appearances: Appearance[] }>;
}

async function appearances(text: string, names: string[]): Promise<Dashboard> {
	const document: SourceDocument = {
		projectId: PROJECT,
		documentId: DOCUMENT,
		title: 'Unicode scene',
		path: 'Manuscript/Unicode scene',
		revision: REVISION,
		text,
		order: 0,
		metadata: {},
	};
	const facts: StoryFact[] = names.map((name, index) => ({
		id: `character-${index}`,
		scope: { kind: 'project', id: PROJECT },
		kind: 'character',
		subject: name,
		predicate: 'name',
		value: name,
		confidence: 'inferred',
		sources: [],
		updatedAt: '2026-10-29T00:00:00.000Z',
	}));
	const services = {
		source: { projectId: PROJECT, list: async () => [document] },
		bible: { listFacts: async () => facts },
		continuity: { listPage: () => ({ items: [], nextCursor: null }) },
		review: {
			history: () => ({
				proposals: [],
				applications: [],
				pagination: { proposals: null, applications: null },
			}),
		},
	} as unknown as EditorialServices;
	const context = {
		project: {
			title: 'Synthetic dashboard fixture',
			getEditorialServices: () => services,
			getProjectMetadata: async () => ({ title: 'Synthetic dashboard fixture' }),
			getProjectStructure: async () => [
				{ id: DOCUMENT, title: document.title, type: 'Text', path: document.path },
			],
		},
		memoryManager: null,
	} as unknown as HandlerContext;
	const result = await dashboardHandler.handler({}, context);
	return result.structuredContent as unknown as Dashboard;
}

afterEach(() => {
	jest.restoreAllMocks();
});

test.each([0, 99, 100, 101, 10000])(
	'preserves the first 100 Unicode name locations with bounded matching for %d occurrences',
	async (count) => {
		const name = '伊織 Élodie';
		const prefix = '😀 ';
		const fragment = `${prefix}${name} 😃\n`;
		const text = fragment.repeat(count);
		let scans = 0;
		jest.spyOn(RegExp.prototype, 'exec').mockImplementation(function (
			this: RegExp,
			value: string
		) {
			if (
				value === text &&
				this.flags === 'giu' &&
				this.source.startsWith('(?<![\\p{L}\\p{N}_])')
			)
				scans++;
			return nativeExec.call(this, value);
		});
		const result = await appearances(text, [name]);
		expect(scans).toBe(Math.min(count + 1, 101));
		expect(result.scenes[0]).toMatchObject({ documentId: DOCUMENT, revision: REVISION });
		if (count === 0) {
			expect(result.scenes[0].appearances).toEqual([]);
			return;
		}
		const appearance = result.scenes[0].appearances[0];
		expect(appearance.name).toBe(name);
		expect(appearance.truncated).toBe(count > 100);
		expect(appearance.mentions).toHaveLength(Math.min(count, 100));
		for (const [index, mention] of appearance.mentions.entries()) {
			expect(mention.start).toBe(index * fragment.length + prefix.length);
			expect(mention.end).toBe(mention.start + name.length);
			expect(text.slice(mention.start, mention.end)).toBe(name);
			expect(mention.quote).toContain(name);
			expect(text).toContain(mention.quote);
			expect(mention.quote.length).toBeLessThanOrEqual(name.length + 160);
		}
	}
);

test('escapes name syntax, honors Unicode word boundaries and retains case-insensitive literal matches', async () => {
	const name = 'Élodie(東京)+';
	const prefix = `前${name}後\n`;
	const text = `${prefix}${name}\n${name.toUpperCase()}\nÉlodie東京\n`;
	const result = await appearances(text, [name]);
	const appearance = result.scenes[0].appearances[0];
	expect(appearance.truncated).toBe(false);
	expect(appearance.mentions.map(({ start, end }) => ({ start, end }))).toEqual([
		{ start: prefix.length, end: prefix.length + name.length },
		{ start: prefix.length + name.length + 1, end: prefix.length + 2 * name.length + 1 },
	]);
});
