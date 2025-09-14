/**
 * Neo4j Query Optimizer and Performance Monitor
 * Provides intelligent query profiling, batching, and performance optimization
 */

import type { Driver, ManagedTransaction, QueryResult, Record as Neo4jRecord } from 'neo4j-driver';
import { getLogger } from '../../core/logger.js';
import { formatDuration, measureExecution } from '../../utils/common.js';
import type { QueryParameters } from '../../types/database.js';

const logger = getLogger('neo4j-optimizer');

export interface QueryProfile {
  query: string;
  parameters: QueryParameters;
  executionTime: number;
  dbTime: number;
  rows: number;
  plan?: QueryPlan;
  profiledAt: Date;
}

export interface QueryPlan {
  operatorType: string;
  identifiers: string[];
  arguments: Record<string, unknown>;
  children?: QueryPlan[];
  dbHits?: number;
  rows?: number;
  pageCacheHits?: number;
  pageCacheMisses?: number;
  time?: number;
}

export interface BatchOperation {
  query: string;
  parameters: QueryParameters[];
  maxBatchSize?: number;
  parallelism?: number;
}

export interface PerformanceMetrics {
  totalQueries: number;
  slowQueries: number;
  avgExecutionTime: number;
  avgDbTime: number;
  totalRows: number;
  cacheHitRatio: number;
  topSlowQueries: QueryProfile[];
  indexUsage: IndexUsageStats[];
  constraintViolations: number;
}

export interface IndexUsageStats {
  index: string;
  label: string;
  property: string;
  hits: number;
  misses: number;
  hitRatio: number;
}

export interface BatchResult {
  successful: number;
  failed: number;
  executionTime: number;
  errors: Error[];
}

/**
 * Advanced Neo4j query optimizer and performance monitor
 */
export class Neo4jOptimizer {
  private driver: Driver;
  private database: string;
  private queryProfiles = new Map<string, QueryProfile[]>();
  private slowQueryThreshold = 1000; // ms
  private enableProfiling = true;

  constructor(driver: Driver, database = 'scrivener') {
    this.driver = driver;
    this.database = database;
  }

  /**
   * Execute and profile a Cypher query
   */
  async profileQuery(
    cypher: string, 
    parameters: QueryParameters = {}
  ): Promise<{ result: QueryResult; profile: QueryProfile }> {
    const session = this.driver.session({ database: this.database });
    
    try {
      const profiledQuery = this.enableProfiling 
        ? `PROFILE ${cypher}`
        : cypher;

      const result = await measureExecution(async () => {
        return await session.run(profiledQuery, parameters);
      });

      const profile: QueryProfile = {
        query: cypher,
        parameters,
        executionTime: result.ms,
        dbTime: this.extractDbTime(result.result),
        rows: result.result.records.length,
        plan: this.enableProfiling ? this.extractQueryPlan(result.result) : undefined,
        profiledAt: new Date(),
      };

      // Store profile for analysis
      this.storeProfile(cypher, profile);

      logger.debug('Query profiled', {
        query: cypher.substring(0, 100),
        executionTime: formatDuration(result.ms),
        rows: result.result.records.length,
        dbTime: profile.dbTime,
      });

      return { result: result.result, profile };
    } finally {
      await session.close();
    }
  }

  /**
   * Execute batch operations with optimized parallelism
   */
  async executeBatch(operation: BatchOperation): Promise<BatchResult> {
    const {
      query,
      parameters,
      maxBatchSize = 100,
      parallelism = 4
    } = operation;

    const results: BatchResult = {
      successful: 0,
      failed: 0,
      executionTime: 0,
      errors: [],
    };

    const startTime = Date.now();

    try {
      // Split parameters into batches
      const batches: QueryParameters[][] = [];
      for (let i = 0; i < parameters.length; i += maxBatchSize) {
        batches.push(parameters.slice(i, i + maxBatchSize));
      }

      // Process batches with controlled parallelism
      const processBatch = async (batch: QueryParameters[]): Promise<void> => {
        const session = this.driver.session({ database: this.database });
        
        try {
          await session.executeWrite(async (tx: ManagedTransaction) => {
            for (const params of batch) {
              try {
                await tx.run(query, params);
                results.successful++;
              } catch (error) {
                results.failed++;
                results.errors.push(error as Error);
                logger.warn('Batch operation failed', { 
                  query: query.substring(0, 50),
                  params,
                  error: (error as Error).message 
                });
              }
            }
          });
        } finally {
          await session.close();
        }
      };

      // Execute batches in parallel with controlled concurrency
      const concurrencyLimit = Math.min(parallelism, batches.length);
      const executing = new Set<Promise<void>>();

      for (const batch of batches) {
        // Wait if we've hit the concurrency limit
        if (executing.size >= concurrencyLimit) {
          await Promise.race(executing);
        }

        const batchPromise = processBatch(batch).finally(() => {
          executing.delete(batchPromise);
        });
        executing.add(batchPromise);
      }

      // Wait for all remaining batches
      await Promise.all(executing);

      results.executionTime = Date.now() - startTime;

      logger.info('Batch operation completed', {
        query: query.substring(0, 50),
        totalParams: parameters.length,
        successful: results.successful,
        failed: results.failed,
        executionTime: formatDuration(results.executionTime),
      });

      return results;

    } catch (error) {
      results.executionTime = Date.now() - startTime;
      results.errors.push(error as Error);
      throw error;
    }
  }

  /**
   * Optimize database schema with indexes and constraints
   */
  async optimizeSchema(): Promise<{
    indexesCreated: string[];
    constraintsCreated: string[];
    recommendations: string[];
  }> {
    const session = this.driver.session({ database: this.database });
    const result = {
      indexesCreated: [] as string[],
      constraintsCreated: [] as string[],
      recommendations: [] as string[],
    };

    try {
      // Analyze query patterns to recommend indexes
      const recommendations = await this.analyzeIndexNeeds();
      
      for (const rec of recommendations) {
        try {
          await session.run(rec.createStatement);
          result.indexesCreated.push(rec.description);
          logger.info(`Created index: ${rec.description}`);
        } catch (error) {
          logger.warn(`Failed to create index: ${rec.description}`, { error });
          result.recommendations.push(`Manual review needed: ${rec.description}`);
        }
      }

      // Create essential constraints
      const constraints = [
        {
          cypher: 'CREATE CONSTRAINT document_id IF NOT EXISTS FOR (d:Document) REQUIRE d.id IS UNIQUE',
          description: 'Document ID uniqueness',
        },
        {
          cypher: 'CREATE CONSTRAINT character_id IF NOT EXISTS FOR (c:Character) REQUIRE c.id IS UNIQUE',
          description: 'Character ID uniqueness',
        },
        {
          cypher: 'CREATE CONSTRAINT theme_id IF NOT EXISTS FOR (t:Theme) REQUIRE t.id IS UNIQUE',
          description: 'Theme ID uniqueness',
        },
      ];

      for (const constraint of constraints) {
        try {
          await session.run(constraint.cypher);
          result.constraintsCreated.push(constraint.description);
        } catch (error) {
          logger.debug(`Constraint already exists or failed: ${constraint.description}`, { error });
        }
      }

      return result;

    } finally {
      await session.close();
    }
  }

  /**
   * Get comprehensive performance metrics
   */
  getPerformanceMetrics(): PerformanceMetrics {
    const allProfiles: QueryProfile[] = [];
    for (const profiles of this.queryProfiles.values()) {
      allProfiles.push(...profiles);
    }

    const slowQueries = allProfiles.filter(p => p.executionTime > this.slowQueryThreshold);
    const totalExecutionTime = allProfiles.reduce((sum, p) => sum + p.executionTime, 0);
    const totalDbTime = allProfiles.reduce((sum, p) => sum + p.dbTime, 0);
    const totalRows = allProfiles.reduce((sum, p) => sum + p.rows, 0);

    // Calculate cache hit ratio from query plans
    let totalCacheHits = 0;
    let totalCacheMisses = 0;
    
    for (const profile of allProfiles) {
      if (profile.plan) {
        const cacheStats = this.extractCacheStats(profile.plan);
        totalCacheHits += cacheStats.hits;
        totalCacheMisses += cacheStats.misses;
      }
    }

    const cacheTotal = totalCacheHits + totalCacheMisses;
    const cacheHitRatio = cacheTotal > 0 ? totalCacheHits / cacheTotal : 0;

    return {
      totalQueries: allProfiles.length,
      slowQueries: slowQueries.length,
      avgExecutionTime: allProfiles.length > 0 ? totalExecutionTime / allProfiles.length : 0,
      avgDbTime: allProfiles.length > 0 ? totalDbTime / allProfiles.length : 0,
      totalRows,
      cacheHitRatio,
      topSlowQueries: allProfiles
        .sort((a, b) => b.executionTime - a.executionTime)
        .slice(0, 10),
      indexUsage: this.calculateIndexUsage(allProfiles),
      constraintViolations: 0, // Would need error tracking to populate this
    };
  }

  /**
   * Generate optimization recommendations
   */
  async generateRecommendations(): Promise<string[]> {
    const metrics = this.getPerformanceMetrics();
    const recommendations: string[] = [];

    // Slow query analysis
    if (metrics.slowQueries > metrics.totalQueries * 0.1) {
      recommendations.push(
        `High number of slow queries (${metrics.slowQueries}/${metrics.totalQueries}). Consider query optimization and indexing.`
      );
    }

    // Cache hit ratio analysis
    if (metrics.cacheHitRatio < 0.8) {
      recommendations.push(
        `Low cache hit ratio (${(metrics.cacheHitRatio * 100).toFixed(1)}%). Consider increasing cache size or optimizing data access patterns.`
      );
    }

    // Index usage analysis
    const underutilizedIndexes = metrics.indexUsage.filter(idx => idx.hitRatio < 0.5);
    if (underutilizedIndexes.length > 0) {
      recommendations.push(
        `Found ${underutilizedIndexes.length} underutilized indexes. Consider removing: ${underutilizedIndexes.map(i => i.index).join(', ')}`
      );
    }

    // Query pattern analysis
    const commonPatterns = this.analyzeQueryPatterns();
    for (const pattern of commonPatterns) {
      if (pattern.needsOptimization) {
        recommendations.push(pattern.recommendation);
      }
    }

    return recommendations;
  }

  /**
   * Enable or disable query profiling
   */
  setProfilingEnabled(enabled: boolean): void {
    this.enableProfiling = enabled;
    logger.info(`Query profiling ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Clear collected performance data
   */
  clearProfiles(): void {
    this.queryProfiles.clear();
    logger.info('Query profiles cleared');
  }

  /**
   * Export performance data for analysis
   */
  exportPerformanceData(): {
    metrics: PerformanceMetrics;
    profiles: Record<string, QueryProfile[]>;
    recommendations: string[];
  } {
    const profilesObj: Record<string, QueryProfile[]> = {};
    for (const [key, value] of this.queryProfiles.entries()) {
      profilesObj[key] = value;
    }

    return {
      metrics: this.getPerformanceMetrics(),
      profiles: profilesObj,
      recommendations: [], // Would be populated by generateRecommendations()
    };
  }

  // Private helper methods

  private storeProfile(query: string, profile: QueryProfile): void {
    const queryKey = this.normalizeQuery(query);
    if (!this.queryProfiles.has(queryKey)) {
      this.queryProfiles.set(queryKey, []);
    }
    
    const profiles = this.queryProfiles.get(queryKey)!;
    profiles.push(profile);
    
    // Keep only last 100 profiles per query to prevent memory bloat
    if (profiles.length > 100) {
      profiles.splice(0, profiles.length - 100);
    }
  }

  private normalizeQuery(query: string): string {
    // Normalize query by removing parameters and extra whitespace
    return query
      .replace(/\$\w+/g, '?')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  private extractDbTime(result: QueryResult): number {
    // Extract database time from result summary if available
    try {
      return result.summary?.resultAvailableAfter?.toNumber() || 0;
    } catch {
      return 0;
    }
  }

  private extractQueryPlan(result: QueryResult): QueryPlan | undefined {
    try {
      const planRecord = result.records.find(record => 
        record.keys.includes('plan')
      );
      
      if (planRecord) {
        const plan = planRecord.get('plan');
        return this.convertPlan(plan);
      }
    } catch (error) {
      logger.debug('Failed to extract query plan', { error });
    }
    return undefined;
  }

  private convertPlan(planNode: unknown): QueryPlan {
    // Convert Neo4j plan node to our QueryPlan interface
    const node = planNode as any;
    
    return {
      operatorType: node.operatorType || 'Unknown',
      identifiers: node.identifiers || [],
      arguments: node.arguments || {},
      children: node.children ? node.children.map((child: unknown) => this.convertPlan(child)) : undefined,
      dbHits: node.dbHits?.toNumber ? node.dbHits.toNumber() : node.dbHits,
      rows: node.rows?.toNumber ? node.rows.toNumber() : node.rows,
      pageCacheHits: node.pageCacheHits?.toNumber ? node.pageCacheHits.toNumber() : node.pageCacheHits,
      pageCacheMisses: node.pageCacheMisses?.toNumber ? node.pageCacheMisses.toNumber() : node.pageCacheMisses,
      time: node.time?.toNumber ? node.time.toNumber() : node.time,
    };
  }

  private extractCacheStats(plan: QueryPlan): { hits: number; misses: number } {
    let hits = plan.pageCacheHits || 0;
    let misses = plan.pageCacheMisses || 0;
    
    if (plan.children) {
      for (const child of plan.children) {
        const childStats = this.extractCacheStats(child);
        hits += childStats.hits;
        misses += childStats.misses;
      }
    }
    
    return { hits, misses };
  }

  private calculateIndexUsage(profiles: QueryProfile[]): IndexUsageStats[] {
    const indexStats = new Map<string, { hits: number; misses: number; details: any }>();
    
    for (const profile of profiles) {
      if (profile.plan) {
        this.analyzeIndexUsageInPlan(profile.plan, indexStats);
      }
    }
    
    return Array.from(indexStats.entries()).map(([index, stats]) => ({
      index,
      label: stats.details.label || 'Unknown',
      property: stats.details.property || 'Unknown',
      hits: stats.hits,
      misses: stats.misses,
      hitRatio: stats.hits + stats.misses > 0 ? stats.hits / (stats.hits + stats.misses) : 0,
    }));
  }

  private analyzeIndexUsageInPlan(
    plan: QueryPlan, 
    indexStats: Map<string, { hits: number; misses: number; details: any }>
  ): void {
    if (plan.operatorType.includes('Index')) {
      const indexName = (typeof plan.arguments.index === 'string' ? plan.arguments.index : 'Unknown');
      if (!indexStats.has(indexName)) {
        indexStats.set(indexName, { hits: 0, misses: 0, details: plan.arguments });
      }
      
      const stats = indexStats.get(indexName)!;
      stats.hits += plan.dbHits || 0;
      // Misses would be calculated differently based on the specific plan
    }
    
    if (plan.children) {
      for (const child of plan.children) {
        this.analyzeIndexUsageInPlan(child, indexStats);
      }
    }
  }

  private async analyzeIndexNeeds(): Promise<Array<{ createStatement: string; description: string }>> {
    const recommendations: Array<{ createStatement: string; description: string }> = [];
    
    // Analyze common query patterns from profiles
    const patterns = this.analyzeQueryPatterns();
    
    for (const pattern of patterns) {
      if (pattern.needsIndex) {
        recommendations.push({
          createStatement: pattern.indexStatement,
          description: pattern.indexDescription,
        });
      }
    }
    
    return recommendations;
  }

  private analyzeQueryPatterns(): Array<{
    pattern: string;
    frequency: number;
    needsOptimization: boolean;
    needsIndex: boolean;
    recommendation: string;
    indexStatement: string;
    indexDescription: string;
  }> {
    const patterns: Array<{
      pattern: string;
      frequency: number;
      needsOptimization: boolean;
      needsIndex: boolean;
      recommendation: string;
      indexStatement: string;
      indexDescription: string;
    }> = [];
    
    // This would analyze actual query patterns from stored profiles
    // For now, return some common optimization patterns
    
    return patterns;
  }
}