/**
 * Background Scheduler — Three-tier background processing pipeline
 *
 * Orchestrates background memory maintenance tasks with different rhythms:
 *
 * | Phase       | Trigger                  | Operations                                  |
 * |-------------|--------------------------|---------------------------------------------|
 * | Sweep       | Every gateway_start      | Access decay update, stale marking, health  |
 * | Consolidate | Once per cooldown (24h)  | Consolidation scoring + tier migration      |
 * | Compact     | Once per cooldown (168h) | LSH clustering + similarity merge           |
 *
 * Each phase is fire-and-forget (non-blocking) with error suppression.
 * The sweep phase always runs; consolidate and compact are gated by cooldown.
 */

import type { MemoryStore } from "./store.js";
import type { MemoryEntry } from "./store.js";
import {
  runConsolidationSweep,
  shouldRunConsolidation,
  recordConsolidationRun,
  DEFAULT_CONSOLIDATION_CONFIG,
  type ConsolidationConfig,
  type ConsolidationLogger,
} from "./memory-consolidation.js";
import {
  runCompaction,
  shouldRunCompaction,
  recordCompactionRun,
  type CompactionConfig,
  type CompactorEmbedder,
} from "./memory-compactor.js";
import { createDecayEngine, DEFAULT_DECAY_CONFIG, type DecayConfig } from "./decay-engine.js";
import { parseSmartMetadata, buildSmartMetadata, stringifySmartMetadata, toLifecycleMemory, getDecayableFromEntry } from "./smart-metadata.js";

// ============================================================================
// Types
// ============================================================================

export interface SweepConfig {
  /** Maximum memories to evaluate for staleness per sweep. Default: 200 */
  maxMemoriesPerSweep: number;
  /** Decay score below which a memory is considered stale. Default: 0.2 */
  staleThreshold: number;
  /** Memory health threshold — below this triggers recovery. Default: 0.3 */
  healthThreshold: number;
}

export const DEFAULT_SWEEP_CONFIG: SweepConfig = {
  maxMemoriesPerSweep: 200,
  staleThreshold: 0.2,
  healthThreshold: 0.3,
};

export interface PipelineConfig {
  sweep?: SweepConfig;
  consolidation?: ConsolidationConfig;
  compaction?: CompactionConfig;
}

export interface PipelineLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error?: (...args: unknown[]) => void;
}

export interface PipelineResult {
  sweep: SweepResult | null;
  consolidation: { evaluated: number; promoted: number; archived: number; suppressed: number } | null;
  compaction: { scanned: number; clusters: number; deleted: number; created: number } | null;
}

export interface SweepResult {
  memoriesEvaluated: number;
  staleMarked: number;
  healthScore: number;
  recovered: number;
}

// ============================================================================
// Sweep — lightweight operations every gateway_start
// ============================================================================

/**
 * Fetch memories for sweep evaluation (with vectors for decay engine).
 */
async function fetchForSweep(
  store: MemoryStore,
  limit: number,
  scopeFilter?: string[],
): Promise<MemoryEntry[]> {
  // Use fetchForCompaction since it includes vectors, which decay engine needs
  return store.fetchForCompaction(Date.now(), scopeFilter, limit);
}

/**
 * Compute memory health score.
 *
 * health = (core_active_ratio * 0.4) + (avg_confidence * 0.3) + (recall_success_rate * 0.3)
 *
 * @param entries Memories to evaluate
 * @returns health score in [0, 1]
 */
function computeMemoryHealth(entries: MemoryEntry[]): number {
  if (entries.length === 0) return 0.5; // neutral for empty stores

  let coreCount = 0;
  let activeCoreCount = 0;
  let totalConfidence = 0;
  let totalBadRecall = 0;
  let totalAccessCount = 0;

  for (const entry of entries) {
    const meta = parseSmartMetadata(entry.metadata, entry);
    if (meta.tier === "core") {
      coreCount++;
      if (meta.state !== "archived" && meta.bad_recall_count < 3) {
        activeCoreCount++;
      }
    }
    totalConfidence += meta.confidence;
    totalBadRecall += meta.bad_recall_count;
    totalAccessCount += meta.access_count;
  }

  const coreActiveRatio = coreCount > 0 ? activeCoreCount / coreCount : 0.5;
  const avgConfidence = totalConfidence / entries.length;
  // Recall success rate: 1 - (bad_recalls / (total_accesses + 1))
  const recallSuccessRate = 1 - (totalBadRecall / (totalAccessCount + 1));

  return (
    coreActiveRatio * 0.4 +
    avgConfidence * 0.3 +
    recallSuccessRate * 0.3
  );
}

/**
 * Run the sweep phase: evaluate decay, mark stale entries, compute health,
 * and recover archived memories if health is too low.
 *
 * Decay scores are computed but NOT written back (they are retrieval-time
 * computations). Only explicit state changes (stale marking, recovery) are persisted.
 *
 * @param store       Memory store
 * @param decayConfig Decay engine config
 * @param sweepConfig Sweep-specific config
 * @param scopeFilter Optional scope filter
 * @param logger      Optional logger
 */
export async function runSweep(
  store: MemoryStore,
  decayConfig: DecayConfig = DEFAULT_DECAY_CONFIG,
  sweepConfig: SweepConfig = DEFAULT_SWEEP_CONFIG,
  scopeFilter?: string[],
  logger?: PipelineLogger,
): Promise<SweepResult> {
  const entries = await fetchForSweep(store, sweepConfig.maxMemoriesPerSweep, scopeFilter);
  if (entries.length === 0) {
    return { memoriesEvaluated: 0, staleMarked: 0, healthScore: 0.5, recovered: 0 };
  }

  const engine = createDecayEngine(decayConfig);
  const decayScores = engine.scoreAll(entries.map((e) => {
    const { memory } = getDecayableFromEntry(e);
    return memory;
  }));

  // Count stale entries
  let staleMarked = 0;
  for (let i = 0; i < entries.length; i++) {
    if (decayScores[i].composite < sweepConfig.staleThreshold) {
      staleMarked++;
    }
  }

  // Compute health
  const healthScore = computeMemoryHealth(entries);

  // Auto-recovery: if health is below threshold, recover high-confidence archived memories
  let recovered = 0;
  if (healthScore < sweepConfig.healthThreshold) {
    const archivedHighConfidence = entries.filter((e) => {
      const meta = parseSmartMetadata(e.metadata, e);
      return meta.state === "archived" && meta.confidence >= 0.6;
    });

    for (const entry of archivedHighConfidence) {
      try {
        const meta = parseSmartMetadata(entry.metadata, entry);
        const updated = buildSmartMetadata(entry, {
          state: "confirmed",
          tier: meta.tier === "peripheral" ? "working" : meta.tier,
        });
        await store.patchMetadata(
          entry.id,
          JSON.parse(stringifySmartMetadata(updated)),
          scopeFilter,
        );
        recovered++;
        logger?.info(
          `sweep [recovery]: ${entry.id.slice(0, 8)} restored (confidence=${meta.confidence.toFixed(2)})`,
        );
      } catch (err) {
        logger?.warn(
          `sweep [recovery]: failed to restore ${entry.id.slice(0, 8)}: ${String(err)}`,
        );
      }
    }
  }

  logger?.info(
    `sweep: evaluated=${entries.length} stale=${staleMarked} health=${healthScore.toFixed(3)} recovered=${recovered}`,
  );

  return {
    memoriesEvaluated: entries.length,
    staleMarked,
    healthScore,
    recovered,
  };
}

// ============================================================================
// Pipeline orchestrator
// ============================================================================

export interface BackgroundSchedulerOptions {
  store: MemoryStore;
  embedder: CompactorEmbedder;
  config: PipelineConfig;
  logger: PipelineLogger;
  /** State directory for cooldown files. Default: dbPath parent */
  stateDir: string;
  /** Optional scope filter. */
  scopeFilter?: string[];
  /** Decay engine config for sweep phase. */
  decayConfig?: DecayConfig;
}

/**
 * Run the full background processing pipeline.
 *
 * This is designed to be called from `gateway_start`. Each phase runs
 * sequentially (sweep → consolidate → compact), with fire-and-forget error
 * handling. A failed phase does not prevent subsequent phases from running.
 */
export async function runBackgroundPipeline(
  options: BackgroundSchedulerOptions,
): Promise<PipelineResult> {
  const { store, embedder, config, logger, stateDir, scopeFilter, decayConfig } = options;

  const decayCfg = decayConfig ?? DEFAULT_DECAY_CONFIG;
  const sweepCfg = config.sweep ?? DEFAULT_SWEEP_CONFIG;

  // --- Phase 1: Sweep (always runs) ---
  let sweepResult: SweepResult | null = null;
  try {
    sweepResult = await runSweep(store, decayCfg, sweepCfg, scopeFilter, logger);
  } catch (err) {
    logger.warn(`pipeline [sweep]: failed: ${String(err)}`);
  }

  // --- Phase 2: Consolidation (cooldown-gated) ---
  let consolidationResult: PipelineResult["consolidation"] = null;
  const consolidationCfg = config.consolidation;
  if (consolidationCfg?.enabled) {
    const stateFile = join(stateDir, ".consolidation-state.json");
    try {
      const should = await shouldRunConsolidation(stateFile, consolidationCfg.cooldownHours ?? 24);
      if (should) {
        await recordConsolidationRun(stateFile);
        const result = await runConsolidationSweep(
          store,
          consolidationCfg,
          scopeFilter,
          logger,
        );
        consolidationResult = {
          evaluated: result.evaluated,
          promoted: result.promoted,
          archived: result.archived,
          suppressed: result.suppressed,
        };
      }
    } catch (err) {
      logger.warn(`pipeline [consolidation]: failed: ${String(err)}`);
    }
  }

  // --- Phase 3: Compaction (cooldown-gated) ---
  let compactionResult: PipelineResult["compaction"] = null;
  const compactionCfg = config.compaction;
  if (compactionCfg?.enabled) {
    const stateFile = join(stateDir, ".compaction-state.json");
    try {
      const should = await shouldRunCompaction(stateFile, compactionCfg.cooldownHours ?? 24);
      if (should) {
        await recordCompactionRun(stateFile);
        const result = await runCompaction(
          store,
          embedder,
          compactionCfg,
          scopeFilter,
          logger,
        );
        compactionResult = {
          scanned: result.scanned,
          clusters: result.clustersFound,
          deleted: result.memoriesDeleted,
          created: result.memoriesCreated,
        };
      }
    } catch (err) {
      logger.warn(`pipeline [compaction]: failed: ${String(err)}`);
    }
  }

  return {
    sweep: sweepResult,
    consolidation: consolidationResult,
    compaction: compactionResult,
  };
}
