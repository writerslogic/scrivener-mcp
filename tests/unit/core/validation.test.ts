/**
 * Validation tests
 */

import {
	validate,
	CommonSchemas,
	sanitizeString,
	sanitizeHtml,
	validatePath,
	isString,
	isNumber,
	isBoolean,
	isArray,
	isObject,
	isDefined,
	assertType,
} from '../../../src/core/validation';
import { ErrorCode } from '../../../src/core/errors';
import type { ValidationSchema } from '../../../src/types';

describe('Validation', () => {
	describe('validate', () => {
		const schema: ValidationSchema = {
			name: { type: 'string', required: true, minLength: 1 },
			age: { type: 'number', required: false, min: 0, max: 120 },
			email: { type: 'string', pattern: /^[^@]+@[^@]+$/ },
		};
		
		it('should validate valid data', () => {
			expect(() => validate(
				{ name: 'John', age: 30, email: 'john@example.com' },
				schema
			)).not.toThrow();
		});
		
		it('should reject missing required fields', () => {
			expect(() => validate(
				{ age: 30 },
				schema
			)).toThrow();
		});
		
		it('should reject invalid types', () => {
			expect(() => validate(
				{ name: 123 },
				schema
			)).toThrow();
		});
		
		it('should validate string constraints', () => {
			expect(() => validate(
				{ name: '' },
				schema
			)).toThrow();
		});
		
		it('should validate number constraints', () => {
			expect(() => validate(
				{ name: 'John', age: 150 },
				schema
			)).toThrow();
		});
		
		it('should validate patterns', () => {
			expect(() => validate(
				{ name: 'John', email: 'invalid' },
				schema
			)).toThrow();
		});
		
		it('should validate arrays', () => {
			const arraySchema: ValidationSchema = {
				items: { type: 'array', minLength: 1, maxLength: 3 },
			};
			
			expect(() => validate({ items: [] }, arraySchema)).toThrow();
			expect(() => validate({ items: [1, 2] }, arraySchema)).not.toThrow();
			expect(() => validate({ items: [1, 2, 3, 4] }, arraySchema)).toThrow();
		});
		
		it('should validate enums', () => {
			const enumSchema: ValidationSchema = {
				status: { type: 'string', enum: ['active', 'inactive'] },
			};
			
			expect(() => validate({ status: 'active' }, enumSchema)).not.toThrow();
			expect(() => validate({ status: 'unknown' }, enumSchema)).toThrow();
		});
		
		it('should validate custom validators', () => {
			const customSchema: ValidationSchema = {
				even: {
					type: 'number',
					custom: (v) => typeof v === 'number' && v % 2 === 0,
				},
			};
			
			expect(() => validate({ even: 4 }, customSchema)).not.toThrow();
			expect(() => validate({ even: 3 }, customSchema)).toThrow();
		});
	});
	
	describe('CommonSchemas', () => {
		it('should validate document ID', () => {
			expect(() => validate(
				{ documentId: 'ABC123-DEF456' },
				CommonSchemas.documentId
			)).not.toThrow();
			
			expect(() => validate(
				{ documentId: 'invalid!' },
				CommonSchemas.documentId
			)).toThrow();
		});
		
		it('should validate title', () => {
			expect(() => validate(
				{ title: 'Valid Title' },
				CommonSchemas.title
			)).not.toThrow();
			
			expect(() => validate(
				{ title: '' },
				CommonSchemas.title
			)).toThrow();
		});
		
		it('should validate path', () => {
			expect(() => validate(
				{ path: '/valid/path' },
				CommonSchemas.path
			)).not.toThrow();
			
			expect(() => validate(
				{ path: '../traversal' },
				CommonSchemas.path
			)).toThrow();
		});
	});
	
	describe('sanitizeString', () => {
		it('should remove control characters', () => {
			const input = 'Hello\x00World\x1F';
			expect(sanitizeString(input)).toBe('HelloWorld');
		});
		
		it('should trim whitespace', () => {
			expect(sanitizeString('  hello  ')).toBe('hello');
		});
		
		it('should limit length', () => {
			const long = 'a'.repeat(2000);
			expect(sanitizeString(long, 100)).toHaveLength(100);
		});
	});
	
	describe('sanitizeHtml', () => {
		it('should remove script tags', () => {
			const html = '<p>Hello</p><script>alert(1)</script>';
			expect(sanitizeHtml(html)).toBe('<p>Hello</p>');
		});
		
		it('should remove event handlers', () => {
			const html = '<div onclick="alert(1)">Click</div>';
			expect(sanitizeHtml(html)).not.toContain('onclick');
		});
		
		it('should remove javascript: urls', () => {
			const html = '<a href="javascript:alert(1)">Link</a>';
			expect(sanitizeHtml(html)).not.toContain('javascript:');
		});
	});
	
	describe('validatePath', () => {
		it('should accept valid paths', () => {
			expect(validatePath('/valid/path')).toBe('/valid/path');
			expect(validatePath('C:\\Windows\\System32')).toBeTruthy();
		});
		
		it('should reject path traversal', () => {
			expect(() => validatePath('../etc/passwd')).toThrow();
		});
		
		it('should remove dangerous characters', () => {
			expect(validatePath('file<>name')).toBe('filename');
		});
		
		it('should normalize slashes', () => {
			expect(validatePath('path//to///file')).toBe('path/to/file');
		});
	});
	
	describe('Type Guards', () => {
		it('should check string', () => {
			expect(isString('hello')).toBe(true);
			expect(isString(123)).toBe(false);
		});
		
		it('should check number', () => {
			expect(isNumber(123)).toBe(true);
			expect(isNumber(NaN)).toBe(false);
			expect(isNumber('123')).toBe(false);
		});
		
		it('should check boolean', () => {
			expect(isBoolean(true)).toBe(true);
			expect(isBoolean(1)).toBe(false);
		});
		
		it('should check array', () => {
			expect(isArray([1, 2, 3])).toBe(true);
			expect(isArray('array')).toBe(false);
		});
		
		it('should check object', () => {
			expect(isObject({})).toBe(true);
			expect(isObject([])).toBe(false);
			expect(isObject(null)).toBe(false);
		});
		
		it('should check defined', () => {
			expect(isDefined('value')).toBe(true);
			expect(isDefined(0)).toBe(true);
			expect(isDefined(undefined)).toBe(false);
			expect(isDefined(null)).toBe(false);
		});
	});
	
	describe('assertType', () => {
		it('should return value if type matches', () => {
			const value = assertType('hello', isString, 'field');
			expect(value).toBe('hello');
		});
		
		it('should throw if type does not match', () => {
			expect(() => assertType(123, isString, 'field')).toThrow();
		});
	});
});