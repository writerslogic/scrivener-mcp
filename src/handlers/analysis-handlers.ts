/**
 * Content analysis and AI enhancement handlers
 */

import {
	analyzeDocumentHandler,
	enhanceContentHandler,
	generateContentHandler,
} from './analysis-handlers/document-analysis.js';
import { getMemoryHandler, updateMemoryHandler } from './analysis-handlers/memory.js';
import { checkConsistencyHandler } from './analysis-handlers/consistency.js';
import { multiAgentAnalysisHandler } from './analysis-handlers/advanced.js';

export {
	analyzeDocumentHandler,
	enhanceContentHandler,
	generateContentHandler,
} from './analysis-handlers/document-analysis.js';
export { updateMemoryHandler, getMemoryHandler } from './analysis-handlers/memory.js';
export { checkConsistencyHandler } from './analysis-handlers/consistency.js';
export { multiAgentAnalysisHandler, semanticSearchHandler } from './analysis-handlers/advanced.js';

export const analysisHandlers = [
	analyzeDocumentHandler,
	enhanceContentHandler,
	generateContentHandler,
	checkConsistencyHandler,
	multiAgentAnalysisHandler,
];

// remember/recall are the persistent-memory tools; they belong to the `memory`
// skill (see skill-registry) even though they are defined in this file.
export const memoryHandlers = [updateMemoryHandler, getMemoryHandler];
