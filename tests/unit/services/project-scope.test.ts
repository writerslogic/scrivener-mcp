import {
	createQueueScope,
	ownsJobId,
	readScopedJob,
	scopeJob,
	scopedJobId,
} from '../../../src/services/queue/project-scope.js';

const scope = createQueueScope('fixture', '/fixture.scriv');

test('captures an independent JSON snapshot with the same semantics as Redis', () => {
	const payload = {
		content: 'Original 🌙',
		options: { includeReadability: true },
		values: [null, {}, false],
	};
	const snapshot = scopeJob(scope, 'analyze_document', payload);
	payload.content = 'Changed';
	payload.options.includeReadability = false;
	payload.values.splice(0, 1);
	expect(snapshot.payload).toEqual({
		content: 'Original 🌙',
		options: { includeReadability: true },
		values: [null, {}, false],
	});
});

test.each([undefined, null, [], 'text', 1])('rejects a custom JSON conversion to %j', (value) => {
	expect(() => scopeJob(scope, 'analyze_document', { toJSON: () => value })).toThrow(/object/);
});

test('rejects cyclic payloads before they can be queued', () => {
	const payload: Record<string, unknown> = {};
	payload.self = payload;
	expect(() => scopeJob(scope, 'analyze_document', payload)).toThrow(/circular/i);
});

test('requires all ownership fields to be own properties', () => {
	const id = scopedJobId(scope);
	const envelope = scopeJob(scope, 'analyze_document', { content: 'Original' });
	expect(ownsJobId(scope, id)).toBe(true);
	expect(readScopedJob(scope, 'analyze_document', id, envelope)).toEqual(envelope.payload);
	const inherited = Object.assign(Object.create({ projectId: scope.projectId }), envelope);
	delete inherited.projectId;
	inherited.foreign = true;
	expect(() => readScopedJob(scope, 'analyze_document', id, inherited)).toThrow(/ownership/);
});
