// Validate real local-only tool results against their advertised output schemas.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const out = (l) => process.stdout.write(`${l}\n`);
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

const PLAN = [
	['analyze_manuscript_local', { action: 'capabilities' }, { id: 'local.capabilities' }],
	[
		'analyze_manuscript_local',
		{ action: 'analyze', saveAs: 'conformance' },
		{ id: 'local.analyze.save' },
	],
	[
		'analyze_manuscript_local',
		{ action: 'analyze', baseline: 'conformance' },
		{ id: 'local.analyze.baseline' },
	],
	[
		'analyze_narrative_annotations',
		{ kind: 'causality', input: { nodes: [], interventions: [] } },
		{ id: 'narrative.empty-causality' },
	],
	['c2pa_capabilities', {}, { id: 'credentials.capabilities' }],
	[
		'sign_content_credentials',
		(context) => ({
			assetPath: context.credentialAssetPath,
			outputPath: context.credentialManifestPath,
			mode: 'sidecar',
		}),
		{ id: 'credentials.sign' },
	],
	[
		'validate_content_credentials',
		(context) => ({
			assetPath: context.credentialAssetPath,
			manifestPath: context.credentialManifestPath,
		}),
		{ id: 'credentials.validate' },
	],
	['manuscript_dashboard', {}, { id: 'dashboard.default' }],
	['review_changes', { action: 'list' }, { id: 'review.list' }],
	['review_changes', { action: 'inbox' }, { id: 'review.inbox' }],
	['story_dependencies', { action: 'list' }, { id: 'dependencies.list' }],
	[
		'analyze_change_impact',
		async (context) => {
			const [scene] = await context.project.getEditorialServices().source.list();
			if (!scene) throw new Error('Impact conformance requires a saved manuscript scene');
			return {
				kind: 'remove',
				documentId: scene.documentId,
				expectedRevision: scene.revision,
			};
		},
		{ id: 'impact.remove' },
	],
	['search_passages', { query: 'fear', mode: 'semantic' }, { id: 'passages.semantic' }],
	['semantic_search', { query: 'fear' }, { id: 'search.semantic' }],
	['search', { query: 'storm' }, { id: 'search.content' }],
	['check_consistency', {}, { id: 'continuity.check.all' }],
	['continuity_findings', { action: 'list' }, { id: 'continuity.list' }],
	['manage_series', { action: 'list' }, { id: 'series.list' }],
	[
		'story_bible',
		(context) => ({
			action: 'list',
			scope: { kind: 'project', id: context.project.getEditorialServices().source.projectId },
		}),
		{ id: 'bible.list' },
	],
	['editorial_workflow', { action: 'list' }, { id: 'workflow.list' }],
	['export_manuscript', { preset: 'ebook' }, { id: 'export.preflight.ebook' }],
	['get_structure', {}, { id: 'project.structure' }],
	['get_statistics', {}, { id: 'project.statistics' }],
	['get_compile_settings', {}, { id: 'project.compile-settings' }],
	['find_orphaned_entities', {}, { id: 'entities.orphaned' }],
	['get_entity_references', 'NEEDS_DOC', { id: 'entities.references.document' }],
	['get_entity_references', { entity: 'storm' }, { id: 'entities.references.name' }],
	['suggest_connections', 'NEEDS_DOC', { id: 'entities.connections' }],
	['verify_project_integrity', {}, { id: 'project.integrity' }],
	['list_trash', {}, { id: 'project.trash' }],
	['search', { query: 'storm', field: 'title' }, { id: 'search.title' }],
	['find_mentions', { entity: 'storm' }, { id: 'search.mentions' }],
	['get_writing_goals', {}, { id: 'preferences.goals' }],
	['get_writing_preferences', {}, { id: 'preferences.writing' }],
	['analyze_document', 'NEEDS_DOC', { id: 'analysis.document' }],
	[
		'create_document',
		{ title: 'Conformance Probe', content: 'A sample paragraph about a storm.', force: true },
		{ id: 'document.create.probe' },
	],
	['get_document_info', 'NEEDS_DOC', { id: 'document.info' }],
	['read_annotations', 'NEEDS_DOC', { id: 'document.annotations' }],

	['list_skills', {}, { id: 'registry.list-skills' }],
	['check_style_local', 'NEEDS_DOC', { id: 'local.style.document' }],
	['find_repetition_local', 'NEEDS_DOC', { id: 'local.repetition.document' }],
	['analyze_rhythm_local', 'NEEDS_DOC', { id: 'local.rhythm.document' }],
	['analyze_dialogue_tags_local', 'NEEDS_DOC', { id: 'local.dialogue.document' }],
	['analyze_craft_local', 'NEEDS_DOC', { id: 'local.craft.document' }],
	['analyze_opening_local', 'NEEDS_DOC', { id: 'local.opening.document' }],
	['manuscript_style_report_local', {}, { id: 'local.style.manuscript' }],
	['check_continuity_local', {}, { id: 'local.continuity.manuscript' }],
	['analyze_foreshadowing_local', {}, { id: 'local.foreshadowing.manuscript' }],
	[
		'measure_voice_drift_local',
		{ characterName: 'Conformance Mara' },
		{ id: 'local.voice.manuscript' },
	],
	[
		'check_plot_consistency',
		async (c) => ({
			documents: (await source(c).list()).slice(0, 2).map((doc) => ({ id: doc.documentId })),
		}),
		{ id: 'continuity.legacy.saved' },
	],
	['get_manuscript_briefing', {}, { id: 'project.briefing' }],
	[
		'create_snapshot',
		(c) => ({ documentId: c.anyDocId, title: 'Conformance before edit', force: true }),
		{
			id: 'snapshot.create',
			unavailableCommands: true,
			after: (r, c) => {
				c.snapshotId = r.snapshotId;
			},
		},
	],
	['list_snapshots', (c) => ({ documentId: c.anyDocId }), { id: 'snapshot.list' }],
	[
		'read_snapshot',
		(c) => ({ documentId: c.anyDocId, snapshotId: c.snapshotId }),
		{
			id: 'snapshot.read',
			after: (r) => assert.equal(r.text, 'A sample paragraph about a storm.'),
		},
	],
	[
		'compare_snapshot',
		(c) => ({ documentId: c.anyDocId, snapshotId: c.snapshotId }),
		{ id: 'snapshot.compare', after: (r) => assert.equal(r.wordDelta, 0) },
	],
	[
		'remember',
		{ memoryType: 'characters', data: { name: 'Conformance Mara' } },
		{ id: 'memory.remember.character' },
	],
	['recall', { memoryType: 'characters' }, { id: 'memory.recall.character' }],
	[
		'remember',
		{ memoryType: 'worldBuilding', data: { name: 'Conformance Harbor', type: 'location' } },
		{ id: 'memory.remember.world' },
	],
	['recall', { memoryType: 'worldBuilding' }, { id: 'memory.recall.world' }],
	[
		'remember',
		{ memoryType: 'plotThreads', data: { name: 'Conformance search', status: 'setup' } },
		{ id: 'memory.remember.plot' },
	],
	['recall', { memoryType: 'plotThreads' }, { id: 'memory.recall.plot' }],
	[
		'remember',
		{ memoryType: 'styleGuide', data: { tone: ['formal'] } },
		{ id: 'memory.remember.style' },
	],
	['recall', { memoryType: 'styleGuide' }, { id: 'memory.recall.style' }],
	[
		'remember',
		{ memoryType: 'characters', data: {} },
		{ id: 'memory.refuse.missing-name', expectError: 'name|required' },
	],
	[
		'review_changes',
		async (c) => {
			const doc = await source(c).read(c.anyDocId);
			c.beforeReview = fs.readFileSync(
				path.join(c.projectPath, 'Files', 'Data', c.anyDocId, 'content.rtf')
			);
			return {
				action: 'propose',
				documentId: c.anyDocId,
				expectedRevision: doc.revision,
				edits: [{ start: 0, end: 1, text: 'The' }],
				idempotencyKey: 'conformance-edit',
			};
		},
		{
			id: 'review.propose',
			after: (r, c) => {
				c.proposalId = r.result.id;
			},
		},
	],
	['review_changes', (c) => ({ action: 'get', proposalId: c.proposalId }), { id: 'review.get' }],
	[
		'review_changes',
		(c) => ({ action: 'preview', proposalId: c.proposalId }),
		{ id: 'review.preview' },
	],
	[
		'review_changes',
		(c) => ({ action: 'apply', proposalId: c.proposalId, force: true }),
		{
			id: 'review.apply',
			after: async (r, c) => {
				c.operationId = r.result.id;
				assert.equal(
					(await source(c).read(c.anyDocId)).text,
					'The sample paragraph about a storm.'
				);
			},
		},
	],
	[
		'review_changes',
		(c) => ({ action: 'undo', operationId: c.operationId, force: true }),
		{
			id: 'review.undo',
			after: (_r, c) =>
				assert.deepEqual(
					fs.readFileSync(
						path.join(c.projectPath, 'Files', 'Data', c.anyDocId, 'content.rtf')
					),
					c.beforeReview
				),
		},
	],
	[
		'review_changes',
		async (c) => ({
			action: 'propose',
			documentId: c.anyDocId,
			expectedRevision: (await source(c).read(c.anyDocId)).revision,
			edits: [{ start: 0, end: 0, text: 'Rejected. ' }],
		}),
		{
			id: 'review.propose.rejectable',
			after: (r, c) => {
				c.rejectId = r.result.id;
			},
		},
	],
	[
		'review_changes',
		(c) => ({ action: 'reject', proposalId: c.rejectId }),
		{ id: 'review.reject' },
	],
	['review_changes', { action: 'recover' }, { id: 'review.recover' }],
	[
		'review_changes',
		(c) => ({
			action: 'propose',
			documentId: c.anyDocId,
			expectedRevision: '0'.repeat(64),
			edits: [{ start: 0, end: 0, text: 'Stale. ' }],
		}),
		{ id: 'review.refuse.stale', expectError: 'revision|changed' },
	],
	[
		'review_changes',
		{ action: 'list', limit: 0 },
		{ id: 'review.refuse.page-zero', expectError: 'Too small|limit must be' },
	],
	[
		'create_document',
		(c) => ({
			title: 'Conformance Blue',
			content: 'Mara has blue eyes.',
			parentId: c.draftId,
			force: true,
		}),
		{
			id: 'document.create.blue',
			after: (r, c) => {
				c.blueId = r.documentId;
			},
		},
	],
	[
		'create_document',
		(c) => ({
			title: 'Conformance Green',
			content: 'Mara has green eyes.',
			parentId: c.draftId,
			force: true,
		}),
		{
			id: 'document.create.green',
			after: (r, c) => {
				c.greenId = r.documentId;
			},
		},
	],
	[
		'search_passages',
		(c) => ({
			query: 'Mara',
			mode: 'keyword',
			documentIds: [c.blueId, c.greenId],
			limit: 1,
			contextChars: 0,
		}),
		{ id: 'passages.keyword.minimum', after: assertPassages },
	],
	[
		'search_passages',
		(c) => ({
			query: 'Mara',
			mode: 'hybrid',
			documentIds: [c.blueId, c.greenId],
			limit: 50,
			contextChars: 2000,
		}),
		{ id: 'passages.hybrid.maximum', after: assertPassages },
	],
	[
		'search_passages',
		{ query: 'Mara', limit: 0 },
		{ id: 'passages.refuse.limit-zero', expectError: 'limit|Limit' },
	],
	[
		'search_passages',
		{ query: 'Mara', limit: 51 },
		{ id: 'passages.refuse.limit-over', expectError: 'limit|Limit' },
	],
	[
		'search_passages',
		{ query: 'Mara', limit: 1.5 },
		{ id: 'passages.refuse.fraction', expectError: 'limit|Limit' },
	],
	[
		'search_passages',
		{ query: '' },
		{ id: 'passages.refuse.empty-query', expectError: 'query|Query' },
	],
	[
		'check_consistency',
		(c) => ({ documentIds: [c.blueId, c.greenId], checkTypes: ['characters'] }),
		{
			id: 'continuity.check.characters',
			after: (r, c) => {
				assert.ok(r.issues.length > 0);
				c.findingId = r.issues[0].id;
			},
		},
	],
	[
		'continuity_findings',
		(c) => ({ action: 'confirm', findingId: c.findingId }),
		{ id: 'continuity.confirm' },
	],
	[
		'continuity_findings',
		(c) => ({ action: 'dismiss', findingId: c.findingId, note: 'Synthetic fixture review' }),
		{ id: 'continuity.dismiss' },
	],
	[
		'continuity_findings',
		(c) => ({ action: 'resolve', findingId: c.findingId, note: 'Synthetic fixture decision' }),
		{ id: 'continuity.resolve' },
	],
	[
		'continuity_findings',
		(c) => ({ action: 'recheck', findingId: c.findingId }),
		{ id: 'continuity.recheck' },
	],
	[
		'check_consistency',
		{ checkTypes: ['plotThreads'] },
		{
			id: 'continuity.refuse.plot-threads',
			expectError: 'Plot-thread continuity analysis is unavailable',
		},
	],
	[
		'manage_series',
		{ action: 'create', name: 'Conformance series' },
		{
			id: 'series.create',
			after: (r, c) => {
				c.seriesId = r.series[0].id;
			},
		},
	],
	['manage_series', (c) => ({ action: 'leave', seriesId: c.seriesId }), { id: 'series.leave' }],
	['manage_series', (c) => ({ action: 'join', seriesId: c.seriesId }), { id: 'series.join' }],
	[
		'story_bible',
		async (c) => ({
			action: 'curate',
			scope: projectScope(c),
			fact: {
				kind: 'character',
				subject: 'Mara',
				predicate: 'eye-color',
				value: 'blue',
				confidence: 'confirmed',
				sources: [await passage(c, c.blueId)],
			},
		}),
		{
			id: 'bible.curate',
			after: (r, c) => {
				c.factId = r.facts[0].id;
			},
		},
	],
	[
		'story_bible',
		(c) => ({
			action: 'correct',
			scope: projectScope(c),
			factId: c.factId,
			patch: { intentional: true },
		}),
		{ id: 'bible.correct' },
	],
	[
		'story_bible',
		(c) => ({ action: 'recheck', scope: projectScope(c) }),
		{ id: 'bible.recheck' },
	],
	[
		'story_bible',
		(c) => ({ action: 'export_state', scope: projectScope(c) }),
		{
			id: 'bible.export-state',
			after: (r, c) => {
				assert.ok(r.snapshot);
				c.bibleSnapshot = r.snapshot;
			},
		},
	],
	[
		'story_bible',
		(c) => ({
			action: 'import_state',
			scope: projectScope(c),
			snapshot: c.bibleSnapshot,
			expectedRevision: c.bibleSnapshot.revision,
		}),
		{ id: 'bible.import-state' },
	],
	[
		'story_bible',
		(c) => ({
			action: 'import_state',
			scope: projectScope(c),
			snapshot: c.bibleSnapshot,
			expectedRevision: '0'.repeat(64),
		}),
		{ id: 'bible.refuse.stale-import', expectError: 'revision|changed' },
	],
	[
		'story_bible',
		(c) => ({ action: 'import_memory', scope: projectScope(c) }),
		{ id: 'bible.import-memory' },
	],
	[
		'story_dependencies',
		async (c) => ({
			action: 'link',
			kind: 'causal',
			prerequisite: await passage(c, c.blueId),
			dependent: await passage(c, c.greenId),
			explanation: 'Synthetic fixture relationship',
		}),
		{
			id: 'dependencies.link',
			after: (r, c) => {
				c.dependencyId = r.result.id;
			},
		},
	],
	[
		'analyze_change_impact',
		async (c) => ({
			kind: 'replace',
			documentId: c.blueId,
			expectedRevision: (await source(c).read(c.blueId)).revision,
			replacementText: 'Mara has hazel eyes.',
		}),
		{ id: 'impact.replace' },
	],
	[
		'analyze_change_impact',
		async (c) => ({
			kind: 'move',
			documentId: c.blueId,
			expectedRevision: (await source(c).read(c.blueId)).revision,
			beforeDocumentId: null,
		}),
		{ id: 'impact.move' },
	],
	[
		'story_dependencies',
		(c) => ({ action: 'unlink', id: c.dependencyId }),
		{ id: 'dependencies.unlink' },
	],
	[
		'editorial_workflow',
		(c) => ({
			action: 'start',
			kind: 'audit-continuity',
			documentIds: [c.blueId, c.greenId],
			idempotencyKey: 'conformance-audit',
		}),
		{
			id: 'workflow.start.audit',
			after: async (r, c) => {
				c.workflowId = r.workflows[0].id;
				assert.equal(
					(await c.project.getEditorialServices().workflows.wait(c.workflowId)).state,
					'completed'
				);
			},
		},
	],
	[
		'editorial_workflow',
		(c) => ({ action: 'get', workflowId: c.workflowId }),
		{ id: 'workflow.get' },
	],
	[
		'editorial_workflow',
		(c) => ({ action: 'cancel', workflowId: c.workflowId }),
		{
			id: 'workflow.cancel.completed-idempotent',
			after: (r) => assert.equal(r.workflows[0].state, 'completed'),
		},
	],
	[
		'editorial_workflow',
		(c) => ({ action: 'resume', workflowId: c.workflowId }),
		{
			id: 'workflow.resume.completed-idempotent',
			after: (r) => assert.equal(r.workflows[0].state, 'completed'),
		},
	],
	[
		'compile_documents',
		(c) => ({ mode: 'standard', format: 'text', documentIds: [c.blueId, c.greenId] }),
		{ id: 'compile.standard.text' },
	],
	[
		'compile_documents',
		(c) => ({ mode: 'structured', format: 'markdown', rootFolderId: c.draftId }),
		{ id: 'compile.structured.markdown' },
	],
	['export_project', { format: 'json' }, { id: 'export.project.json' }],
	[
		'export_manuscript',
		(c) => ({
			action: 'preflight',
			preset: 'submission-manuscript',
			documentIds: [c.blueId, c.greenId],
		}),
		{ id: 'export.preflight.submission' },
	],
	[
		'export_manuscript',
		(c) => ({ action: 'preflight', preset: 'beta-reader', documentIds: [c.blueId, c.greenId] }),
		{ id: 'export.preflight.beta' },
	],
	[
		'export_manuscript',
		(c) => ({
			action: 'export',
			preset: 'ebook',
			documentIds: [c.blueId, c.greenId],
			language: 'fr',
			outputPath: path.join(c.tmp, 'fixture.epub'),
		}),
		{
			id: 'export.write.ebook',
			after: (_r, c) => assert.ok(fs.statSync(path.join(c.tmp, 'fixture.epub')).size > 0),
		},
	],
	[
		'export_manuscript',
		(c) => ({
			action: 'export',
			preset: 'submission-manuscript',
			documentIds: [c.blueId, c.greenId],
			language: 'ja',
			outputPath: path.join(c.tmp, 'fixture.docx'),
		}),
		{
			id: 'export.write.submission',
			after: (_r, c) => assert.ok(fs.statSync(path.join(c.tmp, 'fixture.docx')).size > 0),
		},
	],
	[
		'generate_content',
		{ prompt: 'Write an original synthetic sentence.', length: 10 },
		{
			id: 'provider.generation.unavailable',
			expectError: 'local.only|disabled|No AI provider',
		},
	],
	[
		'generate_content',
		{ prompt: '', length: 10 },
		{ id: 'provider.generation.refuse.blank', expectError: 'prompt.*(requires|fewer)' },
	],
	[
		'enhance_content',
		(c) => ({ documentId: c.blueId, enhancementType: 'grammar' }),
		{ id: 'provider.enhancement.unavailable', expectError: 'unavailable|provider_failed' },
	],
	[
		'analyze_writing_style',
		{ samples: ['Original synthetic prose for local refusal validation.'] },
		{ id: 'provider.style.unavailable', expectError: 'AI writing provider is unavailable' },
	],
	[
		'suggest_improvements',
		{ prompt: 'Suggest an original sentence.', useContext: false, async: false },
		{
			id: 'provider.suggestions.unavailable',
			expectError: 'AI writing provider is unavailable',
		},
	],
	[
		'generate_marketing_materials',
		(c) => ({ materialType: 'book_blurb', documentIds: [c.blueId] }),
		{ id: 'provider.marketing.unavailable', expectError: 'Marketing generation failed' },
	],
	[
		'remember',
		{ memoryType: 'all', data: { conformance: '🌙'.repeat(3000) } },
		{ id: 'memory.remember.large' },
	],
	[
		'recall',
		{ memoryType: 'all' },
		{
			id: 'memory.recall.reference',
			after: (r, c) => {
				assert.ok(r._ref);
				c.resultId = r._ref;
			},
		},
	],
	[
		'read_result',
		(c) => ({ resultId: c.resultId, offset: 0, limit: 4 }),
		{
			id: 'result.read.minimum',
			after: (r, c) => {
				c.resultPrefix = r.text;
				c.nextOffset = r.nextOffset;
				assert.equal(Buffer.byteLength(r.text), 4);
			},
		},
	],
	[
		'read_result',
		(c) => ({ resultId: c.resultId, offset: c.nextOffset, limit: 65536 }),
		{
			id: 'result.read.maximum',
			after: (r, c) => {
				assert.equal(r.nextOffset, null);
				assert.equal(
					JSON.parse(c.resultPrefix + r.text).memory.customContext.conformance,
					'🌙'.repeat(3000)
				);
			},
		},
	],
	[
		'read_result',
		(c) => ({ resultId: c.resultId, limit: 3 }),
		{ id: 'result.refuse.below-minimum', expectError: 'limit|4' },
	],
	[
		'read_result',
		(c) => ({ resultId: c.resultId, limit: 65537 }),
		{ id: 'result.refuse.above-maximum', expectError: 'limit|65536' },
	],
	[
		'create_document',
		(c) => ({
			parentId: c.draftId,
			title: 'Graph conformance scene',
			content: 'Conformance Mara and Conformance Ren waited in Conformance Harbor.',
			force: true,
		}),
		{
			id: 'graph.create.source',
			after: (r, c) => {
				c.graphDocId = r.documentId;
			},
		},
	],
	[
		'add_relationship',
		{
			head: 'Conformance Mara',
			headType: 'Character',
			relation: 'knows',
			tail: 'Conformance Ren',
			tailType: 'Character',
		},
		{
			id: 'graph.add.character',
			after: (r, c) => {
				c.graphEdgeId = r.id;
			},
		},
	],
	[
		'add_relationship',
		{
			head: 'Conformance Mara',
			headType: 'Character',
			relation: 'knows',
			tail: 'Conformance Ren',
			tailType: 'Character',
		},
		{ id: 'graph.add.idempotent', after: (r, c) => assert.equal(r.id, c.graphEdgeId) },
	],
	[
		'add_relationship',
		{
			head: 'Conformance Ren',
			headType: 'Character',
			relation: 'visits',
			tail: 'Conformance Harbor',
			tailType: 'Location',
		},
		{ id: 'graph.add.location' },
	],
	[
		'find_relationships',
		{ entity: 'Conformance Mara', k: 1 },
		{
			id: 'graph.find.recorded',
			after: (r, c) => {
				assert.equal(r.total, 1);
				assert.equal(r.relationships[0].id, c.graphEdgeId);
				assert.equal(r.nextOffset, null);
			},
		},
	],
	[
		'character_network',
		{},
		{
			id: 'graph.network.nonempty',
			after: (r) => {
				assert.deepEqual(r.network['Conformance Mara'], [
					{ target: 'Conformance Ren', relation: 'knows' },
				]);
				assert.deepEqual(r.network['Conformance Ren'], []);
				assert.equal(r.network['Conformance Harbor'], undefined);
			},
		},
	],
	[
		'discover_connections',
		{ k: 100 },
		{
			id: 'graph.discover.saved',
			after: async (r, c) => {
				r = await readFixtureResult(r);
				const hit = r.connections.find(
					(item) =>
						[item.entity1, item.entity2].sort().join('|') ===
						'Conformance Harbor|Conformance Mara'
				);
				assert.ok(hit);
				assert.ok(hit.documentIds.includes(c.graphDocId));
				const saved = await source(c).read(c.graphDocId);
				assert.ok(
					r.envelope.sourceRevisions.some(
						(item) =>
							item.documentId === c.graphDocId && item.revision === saved.revision
					)
				);
			},
		},
	],
	[
		'queue_document_analysis',
		(c) => ({
			documentId: c.queueDocumentIds[0],
			content: 'Original supplied prose. Mara waits beside the harbor.',
			options: { includeReadability: true, includeEntities: false, includeSentiment: false },
		}),
		{
			id: 'queue.document.enqueue',
			after: (r, c) => {
				c.documentJobId = r.jobId;
			},
		},
	],
	[
		'get_job_status',
		async (c) => {
			await waitForJob('analyze_document', c.documentJobId);
			return { jobType: 'analyze_document', jobId: c.documentJobId };
		},
		{
			id: 'queue.document.completed',
			after: async (r, c) => {
				r = { ...r, result: await readFixtureResult(r.result) };
				assert.equal(r.state, 'completed');
				assert.equal(r.result.documentId, c.queueDocumentIds[0]);
				await assertPersistedAnalysis(c, r.result);
				assert.equal(r.result.envelope.sourceFormat, 'supplied-text');
				assert.equal(r.result.envelope.policy.mode, 'raw');
				assert.equal(
					r.result.envelope.sourceRevisions[0].revision,
					digest('Original supplied prose. Mara waits beside the harbor.')
				);
			},
		},
	],
	[
		'queue_project_analysis',
		(c) => ({
			projectId: 'conformance-supplied-project',
			documents: [
				{ id: c.queueDocumentIds[0], content: 'Mara waits beside the harbor.' },
				{ id: c.queueDocumentIds[1], content: 'Ren walks home.' },
			],
			options: { parallel: false, batchSize: 1 },
		}),
		{
			id: 'queue.project.enqueue',
			after: (r, c) => {
				c.projectJobId = r.jobId;
			},
		},
	],
	[
		'get_job_status',
		async (c) => {
			await waitForJob('analyze_project', c.projectJobId);
			return { jobType: 'analyze_project', jobId: c.projectJobId };
		},
		{
			id: 'queue.project.completed',
			after: async (r, c) => {
				r = { ...r, result: await readFixtureResult(r.result) };
				assert.equal(r.state, 'completed');
				assert.equal(r.result.projectId, 'conformance-supplied-project');
				for (const document of r.result.documents)
					await assertPersistedAnalysis(c, document);
				assert.deepEqual(
					r.result.documents.map((item) => item.documentId),
					c.queueDocumentIds
				);
				assert.deepEqual(
					r.result.documents.map((item) => item.envelope.sourceRevisions[0].revision),
					[digest('Mara waits beside the harbor.'), digest('Ren walks home.')]
				);
			},
		},
	],
	[
		'get_job_status',
		{ jobType: 'analyze_document', jobId: 'conformance-missing-job' },
		{ id: 'queue.status.missing', after: (r) => assert.equal(r.state, 'not_found') },
	],
	[
		'get_queue_stats',
		{},
		{
			id: 'queue.stats.embedded',
			after: (r) => {
				assert.equal(r.connection.type, 'embedded');
				assert.equal(r.connection.legacyQueues, 'excluded');
			},
		},
	],
	[
		'discover_projects',
		{},
		{
			id: 'discovery.home.empty',
			after: (r) => assert.deepEqual(r, { count: 0, projects: [] }),
		},
	],
	[
		'discover_projects',
		(c) => ({ searchPath: c.tmp }),
		{
			id: 'discovery.fixture.found',
			after: (r, c) => assert.deepEqual(r, { count: 1, projects: [c.projectPath] }),
		},
	],
	[
		'detect_open_project',
		{},
		{
			id: 'native.detect.command-unavailable',
			unavailableCommands: true,
			after: (r) => {
				assert.equal(r.supported, process.platform === 'darwin');
				assert.equal(r.running, false);
				assert.equal(r.count, 0);
			},
		},
	],
];

const source = (context) => context.project.getEditorialServices().source;
const projectScope = (context) => ({ kind: 'project', id: source(context).projectId });
async function passage(context, documentId) {
	const doc = await source(context).read(documentId);
	return {
		projectId: doc.projectId,
		documentId,
		revision: doc.revision,
		title: doc.title,
		path: doc.path,
		start: 0,
		end: doc.text.length,
		line: 1,
		quote: doc.text,
	};
}
async function assertPassages(result, context) {
	assert.ok(result.results.length > 0, 'Synthetic source must yield a passage');
	for (const hit of result.results) {
		const doc = await source(context).read(hit.documentId);
		assert.equal(hit.revision, doc.revision);
		assert.equal(hit.quote, doc.text.slice(hit.start, hit.end));
		assert.equal(hit.context, doc.text.slice(hit.contextStart, hit.contextEnd));
	}
}
async function assertPersistedAnalysis(context, result) {
	const history = await context.databaseService.getContentAnalysisHistory(
		result.documentId,
		'document',
		{ limit: 1 }
	);
	assert.equal(history.length, 1, 'Queued fixture analysis must persist in its project database');
	assert.deepEqual(history[0].analysisData, result);
}

async function readFixtureResult(value) {
	if (!value?._ref) return value;
	const { readResult } = await import('../dist/core/response-formatter.js');
	let text = '';
	let offset = 0;
	for (let pageNumber = 0; pageNumber < 32; pageNumber++) {
		const page = readResult(value._ref, offset, 65536);
		assert.equal(page.offset, offset);
		assert.ok(page.totalBytes <= 2 * 1024 * 1024, 'Fixture result exceeds its byte budget');
		text += page.text;
		if (page.nextOffset === null) {
			assert.equal(Buffer.byteLength(text), page.totalBytes);
			return JSON.parse(text);
		}
		assert.ok(page.nextOffset > offset, 'Fixture result page made no progress');
		offset = page.nextOffset;
	}
	throw new Error('Fixture result exceeds its page budget');
}

async function waitForJob(jobType, jobId) {
	const { getJobStatus } = await import('../dist/handlers/async-handlers.js');
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline) {
		const status = await getJobStatus({ jobType, jobId });
		if (status.state === 'completed') return;
		assert.ok(
			!['failed', 'cancelled', 'not_found'].includes(status.state),
			`Fixture job ${jobType} did not complete: ${status.state}`
		);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Fixture job ${jobType} exceeded its completion budget`);
}

export async function withUnavailableCommands(emptyPath, operation) {
	const previous = process.env.PATH;
	process.env.PATH = emptyPath;
	try {
		return await operation();
	} finally {
		if (previous === undefined) delete process.env.PATH;
		else process.env.PATH = previous;
	}
}

export async function createUnavailableRedisServer() {
	const server = createServer((socket) => socket.destroy());
	let serverError;
	server.on('error', (error) => {
		serverError ??= error;
	});
	await new Promise((resolve, reject) => {
		const onError = (error) => {
			server.off('listening', onListening);
			reject(error);
		};
		const onListening = () => {
			server.off('error', onError);
			resolve();
		};
		server.once('error', onError);
		server.once('listening', onListening);
		server.listen(0, '127.0.0.1');
	});
	const port = server.address().port;
	return {
		url: `redis://127.0.0.1:${port}`,
		async close() {
			await new Promise((resolve, reject) => {
				const timeout = setTimeout(() => {
					server.unref();
					reject(new Error('Fixture Redis listener shutdown exceeded its time budget'));
				}, 1000);
				server.close((error) => {
					clearTimeout(timeout);
					if (error) reject(error);
					else resolve();
				});
			});
			if (serverError) throw serverError;
		},
	};
}

const digest = (value) => createHash('sha256').update(value).digest('hex');
const jsonDigest = (value) => digest(JSON.stringify(value));
const messageOf = (value) => (value instanceof Error ? value.message : String(value));

export function assessResult(tool, result, expectedError) {
	const refusal = result?.isError === true;
	const outcome = refusal ? 'returned-error' : 'success';
	const text = (result?.content ?? [])
		.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('\n');
	const schema =
		result?.structuredContent === undefined
			? 'not-returned'
			: tool.outputSchema
				? 'pending'
				: 'not-advertised';
	const assessment = { outcome, schema, status: 'PASS' };
	if (schema === 'pending') {
		const validate = ajv.compile(tool.outputSchema);
		assessment.schema = validate(result.structuredContent) ? 'valid' : 'invalid';
		if (assessment.schema === 'invalid')
			return { ...assessment, status: 'FAIL', detail: ajv.errorsText(validate.errors) };
	}
	if (expectedError) {
		if (!refusal || !new RegExp(expectedError, 'i').test(text))
			return { ...assessment, status: 'FAIL', detail: 'Expected refusal was not returned' };
		return assessment;
	}
	if (refusal) return { ...assessment, status: 'FAIL', detail: 'Unexpected error result' };
	if (assessment.schema !== 'valid')
		return {
			...assessment,
			status: 'FAIL',
			detail: 'Success requires advertised schema and structuredContent',
		};
	return assessment;
}

export function assessThrown(error, expectedError) {
	const detail = messageOf(error);
	return {
		outcome: 'thrown-error',
		schema: 'not-returned',
		status: expectedError && new RegExp(expectedError, 'i').test(detail) ? 'PASS' : 'FAIL',
		detail,
	};
}

function manifest(repository, locations) {
	const files = [];
	function walk(relative) {
		const absolute = path.join(repository, relative);
		const stat = fs.lstatSync(absolute);
		if (stat.isSymbolicLink())
			throw new Error(`Evidence input must not be a symlink: ${relative}`);
		if (stat.isDirectory()) {
			for (const entry of fs.readdirSync(absolute).sort()) walk(path.join(relative, entry));
		} else if (stat.isFile())
			files.push({ path: relative, sha256: digest(fs.readFileSync(absolute)) });
	}
	for (const location of locations) walk(location);
	files.sort((a, b) => a.path.localeCompare(b.path));
	return { sha256: jsonDigest(files), files };
}

async function main() {
	const args = process.argv.slice(2);
	if (args.length && (args.length !== 2 || args[0] !== '--receipt'))
		throw new Error(
			'Usage: node scripts/check-output-conformance.mjs [--receipt NEW_PATH.json]'
		);
	const receiptPath = args.length ? path.resolve(args[1]) : undefined;
	if (receiptPath && fs.existsSync(receiptPath))
		throw new Error('Receipt path already exists; use a new path');
	for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'])
		delete process.env[key];
	process.env.SCRIVENER_LOCAL_ONLY = 'true';
	process.env.SCRIVENER_DISABLE_KEY_DISCOVERY = '1';
	process.env.SCRIVENER_MCP_EAGER_TOOLS = '1';
	const repository = process.cwd();
	const locations = [
		'src',
		'dist',
		'tests/sample-project.scriv',
		'assets/c2pa-binding',
		'scripts/check-output-conformance.mjs',
		'scripts/create-c2pa-fixtures.mjs',
		'package.json',
		'package-lock.json',
	];
	const provenance = manifest(repository, locations);
	const startedAt = new Date().toISOString();
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriv-conf-'));
	const isolatedEnvironment = new Map(
		['HOME', 'USERPROFILE', 'APPDATA', 'REDIS_URL'].map((key) => [key, process.env[key]])
	);
	const fixtureHome = path.join(tmp, 'home');
	fs.mkdirSync(fixtureHome);
	Object.assign(process.env, {
		HOME: fixtureHome,
		USERPROFILE: fixtureHome,
		APPDATA: fixtureHome,
	});
	process.env.SCRIVENER_DATA_DIR = path.join(tmp, 'server-state');
	const projPath = path.join(tmp, 'sample-project.scriv');
	const results = [];
	const record = (result) => {
		results.push(result);
		out(
			`  ${result.status.padEnd(4)} ${result.id} (${result.tool})${result.detail ? ` — ${result.detail}` : ''}`
		);
	};
	const context = {
		project: null,
		memoryManager: null,
		tmp,
		projectPath: projPath,
		credentialAssetPath: path.join(tmp, 'credential-source.txt'),
		credentialManifestPath: path.join(tmp, 'credential-source.c2pa'),
	};
	const credentialVariables = [
		'SCRIVENER_C2PA_CERT_PATH',
		'SCRIVENER_C2PA_KEY_PATH',
		'SCRIVENER_C2PA_KEY_PASSWORD',
		'SCRIVENER_C2PA_TRUST_ANCHORS_PATH',
	];
	const credentialEnvironment = new Map(
		credentialVariables.map((name) => [name, process.env[name]])
	);
	let redisIsolation;
	let byName;
	let executeRegisteredHandler;
	let redactDiagnostics = (value) => value;
	async function invoke(name, input) {
		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(new Error('Conformance case exceeded its time budget')),
			name.includes('credentials') || name === 'c2pa_capabilities' ? 35000 : 20000
		);
		try {
			// Await settlement even after abort: cleanup must never race a still-running mutation.
			const result = await executeRegisteredHandler(name, input, context, {
				signal: controller.signal,
			});
			controller.signal.throwIfAborted();
			return result;
		} finally {
			clearTimeout(timeout);
		}
	}
	try {
		redisIsolation = await createUnavailableRedisServer();
		process.env.REDIS_URL = redisIsolation.url;
		fs.cpSync(path.join(repository, 'tests/sample-project.scriv'), projPath, {
			recursive: true,
		});
		const { ContentAnalyzer } = await import('../dist/analysis/base-analyzer.js');
		context.contentAnalyzer = new ContentAnalyzer();
		({ redactDiagnostics } = await import('../dist/setup/redaction.js'));
		const registry = await import('../dist/handlers/skill-registry.js');
		executeRegisteredHandler = registry.executeRegisteredHandler;
		registry.initializeSkillRegistry();
		byName = new Map(registry.getRegisteredTools().map((tool) => [tool.name, tool]));
		const ids = PLAN.map((entry) => entry[2]?.id);
		assert.ok(
			ids.every((id) => typeof id === 'string' && /^[a-z0-9.-]+$/.test(id)),
			'Every case needs a stable ID'
		);
		assert.equal(new Set(ids).size, ids.length, 'Case IDs must be unique');
		const { createC2paTestSigner } = await import('./create-c2pa-fixtures.mjs');
		const signer = await createC2paTestSigner(path.join(tmp, 'credential-signer'));
		Object.assign(process.env, {
			SCRIVENER_C2PA_CERT_PATH: signer.certificatePath,
			SCRIVENER_C2PA_KEY_PATH: signer.privateKeyPath,
			SCRIVENER_C2PA_KEY_PASSWORD: signer.password,
			SCRIVENER_C2PA_TRUST_ANCHORS_PATH: signer.trustAnchorsPath,
		});
		fs.writeFileSync(context.credentialAssetPath, 'Original synthetic CC0 credential fixture.');
		const openResult = await invoke('open_project', { path: projPath });
		assert.notEqual(openResult.isError, true);
		assert.ok(context.project);
		record({
			id: 'lifecycle.open',
			tool: 'open_project',
			status: 'PASS',
			outcome: 'success',
			schema: 'not-advertised',
			assertion: 'fixture project is open',
		});
		const structure = await invoke('get_structure', {});
		const docs = structure.structuredContent?.documents ?? [];
		context.queueDocumentIds = docs
			.filter((doc) => doc.type === 'Text')
			.slice(0, 2)
			.map((doc) => doc.id);
		assert.equal(
			context.queueDocumentIds.length,
			2,
			'Queue fixture requires two original binder documents'
		);
		context.anyDocId = context.queueDocumentIds[0];
		assert.ok(context.anyDocId, 'Fixture binder must have a text document');
		record({
			id: 'project.structure.nonempty',
			tool: 'get_structure',
			inputSha256: jsonDigest({}),
			inputSelector: {},
			outputSchemaSha256: jsonDigest(byName.get('get_structure').outputSchema),
			...assessResult(byName.get('get_structure'), structure),
			resultSha256: jsonDigest(structure),
			assertion: 'fixture binder contains a text document',
		});

		const projectXml = fs.readFileSync(
			path.join(
				projPath,
				fs.readdirSync(projPath).find((file) => file.endsWith('.scrivx'))
			),
			'utf8'
		);
		const draftItem = projectXml.match(/<BinderItem\b[^>]*\bType="DraftFolder"[^>]*>/)?.[0];
		context.draftId = draftItem?.match(/\bUUID="([^"]+)"/)?.[1];
		assert.ok(context.draftId, 'Fixture requires a draft folder');
		for (const [name, argsSpec, metadata] of PLAN) {
			const tool = byName.get(name);
			const base = {
				id: metadata.id,
				tool: name,
				expectedOutcome: metadata.expectError ? 'refusal' : 'success',
				...(metadata.unavailableCommands
					? { fixture: 'Command PATH is empty; native GUI detection is not exercised.' }
					: {}),
				expectedError: metadata.expectError ?? null,
				inputSchemaSha256: tool?.inputSchema ? jsonDigest(tool.inputSchema) : null,
				outputSchemaSha256: tool?.outputSchema ? jsonDigest(tool.outputSchema) : null,
			};
			let input;
			try {
				if (!tool) throw new Error('Tool is not registered');
				input =
					argsSpec === 'NEEDS_DOC'
						? { documentId: context.anyDocId }
						: typeof argsSpec === 'function'
							? await argsSpec(context)
							: argsSpec;
				base.inputSha256 = jsonDigest(input);
				base.inputSelector = Object.fromEntries(
					Object.entries(input)
						.filter(
							([, value]) =>
								value === null ||
								['string', 'number', 'boolean'].includes(typeof value)
						)
						.map(([key, value]) => [
							key,
							typeof value === 'string' && value.length > 200
								? { characters: value.length, sha256: digest(value) }
								: value,
						])
				);
			} catch (error) {
				record({
					...base,
					status: 'FAIL',
					outcome: 'fixture-error',
					schema: 'not-run',
					detail: messageOf(error),
				});
				continue;
			}
			let result;
			try {
				result = metadata.unavailableCommands
					? await withUnavailableCommands(path.join(tmp, 'empty-command-path'), () =>
							invoke(name, input)
						)
					: await invoke(name, input);
			} catch (error) {
				record({ ...base, ...assessThrown(error, metadata.expectError) });
				continue;
			}
			const assessment = assessResult(tool, result, metadata.expectError);
			if (assessment.status === 'PASS' && !metadata.expectError) {
				try {
					if (name === 'create_document')
						context.anyDocId = result.structuredContent.documentId;
					await metadata.after?.(result.structuredContent, context);
				} catch (error) {
					assessment.status = 'FAIL';
					assessment.detail = `Postcondition: ${messageOf(error)}`;
				}
			}
			record({
				...base,
				...assessment,
				resultSha256: jsonDigest(result),
				postcondition: metadata.after
					? assessment.status === 'PASS'
						? 'passed'
						: 'failed-or-not-run'
					: 'none',
			});
		}
	} catch (error) {
		record({
			id: 'harness.setup',
			tool: null,
			status: 'FAIL',
			outcome: 'harness-error',
			schema: 'not-run',
			detail: messageOf(error),
		});
	} finally {
		if (context.project) {
			try {
				const closed = await invoke('close_project', {});
				assert.notEqual(closed.isError, true);
				assert.equal(context.project, null);
				record({
					id: 'lifecycle.close',
					tool: 'close_project',
					status: 'PASS',
					outcome: 'success',
					schema: 'not-advertised',
					assertion: 'fixture project is closed',
				});
			} catch (error) {
				record({
					id: 'lifecycle.close',
					tool: 'close_project',
					status: 'FAIL',
					outcome: 'cleanup-error',
					schema: 'not-run',
					detail: messageOf(error),
				});
			}
		}
		try {
			await redisIsolation?.close();
		} catch (error) {
			record({
				id: 'harness.redis-cleanup',
				tool: null,
				status: 'FAIL',
				outcome: 'cleanup-error',
				schema: 'not-run',
				detail: messageOf(error),
			});
		}
		for (const [name, value] of [...credentialEnvironment, ...isolatedEnvironment]) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		try {
			fs.rmSync(tmp, { recursive: true, force: true });
		} catch (error) {
			record({
				id: 'harness.cleanup',
				tool: null,
				status: 'FAIL',
				outcome: 'cleanup-error',
				schema: 'not-run',
				detail: messageOf(error),
			});
		}
	}
	if (manifest(repository, locations).sha256 !== provenance.sha256)
		record({
			id: 'evidence.source-drift',
			tool: null,
			status: 'FAIL',
			outcome: 'harness-error',
			schema: 'not-run',
			detail: 'Source, build or fixture changed during this run',
		});
	const summary = {
		cases: results.length,
		pass: results.filter((r) => r.status === 'PASS').length,
		fail: results.filter((r) => r.status === 'FAIL').length,
		schemaValidatedSuccesses: results.filter(
			(r) => r.status === 'PASS' && r.outcome === 'success' && r.schema === 'valid'
		).length,
		expectedRefusals: results.filter(
			(r) => r.status === 'PASS' && ['returned-error', 'thrown-error'].includes(r.outcome)
		).length,
	};
	const receipt = redactDiagnostics({
		version: 1,
		repositoryRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
			cwd: repository,
			encoding: 'utf8',
		}).trim(),
		startedAt,
		finishedAt: new Date().toISOString(),
		invocation: process.argv.slice(1),
		runtime: { node: process.version, platform: process.platform, arch: process.arch },
		boundary:
			'Direct registered handlers in one local process; no MCP wire or commercial-host compatibility claim. Local-only provider refusals; no paid calls. Synthetic fixture checks do not establish editorial accuracy or native Scrivener interoperability. Discovery uses a disposable home; native detection uses an empty command PATH. Queues use an explicit held loopback listener that immediately closes sockets for embedded fallback; bounded internal status polling and spool retrieval coordinate fixture postconditions and is not a transport or latency measurement.',
		provenance,
		registry: byName
			? [...byName.values()].map((tool) => ({
					name: tool.name,
					outputSchemaSha256: tool.outputSchema ? jsonDigest(tool.outputSchema) : null,
				}))
			: [],
		summary,
		cases: results,
	});
	if (receiptPath)
		fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
	out(
		`Conformance: ${summary.pass} pass, ${summary.fail} fail; ${summary.schemaValidatedSuccesses} schema-validated successes, ${summary.expectedRefusals} expected refusals.`
	);
	process.exitCode = summary.fail ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
	main().catch((error) => {
		out(`harness error: ${messageOf(error)}`);
		process.exitCode = 1;
	});
