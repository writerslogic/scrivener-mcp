import { MemoryManager } from '../dist/memory-manager.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';

console.log('Testing Memory Manager...\n');

// Create a temporary test directory
const testDir = path.join(process.cwd(), 'test-project');
const memoryDir = path.join(testDir, '.ai-memory');

// Helper function to clean up test directory
async function cleanup() {
    if (existsSync(testDir)) {
        await fs.rm(testDir, { recursive: true, force: true });
    }
}

// Test 1: Initialize Memory Manager
async function testInitialization() {
    console.log('Test 1: Memory Manager Initialization');
    
    await cleanup();
    await fs.mkdir(testDir, { recursive: true });
    
    const manager = new MemoryManager(testDir);
    await manager.initialize();
    
    // Check if memory directory was created
    const dirExists = existsSync(memoryDir);
    console.log('Memory directory created:', dirExists);
    
    // Check if memory file was created
    const memoryFile = path.join(memoryDir, 'project-memory.json');
    const fileExists = existsSync(memoryFile);
    console.log('Memory file created:', fileExists);
    
    manager.cleanup();
    
    return dirExists && fileExists;
}

// Test 2: Character Profile Management
async function testCharacterProfiles() {
    console.log('\nTest 2: Character Profile Management');
    
    const manager = new MemoryManager(testDir);
    await manager.initialize();
    
    // Add a character
    const character = manager.addCharacter({
        name: 'John Doe',
        role: 'protagonist',
        description: 'A brave detective',
        traits: ['intelligent', 'determined'],
        arc: 'From cynical to hopeful',
        relationships: [],
        appearances: [],
        notes: 'Main character'
    });
    
    console.log('Character added:', character.name, '(', character.id, ')');
    
    // Update character
    manager.updateCharacter(character.id, {
        traits: ['intelligent', 'determined', 'compassionate']
    });
    
    // Get character
    const retrieved = manager.getCharacter(character.id);
    console.log('Character retrieved:', retrieved?.name);
    console.log('Updated traits:', retrieved?.traits);
    
    // Get all characters
    const allCharacters = manager.getAllCharacters();
    console.log('Total characters:', allCharacters.length);
    
    manager.cleanup();
    
    return allCharacters.length === 1 && retrieved?.traits?.length === 3;
}

// Test 3: Style Guide Management
async function testStyleGuide() {
    console.log('\nTest 3: Style Guide Management');
    
    const manager = new MemoryManager(testDir);
    await manager.initialize();
    
    // Update style guide
    manager.updateStyleGuide({
        tone: ['dark', 'mysterious'],
        voice: 'noir detective',
        pov: 'first',
        tense: 'past',
        vocabularyLevel: 'advanced',
        sentenceComplexity: 'complex',
        paragraphLength: 'medium'
    });
    
    // Get style guide
    const styleGuide = manager.getStyleGuide();
    console.log('Style guide tone:', styleGuide.tone);
    console.log('Style guide voice:', styleGuide.voice);
    console.log('Style guide POV:', styleGuide.pov);
    
    manager.cleanup();
    
    return styleGuide.voice === 'noir detective' && styleGuide.pov === 'first';
}

// Test 4: Plot Thread Management
async function testPlotThreads() {
    console.log('\nTest 4: Plot Thread Management');
    
    const manager = new MemoryManager(testDir);
    await manager.initialize();
    
    // Add plot threads
    const thread1 = manager.addPlotThread({
        name: 'Main Mystery',
        description: 'The murder investigation',
        status: 'development',
        documents: ['doc1', 'doc2'],
        keyEvents: []
    });
    
    const thread2 = manager.addPlotThread({
        name: 'Romance Subplot',
        description: 'Detective falls in love',
        status: 'setup',
        documents: ['doc3'],
        keyEvents: []
    });
    
    console.log('Plot thread 1:', thread1.name);
    console.log('Plot thread 2:', thread2.name);
    
    // Update plot thread
    manager.updatePlotThread(thread1.id, {
        status: 'climax'
    });
    
    // Get all threads
    const threads = manager.getPlotThreads();
    console.log('Total plot threads:', threads.length);
    console.log('Thread 1 status:', threads.find(t => t.id === thread1.id)?.status);
    
    manager.cleanup();
    
    return threads.length === 2 && threads[0].status === 'climax';
}

// Test 5: Document Context
async function testDocumentContext() {
    console.log('\nTest 5: Document Context');
    
    const manager = new MemoryManager(testDir);
    await manager.initialize();
    
    // Set document context
    manager.setDocumentContext('doc123', {
        summary: 'Opening chapter introducing the detective',
        themes: ['mystery', 'noir'],
        sentiment: 'neutral',
        pacing: 'moderate',
        keyElements: ['detective', 'crime scene', 'clues'],
        suggestions: ['Add more sensory details'],
        continuityNotes: ['Remember the detective has a limp']
    });
    
    // Get document context
    const context = manager.getDocumentContext('doc123');
    console.log('Document summary:', context?.summary);
    console.log('Document themes:', context?.themes);
    console.log('Document pacing:', context?.pacing);
    
    manager.cleanup();
    
    return context?.themes?.includes('mystery') && context?.pacing === 'moderate';
}

// Test 6: Writing Statistics
async function testWritingStats() {
    console.log('\nTest 6: Writing Statistics');
    
    const manager = new MemoryManager(testDir);
    await manager.initialize();
    
    // Update writing stats
    manager.updateWritingStats({
        totalWords: 50000,
        averageChapterLength: 3000,
        sessionsCount: 25,
        lastSession: new Date().toISOString(),
        dailyWordCounts: [
            { date: '2024-01-01', count: 2000 },
            { date: '2024-01-02', count: 1500 }
        ],
        completionPercentage: 50
    });
    
    // Get writing stats
    const stats = manager.getWritingStats();
    console.log('Total words:', stats.totalWords);
    console.log('Sessions count:', stats.sessionsCount);
    console.log('Completion:', stats.completionPercentage + '%');
    
    manager.cleanup();
    
    return stats.totalWords === 50000 && stats.completionPercentage === 50;
}

// Test 7: Memory Persistence
async function testPersistence() {
    console.log('\nTest 7: Memory Persistence');
    
    // First manager instance
    let manager = new MemoryManager(testDir);
    await manager.initialize();
    
    manager.addCharacter({
        name: 'Jane Smith',
        role: 'antagonist',
        description: 'The villain',
        traits: ['cunning'],
        arc: 'Descent into madness',
        relationships: [],
        appearances: [],
        notes: ''
    });
    
    await manager.saveMemory();
    manager.cleanup();
    
    // Second manager instance - should load saved data
    manager = new MemoryManager(testDir);
    await manager.initialize();
    
    const characters = manager.getAllCharacters();
    const jane = characters.find(c => c.name === 'Jane Smith');
    console.log('Persisted character found:', jane?.name);
    console.log('Persisted character role:', jane?.role);
    
    manager.cleanup();
    
    return jane?.role === 'antagonist';
}

// Test 8: Custom Context
async function testCustomContext() {
    console.log('\nTest 8: Custom Context');
    
    const manager = new MemoryManager(testDir);
    await manager.initialize();
    
    // Set custom context
    manager.setCustomContext('worldBuilding', {
        setting: '1940s Los Angeles',
        atmosphere: 'noir, foggy nights',
        keyLocations: ['police station', 'jazz club', 'docks']
    });
    
    manager.setCustomContext('researchNotes', [
        'Check police procedures of 1940s',
        'Research jazz music of the era'
    ]);
    
    // Get custom context
    const world = manager.getCustomContext('worldBuilding');
    const notes = manager.getCustomContext('researchNotes');
    
    console.log('World setting:', world?.setting);
    console.log('Key locations:', world?.keyLocations);
    console.log('Research notes count:', notes?.length);
    
    manager.cleanup();
    
    return world?.setting === '1940s Los Angeles' && notes?.length === 2;
}

// Test 9: Memory Export/Import
async function testExportImport() {
    console.log('\nTest 9: Memory Export/Import');
    
    let manager = new MemoryManager(testDir);
    await manager.initialize();
    
    // Add some data
    manager.addCharacter({
        name: 'Export Test Character',
        role: 'minor',
        description: 'Test',
        traits: [],
        arc: '',
        relationships: [],
        appearances: [],
        notes: ''
    });
    
    manager.updateStyleGuide({
        voice: 'test voice'
    });
    
    // Export memory
    const exported = manager.getFullMemory();
    console.log('Exported memory version:', exported.version);
    console.log('Exported characters:', exported.characters.length);
    
    manager.cleanup();
    
    // Create new manager and import
    manager = new MemoryManager(testDir);
    await manager.initialize();
    await manager.importMemory(exported);
    
    const imported = manager.getFullMemory();
    console.log('Imported characters:', imported.characters.length);
    console.log('Imported style voice:', imported.styleGuide.voice);
    
    manager.cleanup();
    
    return imported.characters.length === 1 && imported.styleGuide.voice === 'test voice';
}

// Run all tests
async function runAllTests() {
    console.log('='.repeat(50));
    console.log('MEMORY MANAGER TEST SUITE');
    console.log('='.repeat(50));
    
    const tests = [
        { name: 'Initialization', fn: testInitialization },
        { name: 'Character Profiles', fn: testCharacterProfiles },
        { name: 'Style Guide', fn: testStyleGuide },
        { name: 'Plot Threads', fn: testPlotThreads },
        { name: 'Document Context', fn: testDocumentContext },
        { name: 'Writing Statistics', fn: testWritingStats },
        { name: 'Persistence', fn: testPersistence },
        { name: 'Custom Context', fn: testCustomContext },
        { name: 'Export/Import', fn: testExportImport }
    ];
    
    let passed = 0;
    let failed = 0;
    
    for (const test of tests) {
        try {
            const result = await test.fn();
            if (result) {
                console.log(`✅ ${test.name} PASSED\n`);
                passed++;
            } else {
                console.log(`❌ ${test.name} FAILED\n`);
                failed++;
            }
        } catch (error) {
            console.log(`❌ ${test.name} ERROR:`, error.message, '\n');
            failed++;
        }
    }
    
    // Cleanup
    await cleanup();
    
    console.log('='.repeat(50));
    console.log(`RESULTS: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(50));
    
    if (failed > 0) {
        process.exit(1);
    }
}

// Run the tests
runAllTests().catch(error => {
    console.error('Test suite error:', error);
    process.exit(1);
});