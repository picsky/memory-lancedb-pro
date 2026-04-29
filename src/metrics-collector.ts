/**
 * Unified Metrics Collector
 *
 * Aggregates per-subsystem metrics into a single report for monitoring
 * retrieval quality, admission decisions, storage performance, embedding
 * efficiency, and compaction activity.
 *
 * All recordXxx() methods are synchronous (ring-buffer writes, no I/O).
 * getMetrics() aggregates on demand.
 */

import type { AggregateStats, RetrievalStatsCollector } from "./retrieval-stats.js";

// ============================================================================
// Types
// ============================================================================

export interface AdmissionStats {
  totalEvaluations: number;
  admitted: number;
  passedToDedup: number;
  rejected: number;
  avgScore: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  llmCalls: number;
  llmFailures: number;
  avgFeatureScores: Record<string, number>;
  byDecision: Record<string, number>;
}

export interface StorageStats {
  totalWrites: number;
  totalBulkWrites: number;
  totalUpdates: number;
  totalDeletes: number;
  avgWriteLatencyMs: number;
  avgBulkWriteLatencyMs: number;
  avgUpdateLatencyMs: number;
  avgDeleteLatencyMs: number;
  lockContentions: number;
  updateRollbacks: number;
}

export interface EmbeddingStats {
  totalCalls: number;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: string;
  timeouts: number;
  errors: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
}

export interface CompactionStats {
  totalRuns: number;
  totalScanned: number;
  totalClusters: number;
  totalDeleted: number;
  totalCreated: number;
  avgLatencyMs: number;
  dryRuns: number;
}

export interface MemoryMetrics {
  /** Aggregate retrieval statistics (from RetrievalStatsCollector) */
  retrieval: AggregateStats;
  /** Admission control decision statistics */
  admission: AdmissionStats;
  /** Storage backend operation statistics */
  storage: StorageStats;
  /** Embedding provider call statistics */
  embedding: EmbeddingStats;
  /** Memory compaction run statistics */
  compaction: CompactionStats;
}

// ============================================================================
// Ring buffer helper (shared pattern with RetrievalStatsCollector)
// ============================================================================

class RingBuffer<T> {
  private _data: (T | undefined)[];
  private _head = 0;
  private _count = 0;
  private readonly _maxSize: number;

  constructor(maxSize: number) {
    this._maxSize = maxSize;
    this._data = new Array(maxSize);
  }

  push(item: T): void {
    this._data[this._head] = item;
    this._head = (this._head + 1) % this._maxSize;
    if (this._count < this._maxSize) {
      this._count++;
    }
  }

  forEach(fn: (item: T) => void): void {
    if (this._count === 0) return;
    const start = this._count < this._maxSize ? 0 : this._head;
    for (let i = 0; i < this._count; i++) {
      const item = this._data[(start + i) % this._maxSize];
      if (item !== undefined) fn(item);
    }
  }

  get count(): number {
    return this._count;
  }

  reset(): void {
    this._data = new Array(this._maxSize);
    this._head = 0;
    this._count = 0;
  }
}

// ============================================================================
// Per-subsystem record types
// ============================================================================

interface AdmissionRecord {
  decision: string;
  score: number;
  latencyMs: number;
  llmCalled: boolean;
  llmSucceeded: boolean;
  featureScores: Record<string, number>;
}

interface StorageRecord {
  operation: "write" | "bulkWrite" | "update" | "delete";
  latencyMs: number;
  lockContention: boolean;
  rollback: boolean;
}

interface EmbeddingRecord {
  latencyMs: number;
  cacheHit: boolean;
  timeout: boolean;
  error: boolean;
}

interface CompactionRecord {
  latencyMs: number;
  scanned: number;
  clusters: number;
  deleted: number;
  created: number;
  dryRun: boolean;
}

// ============================================================================
// MetricsCollector
// ============================================================================

export class MetricsCollector {
  // Admission
  private _admissionRecords = new RingBuffer<AdmissionRecord>(500);
  private _admissionCount = 0;

  // Storage
  private _storageRecords = new RingBuffer<StorageRecord>(500);

  // Embedding
  private _embeddingRecords = new RingBuffer<EmbeddingRecord>(500);

  // Compaction
  private _compactionRecords = new RingBuffer<CompactionRecord>(50);

  // Optional reference to the existing retrieval stats collector
  private _retrievalCollector: RetrievalStatsCollector | null = null;

  // ============================================================================
  // Admission metrics
  // ============================================================================

  recordAdmissionEvaluation(record: Omit<AdmissionRecord, "decision"> & { decision: string }): void {
    this._admissionRecords.push(record as AdmissionRecord);
  }

  // ============================================================================
  // Storage metrics
  // ============================================================================

  recordStorageOperation(record: Omit<StorageRecord, "lockContention" | "rollback"> & {
    lockContention?: boolean;
    rollback?: boolean;
  }): void {
    this._storageRecords.push({
      ...record,
      lockContention: record.lockContention ?? false,
      rollback: record.rollback ?? false,
    });
  }

  // ============================================================================
  // Embedding metrics
  // ============================================================================

  recordEmbeddingCall(record: EmbeddingRecord): void {
    this._embeddingRecords.push(record);
  }

  // ============================================================================
  // Compaction metrics
  // ============================================================================

  recordCompactionRun(record: CompactionRecord): void {
    this._compactionRecords.push(record);
  }

  // ============================================================================
  // Retrieval stats bridge
  // ============================================================================

  setRetrievalStatsCollector(collector: RetrievalStatsCollector | null): void {
    this._retrievalCollector = collector;
  }

  // ============================================================================
  // Aggregation
  // ============================================================================

  getMetrics(): MemoryMetrics {
    return {
      retrieval: this._computeRetrievalStats(),
      admission: this._computeAdmissionStats(),
      storage: this._computeStorageStats(),
      embedding: this._computeEmbeddingStats(),
      compaction: this._computeCompactionStats(),
    };
  }

  // ============================================================================
  // Reset
  // ============================================================================

  reset(): void {
    this._admissionRecords.reset();
    this._storageRecords.reset();
    this._embeddingRecords.reset();
    this._compactionRecords.reset();
  }

  // ============================================================================
  // JSON export
  // ============================================================================

  exportToJson(): string {
    return JSON.stringify(this.getMetrics(), null, 2);
  }

  // ============================================================================
  // Internal computations
  // ============================================================================

  private _computeRetrievalStats(): AggregateStats {
    if (this._retrievalCollector) {
      return this._retrievalCollector.getStats();
    }
    return {
      totalQueries: 0,
      zeroResultQueries: 0,
      avgLatencyMs: 0,
      p95LatencyMs: 0,
      avgResultCount: 0,
      rerankUsed: 0,
      noiseFiltered: 0,
      queriesBySource: {},
      topDropStages: [],
    };
  }

  private _computeAdmissionStats(): AdmissionStats {
    const n = this._admissionRecords.count;
    if (n === 0) return _emptyAdmissionStats();

    let totalLatency = 0;
    let totalScore = 0;
    let admitted = 0;
    let passedToDedup = 0;
    let rejected = 0;
    let llmCalls = 0;
    let llmFailures = 0;
    const latencies: number[] = [];
    const byDecision: Record<string, number> = {};
    const featureScoreSums: Record<string, number> = {};
    let featureScoreCount = 0;

    this._admissionRecords.forEach((rec) => {
      totalLatency += rec.latencyMs;
      totalScore += rec.score;
      latencies.push(rec.latencyMs);

      byDecision[rec.decision] = (byDecision[rec.decision] || 0) + 1;
      if (rec.decision === "admit") admitted++;
      else if (rec.decision === "pass_to_dedup") passedToDedup++;
      else rejected++;

      if (rec.llmCalled) llmCalls++;
      if (rec.llmCalled && !rec.llmSucceeded) llmFailures++;

      for (const [key, val] of Object.entries(rec.featureScores)) {
        featureScoreSums[key] = (featureScoreSums[key] || 0) + val;
      }
      featureScoreCount++;
    });

    latencies.sort((a, b) => a - b);
    const p95Index = Math.min(Math.ceil(n * 0.95) - 1, n - 1);

    const avgFeatureScores: Record<string, number> = {};
    for (const [key, sum] of Object.entries(featureScoreSums)) {
      avgFeatureScores[key] = Math.round((sum / featureScoreCount) * 1000) / 1000;
    }

    return {
      totalEvaluations: n,
      admitted,
      passedToDedup,
      rejected,
      avgScore: Math.round((totalScore / n) * 1000) / 1000,
      avgLatencyMs: Math.round(totalLatency / n),
      p95LatencyMs: latencies[p95Index],
      llmCalls,
      llmFailures,
      avgFeatureScores,
      byDecision,
    };
  }

  private _computeStorageStats(): StorageStats {
    const n = this._storageRecords.count;
    if (n === 0) return _emptyStorageStats();

    let totalWrites = 0, totalBulkWrites = 0, totalUpdates = 0, totalDeletes = 0;
    let writeLatency = 0, bulkWriteLatency = 0, updateLatency = 0, deleteLatency = 0;
    let lockContentions = 0, updateRollbacks = 0;

    this._storageRecords.forEach((rec) => {
      if (rec.lockContention) lockContentions++;
      if (rec.rollback) updateRollbacks++;

      switch (rec.operation) {
        case "write":
          totalWrites++;
          writeLatency += rec.latencyMs;
          break;
        case "bulkWrite":
          totalBulkWrites++;
          bulkWriteLatency += rec.latencyMs;
          break;
        case "update":
          totalUpdates++;
          updateLatency += rec.latencyMs;
          break;
        case "delete":
          totalDeletes++;
          deleteLatency += rec.latencyMs;
          break;
      }
    });

    return {
      totalWrites,
      totalBulkWrites,
      totalUpdates,
      totalDeletes,
      avgWriteLatencyMs: totalWrites > 0 ? Math.round(writeLatency / totalWrites) : 0,
      avgBulkWriteLatencyMs: totalBulkWrites > 0 ? Math.round(bulkWriteLatency / totalBulkWrites) : 0,
      avgUpdateLatencyMs: totalUpdates > 0 ? Math.round(updateLatency / totalUpdates) : 0,
      avgDeleteLatencyMs: totalDeletes > 0 ? Math.round(deleteLatency / totalDeletes) : 0,
      lockContentions,
      updateRollbacks,
    };
  }

  private _computeEmbeddingStats(): EmbeddingStats {
    const n = this._embeddingRecords.count;
    if (n === 0) return _emptyEmbeddingStats();

    let totalLatency = 0;
    let cacheHits = 0, cacheMisses = 0;
    let timeouts = 0, errors = 0;
    const latencies: number[] = [];

    this._embeddingRecords.forEach((rec) => {
      totalLatency += rec.latencyMs;
      latencies.push(rec.latencyMs);
      if (rec.cacheHit) cacheHits++;
      else cacheMisses++;
      if (rec.timeout) timeouts++;
      if (rec.error) errors++;
    });

    latencies.sort((a, b) => a - b);
    const p95Index = Math.min(Math.ceil(n * 0.95) - 1, n - 1);
    const total = cacheHits + cacheMisses;

    return {
      totalCalls: n,
      cacheHits,
      cacheMisses,
      cacheHitRate: total > 0 ? `${((cacheHits / total) * 100).toFixed(1)}%` : "N/A",
      timeouts,
      errors,
      avgLatencyMs: Math.round(totalLatency / n),
      p95LatencyMs: latencies[p95Index],
    };
  }

  private _computeCompactionStats(): CompactionStats {
    const n = this._compactionRecords.count;
    if (n === 0) return _emptyCompactionStats();

    let totalLatency = 0;
    let totalScanned = 0, totalClusters = 0, totalDeleted = 0, totalCreated = 0;
    let dryRuns = 0;

    this._compactionRecords.forEach((rec) => {
      totalLatency += rec.latencyMs;
      totalScanned += rec.scanned;
      totalClusters += rec.clusters;
      totalDeleted += rec.deleted;
      totalCreated += rec.created;
      if (rec.dryRun) dryRuns++;
    });

    return {
      totalRuns: n,
      totalScanned,
      totalClusters,
      totalDeleted,
      totalCreated,
      avgLatencyMs: Math.round(totalLatency / n),
      dryRuns,
    };
  }
}

// ============================================================================
// Empty stats helpers
// ============================================================================

function _emptyAdmissionStats(): AdmissionStats {
  return {
    totalEvaluations: 0,
    admitted: 0,
    passedToDedup: 0,
    rejected: 0,
    avgScore: 0,
    avgLatencyMs: 0,
    p95LatencyMs: 0,
    llmCalls: 0,
    llmFailures: 0,
    avgFeatureScores: {},
    byDecision: {},
  };
}

function _emptyStorageStats(): StorageStats {
  return {
    totalWrites: 0,
    totalBulkWrites: 0,
    totalUpdates: 0,
    totalDeletes: 0,
    avgWriteLatencyMs: 0,
    avgBulkWriteLatencyMs: 0,
    avgUpdateLatencyMs: 0,
    avgDeleteLatencyMs: 0,
    lockContentions: 0,
    updateRollbacks: 0,
  };
}

function _emptyEmbeddingStats(): EmbeddingStats {
  return {
    totalCalls: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheHitRate: "N/A",
    timeouts: 0,
    errors: 0,
    avgLatencyMs: 0,
    p95LatencyMs: 0,
  };
}

function _emptyCompactionStats(): CompactionStats {
  return {
    totalRuns: 0,
    totalScanned: 0,
    totalClusters: 0,
    totalDeleted: 0,
    totalCreated: 0,
    avgLatencyMs: 0,
    dryRuns: 0,
  };
}
