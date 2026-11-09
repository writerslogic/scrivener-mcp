import type { SqliteDatabase } from '../../utils/sqlite.js';
import type { ProjectMemory } from '../../memory-manager.js';
import { buildInsertQuery, escapeIdentifier } from '../../utils/database.js';
import { MAX_PROJECT_MEMORY_BYTES as MAX_BYTES } from './project-memory-contract.js';

function json(value: unknown): unknown {
	if (value === null || value === undefined) return undefined;
	if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_BYTES)
		throw new Error('Invalid or oversized project-memory database value');
	try {
		return JSON.parse(value);
	} catch {
		throw new Error('Invalid project-memory database JSON; repair it before opening');
	}
}

function supplied(fields: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(fields).filter(([, value]) => value != null));
}

export function readMemoryDatabase(db: SqliteDatabase): Record<string, unknown> {
	return db.transaction(() => {
		const snapshot = db
			.prepare(
				'SELECT length(CAST(value AS BLOB)) AS bytes, CASE WHEN length(CAST(value AS BLOB)) <= ? THEN value END AS value FROM project_metadata WHERE key = ?'
			)
			.get(MAX_BYTES, 'project_memory') as { bytes: number; value: unknown } | undefined;
		if (snapshot) {
			if (snapshot.bytes > MAX_BYTES)
				throw new Error('Project-memory database snapshot exceeds 16 MiB');
			const value = json(snapshot.value);
			if (!value || typeof value !== 'object' || Array.isArray(value))
				throw new Error('Invalid project-memory database snapshot');
			return value as Record<string, unknown>;
		}
		let remaining = MAX_BYTES;
		let remainingRows = 10000;
		const rows = (table: string, fields: string[]) => {
			const size = db
				.prepare(
					`SELECT COUNT(*) AS count, COALESCE(SUM(${fields.map((field) => `COALESCE(length(CAST(${escapeIdentifier(field)} AS BLOB)), 0)`).join(' + ')}), 0) AS bytes FROM (SELECT * FROM ${escapeIdentifier(table)} LIMIT 10001)`
				)
				.get() as { count: number; bytes: number };
			remaining -= size.bytes;
			remainingRows -= size.count;
			if (remainingRows < 0 || remaining < 0)
				throw new Error(
					'Legacy project memory exceeds its 16 MiB / 10000-row import budget'
				);
			return db
				.prepare(
					`SELECT ${fields.map(escapeIdentifier).join(', ')} FROM ${escapeIdentifier(table)}`
				)
				.all() as Record<string, unknown>[];
		};
		const metadata = rows('project_metadata', ['key', 'value']);
		const memory: Record<string, unknown> = {
			characters: rows('characters', [
				'id',
				'name',
				'role',
				'description',
				'traits',
				'character_arc',
				'relationships',
				'appearances',
				'notes',
			]).map((item) =>
				supplied({
					id: item.id,
					name: item.name,
					role: item.role,
					description: item.description,
					traits: json(item.traits),
					arc: item.character_arc,
					relationships: json(item.relationships),
					appearances: json(item.appearances),
					notes: item.notes,
				})
			),
			plotThreads: rows('plot_threads', [
				'id',
				'name',
				'description',
				'status',
				'documents',
				'notes',
			]).map((item) =>
				supplied({
					id: item.id,
					name: item.name,
					description: item.description,
					status: item.status,
					documents: json(item.documents),
					notes: item.notes,
				})
			),
			worldBuilding: [
				...rows('themes', [
					'id',
					'name',
					'description',
					'importance',
					'documents',
					'notes',
				]).map((item) =>
					supplied({ ...item, type: 'theme', documents: json(item.documents) })
				),
				...rows('locations', [
					'id',
					'name',
					'description',
					'type',
					'significance',
					'first_appearance',
				]).map((item) => supplied({ ...item, type: 'location', locationType: item.type })),
			],
			customContext: Object.fromEntries(
				metadata
					.filter(
						(item) => typeof item.key === 'string' && item.key.startsWith('custom_')
					)
					.map((item) => [
						(item.key as string).slice(7),
						item.value === null ? null : json(item.value),
					])
			),
		};
		for (const [key, field] of [
			['style_guide', 'styleGuide'],
			['writing_stats', 'writingStats'],
		]) {
			const item = metadata.find((entry) => entry.key === key);
			if (item?.value != null) memory[field] = json(item.value);
		}
		return memory;
	})();
}

export function mirrorMemoryDatabase(
	db: SqliteDatabase,
	memory: ProjectMemory,
	serialized: string
): void {
	db.transaction(() => {
		const upsert = (table: string, key: string, data: Record<string, unknown>) => {
			const insert = Object.fromEntries(
				Object.entries(data).map(([field, value]) => [field, value ?? null])
			);
			const { sql, params } = buildInsertQuery(table, insert);
			const updates = Object.keys(data)
				.filter((field) => field !== key && data[field] !== undefined)
				.map((field) => `${escapeIdentifier(field)} = excluded.${escapeIdentifier(field)}`)
				.join(', ');
			db.prepare(`${sql} ON CONFLICT(${escapeIdentifier(key)}) DO UPDATE SET ${updates}`).run(
				...params
			);
		};
		for (const character of memory.characters)
			upsert('characters', 'id', {
				id: character.id,
				name: character.name,
				role: character.role,
				description: character.description,
				traits: JSON.stringify(character.traits),
				character_arc: character.arc,
				relationships: JSON.stringify(character.relationships),
				appearances: JSON.stringify(character.appearances),
				notes: character.notes,
			});
		for (const plot of memory.plotThreads)
			upsert('plot_threads', 'id', {
				id: plot.id,
				name: plot.name,
				status: plot.status,
				description: plot.description,
				documents: JSON.stringify(plot.documents),
			});
		for (const element of memory.worldBuilding) {
			if (element.type === 'location')
				upsert('locations', 'id', {
					id: element.id,
					name: element.name,
					description: element.description,
					significance: element.significance,
				});
			else if (element.type === 'theme')
				upsert('themes', 'id', {
					id: element.id,
					name: element.name,
					description: element.description,
				});
		}
		const metadata = {
			style_guide: JSON.stringify(memory.styleGuide),
			writing_stats: JSON.stringify(memory.writingStats),
			...Object.fromEntries(
				Object.entries(memory.customContext).map(([key, value]) => [
					`custom_${key}`,
					JSON.stringify(value),
				])
			),
			project_memory: serialized,
		};
		for (const [key, value] of Object.entries(metadata))
			upsert('project_metadata', 'key', { key, value, updated_at: memory.lastUpdated });
	})();
}
