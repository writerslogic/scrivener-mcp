import { RTFHandler } from '../dist/rtf-handler.js';
import { ScrivenerProject } from '../dist/scrivener-project.js';

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
}

testEdgeCases().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});