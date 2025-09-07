/**
 * Error handling tests
 */

import {
	ApplicationError,
	ErrorCode,
	ErrorMessages,
	createError,
	wrapError,
	withErrorHandling,
	withRetry,
} from '../../../src/core/errors';

describe('Error Handling', () => {
	describe('ApplicationError', () => {
		it('should create error with all properties', () => {
			const error = new ApplicationError(
				'Test error',
				ErrorCode.VALIDATION_FAILED,
				{ field: 'test' },
				true
			);
			
			expect(error.message).toBe('Test error');
			expect(error.code).toBe(ErrorCode.VALIDATION_FAILED);
			expect(error.details).toEqual({ field: 'test' });
			expect(error.isRetryable).toBe(true);
			expect(error.name).toBe('ApplicationError');
		});
		
		it('should serialize to JSON', () => {
			const error = new ApplicationError('Test', ErrorCode.UNKNOWN_ERROR);
			const json = error.toJSON();
			
			expect(json).toHaveProperty('message', 'Test');
			expect(json).toHaveProperty('code', ErrorCode.UNKNOWN_ERROR);
			expect(json).toHaveProperty('isRetryable', false);
		});
	});
	
	describe('createError', () => {
		it('should use standard message', () => {
			const error = createError(ErrorCode.PROJECT_NOT_OPEN);
			expect(error.message).toBe(ErrorMessages[ErrorCode.PROJECT_NOT_OPEN]);
		});
		
		it('should use custom message', () => {
			const error = createError(ErrorCode.UNKNOWN_ERROR, null, 'Custom');
			expect(error.message).toBe('Custom');
		});
		
		it('should mark retryable errors', () => {
			const connectionError = createError(ErrorCode.CONNECTION_ERROR);
			expect(connectionError.isRetryable).toBe(true);
			
			const validationError = createError(ErrorCode.VALIDATION_FAILED);
			expect(validationError.isRetryable).toBe(false);
		});
	});
	
	describe('wrapError', () => {
		it('should return ApplicationError unchanged', () => {
			const appError = createError(ErrorCode.DATABASE_ERROR);
			const wrapped = wrapError(appError);
			expect(wrapped).toBe(appError);
		});
		
		it('should wrap Error', () => {
			const error = new Error('Test');
			const wrapped = wrapError(error, ErrorCode.UNKNOWN_ERROR);
			
			expect(wrapped).toBeInstanceOf(ApplicationError);
			expect(wrapped.message).toBe('Test');
			expect(wrapped.code).toBe(ErrorCode.UNKNOWN_ERROR);
		});
		
		it('should wrap string', () => {
			const wrapped = wrapError('String error');
			expect(wrapped.message).toBe('String error');
		});
		
		it('should wrap unknown', () => {
			const wrapped = wrapError({ some: 'object' });
			expect(wrapped.message).toBe('[object Object]');
		});
	});
	
	describe('withErrorHandling', () => {
		it('should return result on success', async () => {
			const result = await withErrorHandling(async () => 'success');
			expect(result).toBe('success');
		});
		
		it('should wrap errors', async () => {
			await expect(
				withErrorHandling(
					async () => { throw new Error('fail'); },
					ErrorCode.DATABASE_ERROR
				)
			).rejects.toThrow(ApplicationError);
		});
	});
	
	describe('withRetry', () => {
		it('should succeed on first try', async () => {
			const fn = jest.fn().mockResolvedValue('success');
			const result = await withRetry(fn);
			
			expect(result).toBe('success');
			expect(fn).toHaveBeenCalledTimes(1);
		});
		
		it('should retry on retryable error', async () => {
			const fn = jest.fn()
				.mockRejectedValueOnce(createError(ErrorCode.CONNECTION_ERROR))
				.mockResolvedValue('success');
			
			const result = await withRetry(fn, 3, 10);
			expect(result).toBe('success');
			expect(fn).toHaveBeenCalledTimes(2);
		});
		
		it('should not retry non-retryable error', async () => {
			const fn = jest.fn()
				.mockRejectedValue(createError(ErrorCode.VALIDATION_FAILED));
			
			await expect(withRetry(fn, 3, 10)).rejects.toThrow();
			expect(fn).toHaveBeenCalledTimes(1);
		});
		
		it('should fail after max retries', async () => {
			const fn = jest.fn()
				.mockRejectedValue(createError(ErrorCode.CONNECTION_ERROR));
			
			await expect(withRetry(fn, 2, 10)).rejects.toThrow();
			expect(fn).toHaveBeenCalledTimes(2);
		});
	});
});