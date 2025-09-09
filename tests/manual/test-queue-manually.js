#!/usr/bin/env node
/**
 * Manual test to verify JobQueueService works with embedded queue
 * Run with: node test-queue-manually.js
 */

import { JobQueueService, JobType } from '../../dist/services/queue/job-queue.js';
import { mkdirSync } from 'fs';
import { join } from 'path';

async function testQueue() {
  console.log('Testing JobQueueService with embedded queue...\n');
  
  const testDir = './test-queue-manual';
  
  // Create test directory
  mkdirSync(testDir, { recursive: true });
  mkdirSync(join(testDir, '.scrivener-mcp'), { recursive: true });
  
  try {
    // Create JobQueueService without Redis URL (uses embedded)
    const jobQueue = new JobQueueService(undefined, testDir);
    
    console.log('1. Initializing JobQueueService...');
    await jobQueue.initialize();
    console.log('   ✓ Initialized successfully\n');
    
    console.log('2. Adding a test job...');
    const jobId = await jobQueue.addJob(
      JobType.ANALYZE_DOCUMENT,
      { documentId: 'test-doc', content: 'Test content' }
    );
    console.log(`   ✓ Job added with ID: ${jobId}\n`);
    
    console.log('3. Checking job status...');
    const status = await jobQueue.getJobStatus(JobType.ANALYZE_DOCUMENT, jobId);
    console.log(`   ✓ Job status: ${status.state}\n`);
    
    console.log('4. Getting queue statistics...');
    const stats = await jobQueue.getQueueStats(JobType.ANALYZE_DOCUMENT);
    console.log(`   ✓ Queue stats: waiting=${stats.waiting}, active=${stats.active}, completed=${stats.completed}\n`);
    
    console.log('5. Shutting down...');
    await jobQueue.shutdown();
    console.log('   ✓ Shutdown complete\n');
    
    console.log('✅ All tests passed! JobQueueService works with embedded queue.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

testQueue();