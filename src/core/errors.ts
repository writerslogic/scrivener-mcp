/**
 * Centralized error handling - utilizes utils/common.ts
 */

// Re-export error handling utilities from utils/common.ts to maintain backward compatibility
export {
	ErrorCode,
	AppError as ApplicationError,
	createError,
	handleError as wrapError,
	withErrorHandling,
} from '../utils/common.js';

// Re-export retry functionality
export { retry as withRetry } from '../utils/common.js';
