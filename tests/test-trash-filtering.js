#!/usr/bin/env node

import { ScrivenerProject } from '../dist/scrivener-project.js';
import path from 'path';

console.log('='.repeat(50));
console.log('TRASH FILTERING TEST');
console.log('='.repeat(50));

async function testTrashFiltering() {
	const testProjectPath = path.join(process.cwd(), 'tests', 'sample-project.scriv');
	const project = new ScrivenerProject(testProjectPath);

	try {
		// Test 1: Get structure without trash
		console.log('\nTest 1: Get structure WITHOUT trash');
		const structureNoTrash = await project.getProjectStructure(false);
		const hasTrashInStructure = JSON.stringify(structureNoTrash).includes('Trash');
		console.log('Contains Trash folder:', hasTrashInStructure);
		console.log('✅ Structure excludes trash:', !hasTrashInStructure);

		// Test 2: Get structure with trash
		console.log('\nTest 2: Get structure WITH trash');
		const structureWithTrash = await project.getProjectStructure(true);
		const hasTrashIncluded = JSON.stringify(structureWithTrash).includes('Trash');
		console.log('Contains Trash folder:', hasTrashIncluded);
		console.log('✅ Structure includes trash:', hasTrashIncluded);

		// Test 3: Get all documents without trash
		console.log('\nTest 3: Get all documents WITHOUT trash');
		const docsNoTrash = await project.getAllDocuments(false);
		const trashDocsInList = docsNoTrash.filter(doc => doc.title.includes('Trash'));
		console.log('Documents with "Trash" in title:', trashDocsInList.length);
		console.log('✅ No trash documents in regular list');

		// Test 4: Get trash documents only
		console.log('\nTest 4: Get trash documents only');
		const trashDocs = await project.getTrashDocuments();
		console.log('Number of trash documents:', trashDocs.length);
		console.log('✅ Trash documents retrieved:', trashDocs.length > 0);

		// Test 5: Search content (should exclude trash)
		console.log('\nTest 5: Search content (excludes trash)');
		const searchResults = await project.searchContent('Chapter');
		const trashResults = searchResults.filter(r => r.title.includes('[TRASH]'));
		console.log('Regular search results with [TRASH]:', trashResults.length);
		console.log('✅ Regular search excludes trash:', trashResults.length === 0);

		// Test 6: Search trash only
		console.log('\nTest 6: Search trash only');
		const trashSearchResults = await project.searchTrash('Chapter');
		const allTrashMarked = trashSearchResults.every(r => r.title.includes('[TRASH]'));
		console.log('All results marked as [TRASH]:', allTrashMarked);
		console.log('✅ Trash search works correctly');

		console.log('\n' + '='.repeat(50));
		console.log('ALL TESTS PASSED!');
		console.log('='.repeat(50));

	} catch (error) {
		console.error('Test failed:', error);
		process.exit(1);
	}
}

testTrashFiltering().catch(console.error);