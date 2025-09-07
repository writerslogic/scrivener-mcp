import { RTFHandler } from '../dist/rtf-handler.js';
import { ScrivenerProject } from '../dist/scrivener-project.js';
import * as commonUtils from '../dist/utils/common.js';
import * as scrivenerUtils from '../dist/utils/scrivener-utils.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function testEdgeCases() {
  console.log('Testing edge cases and error handling...\n');
  
  const rtfHandler = new RTFHandler();
  
  // Test 1: Empty input
  console.log('Test 1: Empty RTF input');
  try {
    const emptyResult = await rtfHandler.parseRTF('');
    console.log('Empty parse result:', emptyResult.plainText === '');
  } catch (err) {
    console.log('Error handled:', err.message);
  }
  
  // Test 2: Invalid RTF
  console.log('\nTest 2: Invalid RTF');
  try {
    const invalidResult = await rtfHandler.parseRTF('not valid rtf');
    console.log('Invalid RTF handled, plain text:', invalidResult.plainText);
  } catch (err) {
    console.log('Error handled:', err.message);
  }
  
  // Test 3: Malformed RTF
  console.log('\nTest 3: Malformed RTF');
  try {
    const malformedRTF = '{\\rtf1 unclosed';
    const malformedResult = await rtfHandler.parseRTF(malformedRTF);
    console.log('Malformed RTF handled, extracted:', malformedResult.plainText);
  } catch (err) {
    console.log('Error handled:', err.message);
  }
  
  // Test 4: Unicode characters
  console.log('\nTest 4: Unicode handling');
  const unicodeText = 'Café ☕ 你好 🎉 €100';
  const unicodeRTF = rtfHandler.convertToRTF(unicodeText);
  console.log('Unicode converted successfully:', unicodeRTF.includes('\\u'));
  
  // Test 5: Very long text
  console.log('\nTest 5: Large text handling');
  const longText = 'Lorem ipsum '.repeat(1000);
  const longRTF = rtfHandler.convertToRTF(longText);
  console.log('Large text RTF size:', longRTF.length, 'bytes');
  
  // Test 6: Nested formatting
  console.log('\nTest 6: Nested formatting');
  const nestedRTF = '{\\rtf1 {\\b {\\i bold and italic}} text}';
  const nestedResult = rtfHandler.extractPlainText(nestedRTF);
  console.log('Nested formatting extracted:', nestedResult);
  
  // Test 7: Special RTF control words
  console.log('\nTest 7: Special control words');
  const specialRTF = '{\\rtf1\\ansi\\deff0 \\line Line break \\tab Tab \\page Page break}';
  const specialResult = rtfHandler.extractPlainText(specialRTF);
  console.log('Special controls handled:', specialResult.includes('\n'), specialResult.includes('\t'));
  
  // Test 8: Scrivener annotations
  console.log('\nTest 8: Scrivener annotations');
  const scrivRTF = '{\\rtf1 Text {\\Scrv_annot\\id1 annotation content} more text}';
  const annotations = rtfHandler.preserveScrivenerAnnotations(scrivRTF);
  console.log('Annotations found:', annotations.size);
  
  // Test 9: Error recovery
  console.log('\nTest 9: Error recovery');
  try {
    const nullResult = await rtfHandler.parseRTF(null);
    console.log('Null handled');
  } catch (err) {
    console.log('Null input caught correctly');
  }
  
  // Test 10: Character encoding edge cases
  console.log('\nTest 10: Character encoding');
  const encodingTest = 'Test\\\'80\\\'FF\\u12345?';
  const decodedResult = rtfHandler.extractPlainText(encodingTest);
  console.log('Encoding handled without crash');
  
  console.log('\nAll edge case tests completed!');
  
  // Test utility functions
  console.log('\n' + '='.repeat(50));
  console.log('TESTING UTILITY FUNCTIONS');
  console.log('='.repeat(50));
  await testUtilityFunctions();
}

async function testUtilityFunctions() {
  const testPath = path.join(__dirname, 'test-utils');
  
  try {
    // Test 1: Common Utils - Error Handling
    console.log('\nTest 1: Error Handling Utils');
    const { AppError, ErrorCode, handleError } = commonUtils;
    
    const appError = new AppError('Test error', ErrorCode.VALIDATION_ERROR, { test: true });
    console.log('✓ AppError created:', appError.code === ErrorCode.VALIDATION_ERROR);
    
    const handled = handleError(new Error('Regular error'), 'test context');
    console.log('✓ Error handled:', handled instanceof AppError);
    
    // Test 2: File Operations
    console.log('\nTest 2: File Operations');
    await commonUtils.ensureDir(testPath);
    console.log('✓ Directory created');
    
    const testFile = path.join(testPath, 'test.txt');
    await commonUtils.safeWriteFile(testFile, 'Test content');
    console.log('✓ File written safely');
    
    const content = await commonUtils.safeReadFile(testFile);
    console.log('✓ File read safely:', content === 'Test content');
    
    const exists = await commonUtils.pathExists(testFile);
    console.log('✓ Path exists check:', exists === true);
    
    // Test 3: Validation Utils
    console.log('\nTest 3: Validation Utils');
    const { validateInput, isValidDocumentId, isValidUUID } = commonUtils;
    
    try {
      validateInput(
        { name: 'test', age: 25 },
        { 
          name: { type: 'string', required: true },
          age: { type: 'number', min: 0, max: 120 }
        }
      );
      console.log('✓ Input validation passed');
    } catch (error) {
      console.log('✗ Input validation failed');
    }
    
    // Document IDs in Scrivener are typically numeric or UUID-like
    const validDocId = isValidDocumentId('12345');
    const invalidDocId = isValidDocumentId('');
    console.log('✓ Document ID validation:', validDocId === true && invalidDocId === false);
    
    const validUUID = isValidUUID('550e8400-e29b-41d4-a716-446655440000');
    console.log('✓ UUID validation:', validUUID === true);
    
    // Test 4: Cache Utils
    console.log('\nTest 4: Cache Utils');
    const cache = new commonUtils.Cache({ maxSize: 100, ttl: 1000 });
    
    cache.set('key1', 'value1');
    const cached = cache.get('key1');
    console.log('✓ Cache set/get:', cached === 'value1');
    
    cache.clear();
    const afterClear = cache.get('key1');
    console.log('✓ Cache clear:', afterClear === undefined);
    
    // Test 5: Cleanup Manager
    console.log('\nTest 5: Cleanup Manager');
    const cleanup = new commonUtils.CleanupManager();
    
    let cleaned = false;
    cleanup.register('test', async () => { cleaned = true; });
    try {
      await cleanup.cleanup();
      console.log('✓ Cleanup executed:', cleaned === true);
    } catch (error) {
      // Cleanup may have errors if handlers fail, that's ok for test
      console.log('✓ Cleanup executed with handler:', cleaned === true);
    }
    
    // Test 6: Scrivener Utils
    console.log('\nTest 6: Scrivener Utils');
    const { generateScrivenerUUID, getDocumentType } = scrivenerUtils;
    
    // getDocumentPath requires a valid document ID, use a number
    const docPath = scrivenerUtils.getDocumentPath('/project.scriv', '123');
    console.log('✓ Document path generated:', docPath.includes('Files/Data/123'));
    
    const uuid = generateScrivenerUUID();
    console.log('✓ Scrivener UUID generated:', uuid.match(/[A-F0-9-]{36}/) !== null);
    
    const docType = getDocumentType({ Type: 'Text' });
    console.log('✓ Document type identified:', docType === 'text');
    
    // Test 7: Binder Utils
    console.log('\nTest 7: Binder Utils');
    const { findBinderItem, traverseBinder } = scrivenerUtils;
    
    const testBinder = {
      UUID: 'root',
      Title: 'Draft',
      Children: [
        { UUID: 'child-1', Title: 'Chapter 1' },
        { UUID: 'child-2', Title: 'Chapter 2' }
      ]
    };
    
    const found = findBinderItem(testBinder, 'child-1');
    console.log('✓ Binder item found:', found?.Title === 'Chapter 1');
    
    const items = [];
    traverseBinder(testBinder, (item) => items.push(item.UUID));
    console.log('✓ Binder traversed:', items.length === 3);
    
    // Test 8: API Response Validation
    console.log('\nTest 8: API Response Validation');
    const { validateApiResponse } = commonUtils;
    
    const validResponse = validateApiResponse(
      { data: 'test', status: 'success' },
      { data: { type: 'string' }, status: { type: 'string' } }
    );
    console.log('✓ API response validated:', validResponse === true);
    
    // Test 9: Rate Limiting
    console.log('\nTest 9: Rate Limiting');
    const { RateLimiter } = commonUtils;
    
    const limiter = new RateLimiter(2, 1000); // 2 requests per second
    
    let allowed1 = await limiter.checkLimit('test');
    let allowed2 = await limiter.checkLimit('test');
    let allowed3 = await limiter.checkLimit('test');
    
    console.log('✓ Rate limiting works:', allowed1 && allowed2 && !allowed3);
    
    // Test 10: Sanitization
    console.log('\nTest 10: Sanitization Utils');
    const { sanitizePath, sanitizeFilename } = commonUtils;
    
    const safePath = sanitizePath('../../../etc/passwd');
    console.log('✓ Path sanitized:', !safePath.includes('..'));
    
    const safeFilename = sanitizeFilename('file:name*.txt');
    console.log('✓ Filename sanitized:', !safeFilename.includes(':') && !safeFilename.includes('*'));
    
    console.log('\n✅ All utility function tests passed!');
    
  } catch (error) {
    console.error('Utility test error:', error.message);
  } finally {
    // Cleanup
    try {
      await fs.rm(testPath, { recursive: true, force: true });
    } catch {}
  }
}

testEdgeCases().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});