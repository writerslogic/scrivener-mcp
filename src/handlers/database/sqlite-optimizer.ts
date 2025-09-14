/**
 * Advanced SQLite Query Optimizer
 * Provides intelligent query analysis, optimization, and performance monitoring
 */

import type { RunResult } from 'better-sqlite3';
import Database from 'better-sqlite3';
import * as crypto from 'crypto';
import { getLogger } from '../../core/logger.js';
import { formatBytes, formatDuration, measureExecution } from '../../utils/common.js';
import type { SQLiteManager } from './sqlite-manager.js';

const logger = getLogger('sqlite-optimizer');

export interface QueryPlan {
  id: number;
  parent: number;
  notused: number;
  detail: string;
}

export interface QueryStats {
  query: string;
  hash: string;
  executionCount: number;
  totalTime: number;
  avgTime: number;
  lastExecuted: Date;
  queryPlan?: QueryPlan[];
  isOptimized: boolean;
}

export interface IndexRecommendation {
  table: string;
  columns: string[];
  reason: string;
  priority: 'high' | 'medium' | 'low';
  estimatedImprovement: string;
}

/**
 * SQLite Query Optimizer and Performance Analyzer
 */
export class SQLiteOptimizer {
  private sqliteManager: SQLiteManager;
  private queryStats = new Map<string, QueryStats>();
  private slowQueryThreshold = 100; // ms
  private analysisCache = new Map<string, QueryPlan[]>();

  constructor(sqliteManager: SQLiteManager) {
    this.sqliteManager = sqliteManager;
  }

  /**
   * Analyze query performance and generate execution plan
   */
  async analyzeQuery(sql: string, params: unknown[] = []): Promise<{
    plan: QueryPlan[];
    recommendations: IndexRecommendation[];
    performance: {
      executionTime: number;
      isOptimal: boolean;
      scanCount: number;
      indexUsage: string[];
    };
  }> {
    const db = this.sqliteManager.getDatabase();
    
    // Generate query hash for caching
    const hash = this.hashQuery(sql, params);
    
    // Check analysis cache first
    let plan = this.analysisCache.get(hash);
    if (!plan) {
      // Get query execution plan
      const explainSql = `EXPLAIN QUERY PLAN ${sql}`;
      plan = db.prepare(explainSql).all(params) as QueryPlan[];
      this.analysisCache.set(hash, plan);
    }

    // Measure actual execution time
    const result = await measureExecution(async () => {
      return db.prepare(sql).all(params);
    });

    // Analyze performance characteristics
    const scanCount = plan.filter(p => p.detail.toLowerCase().includes('scan')).length;
    const indexUsage = plan
      .filter(p => p.detail.toLowerCase().includes('index'))
      .map(p => this.extractIndexName(p.detail));

    const isOptimal = scanCount === 0 || result.ms < this.slowQueryThreshold;

    // Generate index recommendations
    const recommendations = await this.generateIndexRecommendations(sql, plan);

    // Update query statistics
    this.updateQueryStats(sql, hash, result.ms, plan, isOptimal);

    return {
      plan,
      recommendations,
      performance: {
        executionTime: result.ms,
        isOptimal,
        scanCount,
        indexUsage: indexUsage.filter(Boolean) as string[],
      },
    };
  }

  /**
   * Create recommended indexes based on query analysis
   */
  async createOptimalIndexes(): Promise<{
    created: string[];
    failed: string[];
    performance: Record<string, number>;
  }> {
    const db = this.sqliteManager.getDatabase();
    const created: string[] = [];
    const failed: string[] = [];
    const performance: Record<string, number> = {};

    // Analyze all stored queries for index opportunities
    const recommendations = new Map<string, IndexRecommendation>();
    
    for (const [hash, stats] of this.queryStats) {
      if (!stats.isOptimized && stats.executionCount > 5) {
        const queryRecs = await this.generateIndexRecommendations(stats.query, stats.queryPlan || []);
        for (const rec of queryRecs) {
          const key = `${rec.table}_${rec.columns.join('_')}`;
          if (!recommendations.has(key) || rec.priority === 'high') {
            recommendations.set(key, rec);
          }
        }
      }
    }

    // Create high-priority indexes first
    const sortedRecs = Array.from(recommendations.values())
      .sort((a, b) => {
        const priority = { high: 3, medium: 2, low: 1 };
        return priority[b.priority] - priority[a.priority];
      });

    for (const rec of sortedRecs) {
      try {
        const indexName = `idx_${rec.table}_${rec.columns.join('_')}`;
        const sql = `CREATE INDEX IF NOT EXISTS ${indexName} ON ${rec.table} (${rec.columns.join(', ')})`;
        
        // Measure index creation time
        const createResult = await measureExecution(async () => {
          db.exec(sql);
        });

        created.push(indexName);
        performance[indexName] = createResult.ms;

        logger.info(`Created index: ${indexName}`, {
          table: rec.table,
          columns: rec.columns,
          reason: rec.reason,
          creationTime: formatDuration(createResult.ms),
        });
      } catch (error) {
        const indexName = `idx_${rec.table}_${rec.columns.join('_')}`;
        failed.push(indexName);
        logger.warn(`Failed to create index: ${indexName}`, { error });
      }
    }

    return { created, failed, performance };
  }

  /**
   * Optimize database configuration for performance
   */
  async optimizeConfiguration(): Promise<void> {
    const db = this.sqliteManager.getDatabase();

    // Apply performance pragmas based on usage patterns
    const optimizations = [
      'PRAGMA journal_mode = WAL',
      'PRAGMA synchronous = NORMAL',
      'PRAGMA cache_size = -64000', // 64MB cache
      'PRAGMA temp_store = MEMORY',
      'PRAGMA mmap_size = 536870912', // 512MB mmap
      'PRAGMA page_size = 4096',
      'PRAGMA auto_vacuum = INCREMENTAL',
      'PRAGMA optimize',
    ];

    for (const pragma of optimizations) {
      try {
        db.exec(pragma);
        logger.debug(`Applied optimization: ${pragma}`);
      } catch (error) {
        logger.warn(`Failed to apply optimization: ${pragma}`, { error });
      }
    }

    // Run ANALYZE to update statistics
    try {
      db.exec('ANALYZE');
      logger.info('Database statistics updated');
    } catch (error) {
      logger.warn('Failed to update database statistics', { error });
    }
  }

  /**
   * Generate index recommendations based on query patterns
   */
  private async generateIndexRecommendations(
    sql: string,
    plan: QueryPlan[]
  ): Promise<IndexRecommendation[]> {
    const recommendations: IndexRecommendation[] = [];
    
    // Analyze query for potential index opportunities
    const whereColumns = this.extractWhereColumns(sql);
    const joinColumns = this.extractJoinColumns(sql);
    const orderColumns = this.extractOrderColumns(sql);
    const tableName = this.extractTableName(sql);

    if (!tableName) return recommendations;

    // Check for table scans in query plan
    const hasTableScan = plan.some(p => 
      p.detail.toLowerCase().includes('scan table') && 
      p.detail.includes(tableName)
    );

    if (hasTableScan && whereColumns.length > 0) {
      recommendations.push({
        table: tableName,
        columns: whereColumns,
        reason: 'Eliminate table scan with WHERE clause index',
        priority: 'high',
        estimatedImprovement: '50-90% faster',
      });
    }

    // Recommend covering indexes for frequent SELECT columns
    const selectColumns = this.extractSelectColumns(sql);
    if (selectColumns.length > 0 && whereColumns.length > 0) {
      const coveringColumns = [...whereColumns, ...selectColumns];
      if (coveringColumns.length <= 5) { // Don't create huge indexes
        recommendations.push({
          table: tableName,
          columns: coveringColumns,
          reason: 'Covering index to eliminate key lookups',
          priority: 'medium',
          estimatedImprovement: '20-40% faster',
        });
      }
    }

    // JOIN optimization indexes
    if (joinColumns.length > 0) {
      recommendations.push({
        table: tableName,
        columns: joinColumns,
        reason: 'Optimize JOIN operations',
        priority: 'high',
        estimatedImprovement: '30-70% faster',
      });
    }

    // ORDER BY optimization
    if (orderColumns.length > 0) {
      recommendations.push({
        table: tableName,
        columns: orderColumns,
        reason: 'Eliminate sorting with ORDER BY index',
        priority: 'medium',
        estimatedImprovement: '20-50% faster',
      });
    }

    return recommendations;
  }

  /**
   * Update query statistics
   */
  private updateQueryStats(
    sql: string,
    hash: string,
    executionTime: number,
    plan: QueryPlan[],
    isOptimal: boolean
  ): void {
    const existing = this.queryStats.get(hash);
    
    if (existing) {
      existing.executionCount++;
      existing.totalTime += executionTime;
      existing.avgTime = existing.totalTime / existing.executionCount;
      existing.lastExecuted = new Date();
      existing.isOptimized = isOptimal;
    } else {
      this.queryStats.set(hash, {
        query: sql,
        hash,
        executionCount: 1,
        totalTime: executionTime,
        avgTime: executionTime,
        lastExecuted: new Date(),
        queryPlan: plan,
        isOptimized: isOptimal,
      });
    }
  }

  /**
   * Get performance statistics
   */
  getPerformanceStats(): {
    totalQueries: number;
    slowQueries: number;
    optimizedQueries: number;
    averageExecutionTime: number;
    topSlowQueries: QueryStats[];
  } {
    const stats = Array.from(this.queryStats.values());
    const slowQueries = stats.filter(s => s.avgTime > this.slowQueryThreshold);
    const optimizedQueries = stats.filter(s => s.isOptimized);
    
    const totalTime = stats.reduce((sum, s) => sum + s.totalTime, 0);
    const totalExecutions = stats.reduce((sum, s) => sum + s.executionCount, 0);
    
    return {
      totalQueries: stats.length,
      slowQueries: slowQueries.length,
      optimizedQueries: optimizedQueries.length,
      averageExecutionTime: totalExecutions > 0 ? totalTime / totalExecutions : 0,
      topSlowQueries: stats
        .sort((a, b) => b.avgTime - a.avgTime)
        .slice(0, 10),
    };
  }

  /**
   * Generate performance report
   */
  generatePerformanceReport(): string {
    const stats = this.getPerformanceStats();
    
    let report = '# SQLite Performance Report\n\n';
    report += `**Total Unique Queries**: ${stats.totalQueries}\n`;
    report += `**Slow Queries**: ${stats.slowQueries} (>${this.slowQueryThreshold}ms)\n`;
    report += `**Optimized Queries**: ${stats.optimizedQueries}\n`;
    report += `**Average Execution Time**: ${stats.averageExecutionTime.toFixed(2)}ms\n\n`;
    
    if (stats.topSlowQueries.length > 0) {
      report += '## Top Slow Queries\n\n';
      for (const query of stats.topSlowQueries) {
        report += `**Query**: \`${query.query.substring(0, 100)}...\`\n`;
        report += `- **Average Time**: ${query.avgTime.toFixed(2)}ms\n`;
        report += `- **Execution Count**: ${query.executionCount}\n`;
        report += `- **Optimized**: ${query.isOptimized ? 'Yes' : 'No'}\n\n`;
      }
    }
    
    return report;
  }

  // Query parsing utilities
  private extractWhereColumns(sql: string): string[] {
    const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER\s+BY|\s+GROUP\s+BY|\s+LIMIT|$)/i);
    if (!whereMatch) return [];
    
    const whereClause = whereMatch[1];
    const columns = whereClause.match(/\b(\w+)\s*[=<>!]/g);
    return columns ? columns.map(col => col.replace(/\s*[=<>!].*/, '').trim()) : [];
  }

  private extractJoinColumns(sql: string): string[] {
    const joinMatches = sql.match(/JOIN\s+\w+\s+ON\s+(\w+\.\w+)\s*=\s*(\w+\.\w+)/gi);
    if (!joinMatches) return [];
    
    const columns: string[] = [];
    for (const match of joinMatches) {
      const columnMatch = match.match(/ON\s+(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/i);
      if (columnMatch) {
        columns.push(columnMatch[2], columnMatch[4]);
      }
    }
    return columns;
  }

  private extractOrderColumns(sql: string): string[] {
    const orderMatch = sql.match(/ORDER\s+BY\s+([^;]+)/i);
    if (!orderMatch) return [];
    
    return orderMatch[1]
      .split(',')
      .map(col => col.trim().replace(/\s+(ASC|DESC)$/i, ''))
      .filter(col => !col.includes('(') && !col.includes(' ')); // Skip functions and complex expressions
  }

  private extractSelectColumns(sql: string): string[] {
    const selectMatch = sql.match(/SELECT\s+(.*?)\s+FROM/i);
    if (!selectMatch || selectMatch[1].trim() === '*') return [];
    
    return selectMatch[1]
      .split(',')
      .map(col => col.trim().replace(/\s+as\s+\w+/i, ''))
      .filter(col => !col.includes('(') && !col.includes(' ')); // Skip functions
  }

  private extractTableName(sql: string): string | null {
    const match = sql.match(/(?:FROM|INTO|UPDATE|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)/i);
    return match ? match[1] : null;
  }

  private extractIndexName(detail: string): string | null {
    const match = detail.match(/USING\s+INDEX\s+([a-zA-Z_][a-zA-Z0-9_]*)/i);
    return match ? match[1] : null;
  }

  private hashQuery(sql: string, params: unknown[]): string {
    const combined = sql + JSON.stringify(params);
    return crypto.createHash('md5').update(combined).digest('hex');
  }
}