import { randomUUID } from 'node:crypto';
import { isValidUUID } from '../../utils/common.js';
import type { PersistentStore } from './persistent-store.js';

export function getOrCreateProjectIdentity(store: PersistentStore): string {
	return store.transaction(() => {
		const existing = store.get<unknown>('identity', 'project');
		if (existing !== undefined) {
			if (typeof existing !== 'string' || !isValidUUID(existing))
				throw new Error('Stored project identity is invalid; restore its original history');
			return existing;
		}
		const identity = randomUUID();
		store.put('identity', 'project', identity);
		return identity;
	});
}
