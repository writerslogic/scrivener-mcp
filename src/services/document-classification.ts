import { ApplicationError, ErrorCode } from '../core/errors.js';
import type { BinderMetaData, NativeNamedItem, ProjectStructure } from '../types/internal.js';
import { extractProjectTaxonomy } from './compile-settings.js';

type Project = NonNullable<ProjectStructure['ScrivenerProject']>;
type Classification = { label?: string; status?: string };

function requireRecord(value: unknown): void {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new ApplicationError('Invalid classification settings', ErrorCode.INVALID_FORMAT);
}

function definitions(value: NativeNamedItem | NativeNamedItem[] | undefined): NativeNamedItem[] {
	if (value === undefined) return [];
	const entries = Array.isArray(value) ? value : [value];
	const ids = new Set<string>();
	for (const entry of entries) {
		requireRecord(entry);
		const id = entry.$?.ID ?? entry.ID;
		if (
			typeof id !== 'string' ||
			!/^(?:-1|0|[1-9][0-9]*)$/.test(id) ||
			!Number.isSafeInteger(Number(id)) ||
			(entry._ !== undefined && typeof entry._ !== 'string')
		)
			throw new ApplicationError(
				'Invalid classification definition',
				ErrorCode.INVALID_FORMAT
			);
		if (ids.has(id))
			throw new ApplicationError(
				'Classification definitions contain a duplicate ID',
				ErrorCode.INVALID_STATE
			);
		ids.add(id);
	}
	return entries;
}

export function readDocumentClassification(
	metadata: BinderMetaData,
	project?: Project
): Classification {
	const { labels, statuses } = extractProjectTaxonomy(project);
	return {
		label:
			metadata.LabelID === undefined
				? metadata.Label || undefined
				: metadata.LabelID === '-1'
					? undefined
					: labels.find((entry) => entry.id === metadata.LabelID)?.title,
		status:
			metadata.StatusID === undefined
				? metadata.Status || undefined
				: metadata.StatusID === '-1'
					? undefined
					: statuses.find((entry) => entry.id === metadata.StatusID)?.title,
	};
}

function namedId(entries: NativeNamedItem[], title: string): string | undefined {
	const matches = entries.filter((entry) => entry._ === title);
	if (matches.length > 1)
		throw new ApplicationError('Classification name is ambiguous', ErrorCode.INVALID_INPUT);
	if (!matches.length) return undefined;
	return matches[0].$?.ID ?? matches[0].ID;
}

function nextId(entries: NativeNamedItem[]): string {
	const used = new Set(entries.map((entry) => entry.$?.ID ?? entry.ID));
	let id = 0;
	while (used.has(String(id))) id++;
	return String(id);
}

export function assignDocumentClassification(
	project: Project,
	metadata: BinderMetaData,
	update: Classification
): void {
	for (const name of [update.label, update.status]) {
		if (name !== undefined && (typeof name !== 'string' || name.length > 10000))
			throw new ApplicationError(
				'Label and status must be strings of at most 10000 characters',
				ErrorCode.INVALID_INPUT
			);
	}
	if (update.label !== undefined) {
		let id = '-1';
		if (update.label !== '') {
			const settings = (project.LabelSettings ||= {});
			requireRecord(settings);
			const labels = (settings.Labels ||= {});
			requireRecord(labels);
			const entries = definitions(labels.Label);
			id = namedId(entries, update.label) ?? nextId(entries);
			if (!entries.some((entry) => (entry.$?.ID ?? entry.ID) === id)) {
				entries.push({ $: { ID: id, Color: '0.5 0.5 0.5' }, _: update.label });
				labels.Label = entries;
			}
		}
		metadata.LabelID = id;
		delete metadata.Label;
	}
	if (update.status !== undefined) {
		let id = '-1';
		if (update.status !== '') {
			const settings = (project.StatusSettings ||= {});
			requireRecord(settings);
			const statuses = (settings.StatusItems ||= {});
			requireRecord(statuses);
			const entries = definitions(statuses.Status);
			id = namedId(entries, update.status) ?? nextId(entries);
			if (!entries.some((entry) => (entry.$?.ID ?? entry.ID) === id)) {
				entries.push({ $: { ID: id }, _: update.status });
				statuses.Status = entries;
			}
		}
		metadata.StatusID = id;
		delete metadata.Status;
	}
}
