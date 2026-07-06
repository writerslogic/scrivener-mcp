/**
 * Error handling tests
 */

import {
	ApplicationError,
	ErrorCode,
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
				400
			);

			expect(error.message).toBe('Test error');
			expect(error.code).toBe(ErrorCode.VALIDATION_FAILED);
			expect(error.details).toEqual({ field: 'test' });
			expect(error.statusCode).toBe(400);
			expect(error.name).toBe('AppError');
		});

		it('should expose serializable properties', () => {
			const error = new ApplicationError('Test', ErrorCode.UNKNOWN_ERROR);

			expect(error).toBeInstanceOf(Error);
			expect(error.message).toBe('Test');
			expect(error.code).toBe(ErrorCode.UNKNOWN_ERROR);
			expect(error.statusCode).toBe(500);
		});
	});

	describe('createError', () => {
		it('should use default message from code', () => {
			const error = createError(ErrorCode.PROJECT_NOT_OPEN);
			expect(error.message).toBe(`Error: ${ErrorCode.PROJECT_NOT_OPEN}`);
		});

		it('should use custom message', () => {
			const error = createError(ErrorCode.UNKNOWN_ERROR, null, 'Custom');
			expect(error.message).toBe('Custom');
		});

		it('should set the provided code', () => {
			const connectionError = createError(ErrorCode.CONNECTION_ERROR);
			expect(connectionError.code).toBe(ErrorCode.CONNECTION_ERROR);

			const validationError = createError(ErrorCode.VALIDATION_FAILED);
			expect(validationError.code).toBe(ErrorCode.VALIDATION_FAILED);
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
			const wrapped = wrapError(error, 'test-context');

			expect(wrapped).toBeInstanceOf(ApplicationError);
			expect(wrapped.message).toBe('Test');
			expect(wrapped.code).toBe(ErrorCode.PROJECT_ERROR);
		});

		it('should wrap string', () => {
			const wrapped = wrapError('String error');
			expect(wrapped).toBeInstanceOf(ApplicationError);
			expect((wrapped.details as { error: string }).error).toBe('String error');
		});

		it('should wrap unknown', () => {
			const wrapped = wrapError({ some: 'object' });
			expect(wrapped).toBeInstanceOf(ApplicationError);
			expect((wrapped.details as { error: string }).error).toBe('[object Object]');
		});
	});

	describe('withErrorHandling', () => {
		it('should return result on success', async () => {
			const result = await withErrorHandling(async () => 'success')();
			expect(result).toBe('success');
		});

		it('should wrap errors', async () => {
			await expect(
				withErrorHandling(async () => {
					throw new Error('fail');
				}, 'db-context')()
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
			const fn = jest
				.fn()
				.mockRejectedValueOnce(createError(ErrorCode.CONNECTION_ERROR))
				.mockResolvedValue('success');

			const result = await withRetry(fn, { maxAttempts: 3, initialDelay: 10 });
			expect(result).toBe('success');
			expect(fn).toHaveBeenCalledTimes(2);
		});

		it('should not retry when shouldRetry rejects the error', async () => {
			const fn = jest.fn().mockRejectedValue(createError(ErrorCode.VALIDATION_FAILED));
			const shouldRetry = (e: Error): boolean =>
				(e as ApplicationError).code === ErrorCode.CONNECTION_ERROR;

			await expect(
				withRetry(fn, { maxAttempts: 3, initialDelay: 10, shouldRetry })
			).rejects.toThrow();
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it('should fail after max retries', async () => {
			const fn = jest.fn().mockRejectedValue(createError(ErrorCode.CONNECTION_ERROR));

			await expect(withRetry(fn, { maxAttempts: 2, initialDelay: 10 })).rejects.toThrow();
			expect(fn).toHaveBeenCalledTimes(2);
		});
	});
});
