/**
 * Project management handlers - utilizes common utilities for validation and error handling
 */

import {
	closeProjectHandler,
	openProjectHandler,
	refreshProjectHandler,
} from './project-handlers/lifecycle.js';
import { getStructureHandler } from './project-handlers/structure.js';
import { detectOpenProjectHandler, discoverProjectsHandler } from './project-handlers/discovery.js';
import {
	getCompileSettingsHandler,
	getManuscriptBriefingHandler,
} from './project-handlers/manuscript.js';
import {
	compareSnapshotHandler,
	createSnapshotHandler,
	listSnapshotsHandler,
	readSnapshotHandler,
} from './project-handlers/snapshots.js';

export {
	openProjectHandler,
	refreshProjectHandler,
	closeProjectHandler,
} from './project-handlers/lifecycle.js';
export { getStructureHandler } from './project-handlers/structure.js';
export { discoverProjectsHandler, detectOpenProjectHandler } from './project-handlers/discovery.js';
export {
	getCompileSettingsHandler,
	getManuscriptBriefingHandler,
} from './project-handlers/manuscript.js';
export {
	listSnapshotsHandler,
	readSnapshotHandler,
	compareSnapshotHandler,
	createSnapshotHandler,
} from './project-handlers/snapshots.js';

export const projectHandlers = [
	openProjectHandler,
	getStructureHandler,
	refreshProjectHandler,
	closeProjectHandler,
	discoverProjectsHandler,
	detectOpenProjectHandler,
	getCompileSettingsHandler,
	getManuscriptBriefingHandler,
	listSnapshotsHandler,
	readSnapshotHandler,
	compareSnapshotHandler,
	createSnapshotHandler,
];
