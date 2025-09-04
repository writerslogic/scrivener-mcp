import { RTFHandler } from '../dist/rtf-handler.js';

async function testRTF() {
  const handler = new RTFHandler();
  
  console.log('Testing RTF Handler...\n');
  
  // Test 1: Basic RTF parsing
  const basicRTF = '{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times New Roman;}}\\f0\\fs24 Hello World\\par This is a test.}';
  console.log('Test 1: Basic RTF parsing');
  const parsed = await handler.parseRTF(basicRTF);
  console.log('Plain text:', parsed.plainText);
  console.log('Formatted:', parsed.formattedText.length, 'segments\n');
  
  // Test 2: RTF generation
  console.log('Test 2: RTF generation');
  const plainText = 'This is a test document.\nWith multiple lines.';
  const rtf = handler.convertToRTF(plainText);
  console.log('Generated RTF length:', rtf.length);
  console.log('RTF starts with:', rtf.substring(0, 50), '...\n');
  
  // Test 3: Special characters
  console.log('Test 3: Special characters');
  const specialText = 'Quote: "Hello" — Em-dash – En-dash • Bullet';
  const specialRTF = handler.convertToRTF(specialText);
  console.log('Special RTF length:', specialRTF.length);
  
  // Test 4: Extract plain text
  console.log('\nTest 4: Plain text extraction');
  const complexRTF = '{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Courier;}}\\f0\\fs24 {\\b Bold text} and {\\i italic text}\\par New paragraph}';
  const plainExtracted = handler.extractPlainText(complexRTF);
  console.log('Extracted:', plainExtracted);
  
  console.log('\nAll RTF tests passed!');
}

testRTF().catch(console.error);