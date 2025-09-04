import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sampleDir = path.join(__dirname, 'sample-project.scriv', 'Files', 'Data');

// Generic test content for different types of documents
const testContents = [
  // Simple text
  `{\\rtf1\\ansi\\ansicpg1252\\cocoartf2864
\\cocoatextscaling0\\cocoaplatform0{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;}
{\\colortbl;\\red255\\green255\\blue255;}
{\\*\\expandedcolortbl;;\\csgray\\c100000;}
\\pard\\tx560\\tx1120\\tx1680\\tx2240\\tx2800\\tx3360\\tx3920\\tx4480\\tx5040\\tx5600\\tx6160\\tx6720\\sl288\\slmult1\\pardirnatural

\\f0\\fs24 \\cf0 This is a simple test document with plain text content. It contains some basic information for testing purposes.}`,
  
  // Text with formatting
  `{\\rtf1\\ansi\\ansicpg1252\\cocoartf2864
\\cocoatextscaling0\\cocoaplatform0{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;}
{\\colortbl;\\red255\\green255\\blue255;}
{\\*\\expandedcolortbl;;\\csgray\\c100000;}
\\pard\\tx560\\tx1120\\tx1680\\tx2240\\tx2800\\tx3360\\tx3920\\tx4480\\tx5040\\tx5600\\tx6160\\tx6720\\sl288\\slmult1\\pardirnatural

\\f0\\fs24 \\cf0 This document contains \\b bold text\\b0  and \\i italic text\\i0  for testing formatting. It also has multiple paragraphs.\\
\\
This is the second paragraph with more content to test paragraph handling.}`,

  // Longer content
  `{\\rtf1\\ansi\\ansicpg1252\\cocoartf2864
\\cocoatextscaling0\\cocoaplatform0{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;}
{\\colortbl;\\red255\\green255\\blue255;}
{\\*\\expandedcolortbl;;\\csgray\\c100000;}
\\pard\\tx560\\tx1120\\tx1680\\tx2240\\tx2800\\tx3360\\tx3920\\tx4480\\tx5040\\tx5600\\tx6160\\tx6720\\sl288\\slmult1\\pardirnatural

\\f0\\fs24 \\cf0 Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.\\
\\
Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.\\
\\
Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis.}`,

  // List content
  `{\\rtf1\\ansi\\ansicpg1252\\cocoartf2864
\\cocoatextscaling0\\cocoaplatform0{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;}
{\\colortbl;\\red255\\green255\\blue255;}
{\\*\\expandedcolortbl;;\\csgray\\c100000;}
\\pard\\tx560\\tx1120\\tx1680\\tx2240\\tx2800\\tx3360\\tx3920\\tx4480\\tx5040\\tx5600\\tx6160\\tx6720\\sl288\\slmult1\\pardirnatural

\\f0\\fs24 \\cf0 Test List:\\
• Item one with some text\\
• Item two with more information\\
• Item three for completeness\\
\\
Additional notes after the list.}`,

  // Empty document
  `{\\rtf1\\ansi\\ansicpg1252\\cocoartf2864
\\cocoatextscaling0\\cocoaplatform0{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;}
{\\colortbl;\\red255\\green255\\blue255;}
{\\*\\expandedcolortbl;;\\csgray\\c100000;}
\\pard\\tx560\\tx1120\\tx1680\\tx2240\\tx2800\\tx3360\\tx3920\\tx4480\\tx5040\\tx5600\\tx6160\\tx6720\\sl288\\slmult1\\pardirnatural

\\f0\\fs24 \\cf0 }`
];

async function cleanSampleContent() {
  console.log('Cleaning sample project content...');
  
  // Get all UUID directories
  const dirs = await fs.readdir(sampleDir);
  let count = 0;
  
  for (const uuid of dirs) {
    const dirPath = path.join(sampleDir, uuid);
    const stat = await fs.stat(dirPath);
    
    if (stat.isDirectory()) {
      const rtfPath = path.join(dirPath, 'content.rtf');
      
      try {
        // Check if content.rtf exists
        await fs.access(rtfPath);
        
        // Select a test content based on index rotation
        const testContent = testContents[count % testContents.length];
        
        // Write the generic test content
        await fs.writeFile(rtfPath, testContent, 'utf-8');
        
        count++;
        
        if (count <= 10) {
          console.log(`  Cleaned ${uuid} with test content type ${count % testContents.length}`);
        }
      } catch (e) {
        // File doesn't exist or can't be accessed, skip
      }
    }
  }
  
  console.log(`\nCleaned ${count} documents total.`);
  console.log('Sample project is now ready for testing with generic content.');
}

cleanSampleContent().catch(console.error);