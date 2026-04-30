/**
 * Memory Consolidation Engine
 *
 * Computes a consolidation_score for each memory entry by combining multiple
 * access and quality signals. Used by the background sweep to decide which
 * memories should be promoted, demoted, or archived.
 *
 * Unlike the compactor (which merges similar memories by vector cosine),
 * consolidation answers "which memories matter?" using a multi-factor score.
 *
 * Scoring model (6 components, weights sum to 1.0):
 *   - access_recency    (0.25): exponential decay from last access
 *   - access_frequency  (0.20): logarithmic saturation of access_count
 *   - injection_use     (0.20): how often injected into context
 *   - confirmation      (0.15): confirmed-use signal
 *   - bad_recall        (-0.15): penalty for contradictions / useless recalls
 *   - tier_stability    (0.05): reward for stable tier membership
 *
 * Actions based on consolidation_score:
 *   - score >= promoteThreshold  → promote to core tier
 *   - score <= archiveThreshold  → mark as candidate_archive
 *   - bad_recall_count >= suppressThreshold → suppress
 */

import type { MemoryEntry } from "./store.js";
import type { MemoryTier, MemoryState } from "./memory-categories.js";
import {
  parseSmartMetadata,
  buildSmartMetadata,
  stringifySmartMetadata,
} from "./smart-metadata.js";

// ============================================================================
// Types
// ============================================================================

export interface ConsolidationConfig {
  /** Enable consolidation sweeps. Default: false */
  enabled: boolean;
  /** Run at most once per N hours (gateway_start guard). Default: 24 */
  cooldownHours: number;

  // Scoring weights (should sum to 1.0 for positive components)
  /** Weight for access recency. Default: 0.25 */
  weightAccessRecency: number;
  /** Weight for access frequency. Default: 0.20 */
  weightAccessFrequency: number;
  /** Weight for injection use. Default: 0.20 */
  weightInjectionUse: number;
  /** Weight for confirmation signal. Default: 0.15 */
  weightConfirmation: number;
  /** Weight for bad recall penalty. Default: 0.15 */
  weightBadRecall: number;
  /** Weight for tier stability. Default: 0.05 */
  weightTierStability: number;

  // Thresholds
  /** Score >= this → promote to core. Default: 0.75 */
  promoteThreshold: number;
  /** Score <= this → candidate for archive. Default: 0.15 */
  archiveThreshold: number;
  /** bad_recall_count >= this → suppress. Default: 5 */
  suppressThreshold: number;
  /** Minimum age (days) before a memory can be archived. Default: 30 */
  minArchiveAgeDays: number;
  /** Maximum memories to evaluate per sweep. Default: 500 */
  maxMemoriesPerSweep: number;

  /** Report plan without writing changes. Default: false */
  dryRun: boolean;
}

export const DEFAULT_CONSOLIDATION_CONFIG: ConsolidationConfig = {
  enabled: false,
  cooldownHours: 24,
  weightAccessRecency: 0.25,
  weightAccessFrequency: 0.20,
  weightInjectionUse: 0.20,
  weightConfirmation: 0.15,
  weightBadRecall: 0.15,
  weightTierStability: 0.05,
  promoteThreshold: 0.75,
  archiveThreshold: 0.15,
  suppressThreshold: 5,
  minArchiveAgeDays: 30,
  maxMemoriesPerSweep: 500,
  dryRun: false,
};

export interface ConsolidationScore {
  memoryId: string;
  /** Overall consolidation score [0, 1] */
  score: number;
  /** Per-component breakdown */
  components: {
    accessRecency: number;
    accessFrequency: number;
    injectionUse: number;
    confirmation: number;
    badRecall: number;
    tierStability: number;
  };
  /** Recommended action */
  action: "promote" | "archive" | "suppress" | "maintain";
  /** Current tier */
  currentTier: MemoryTier;
}

export interface ConsolidationResult {
  /** Memories evaluated */
  evaluated: number;
  /** Memories promoted to core */
  promoted: number;
  /** Memories marked for archive */
  archived: number;
  /** Memories suppressed */
  suppressed: number;
  /** Whether this was a dry run */
  dryRun: boolean;
}

// ============================================================================
// Minimal store interface
// ============================================================================

export interface ConsolidationStore {
  /** Fetch memories for consolidation evaluation (includes full metadata) */
  fetchForConsolidation(
    maxTimestamp: number,
    scopeFilter?: string[],
    limit?: number,
  ): Promise<MemoryEntry[]>;
  /** Patch metadata for a single memory */
  patchMetadata(
    id: string,
    patch: Record<string, unknown>,
    scopeFilter?: string[],
  ): Promise<MemoryEntry | null>;
}

export interface ConsolidationLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

// ============================================================================
// Half-life for recency decay
// ============================================================================

const RECENCY_HALF_LIFE_DAYS = 14;

// ============================================================================
// Component scorers
// ============================================================================

/**
 * Access recency: exponential decay from last access time.
 * Returns 1.0 if accessed recently, approaches 0.0 for stale memories.
 */
function scoreAccessRecency(lastAccessedAt: number, now: number): number {
  const daysSince = Math.max(0, (now - lastAccessedAt) / (1000 * 60 * 60 * 24));
  return Math.exp(-daysSince * (Math.LN2 / RECENCY_HALF_LIFE_DAYS));
}

/**
 * Access frequency: logarithmic saturation curve.
 * Returns values in [0, 1], saturating around accessCount ~30.
 */
function scoreAccessFrequency(accessCount: number): number {
  if (accessCount <= 0) return 0;
  return 1 - Math.exp(-accessCount / 8);
}

/**
 * Injection use: how often this memory was injected into agent context.
 * Same logarithmic saturation, slightly lower saturation point than access.
 */
function scoreInjectionUse(injectedCount: number): number {
  if (injectedCount <= 0) return 0;
  return 1 - Math.exp(-injectedCount / 10);
}

/**
 * Confirmation signal: whether the memory was confirmed useful.
 * Uses last_confirmed_use_at relative to creation time.
 * Returns 1.0 if recently confirmed, 0.5 if confirmed long ago, 0.0 if never.
 */
function scoreConfirmation(
  lastConfirmedUseAt: number | undefined,
  createdAt: number,
  now: number,
): number {
  if (!lastConfirmedUseAt || lastConfirmedUseAt <= 0) return 0;

  const ageDays = (now - createdAt) / (1000 * 60 * 60 * 24);
  if (ageDays <= 0) return 1.0;

  const daysSinceConfirmation = (now - lastConfirmedUseAt) / (1000 * 60 * 60 * 24);
  const recencyWeight = Math.exp(-daysSinceConfirmation * (Math.LN2 / RECENCY_HALF_LIFE_DAYS));

  // Base value of 0.5 for ever-confirmed, plus recency bonus up to 0.5
  return 0.5 + 0.5 * recencyWeight;
}

/**
 * Bad recall penalty: maps bad_recall_count to [0, 1] penalty.
 * Returns 1.0 (no penalty) when bad_recall_count = 0,
 * approaches 0.0 as bad_recall_count increases.
 */
function scoreBadRecall(badRecallCount: number): number {
  if (badRecallCount <= 0) return 1.0;
  // Half-life at 3 bad recalls
  return Math.exp(-badRecallCount * (Math.LN2 / 3));
}

/**
 * Tier stability: reward memories that have remained in their tier.
 * Uses age as a proxy (older memories at same tier = more stable).
 * Returns values in [0.5, 1.0] — never fully penalized.
 */
function scoreTierStability(createdAt: number, tier: MemoryTier, now: number): number {
  const ageDays = (now - createdAt) / (1000 * 60 * 60 * 24);
  // Core memories need less stability proof; peripheral need more
  const halfLife = tier === "core" ? 7 : tier === "working" ? 14 : 30;
  const stability = 1 - Math.exp(-ageDays / halfLife);
  return 0.5 + 0.5 * stability;
}

// ============================================================================
// Public scoring API
// ============================================================================

/**
 * Compute the full consolidation score for a single memory entry.
 *
 * @param entry  Memory entry with metadata
 * @param config Scoring weights and thresholds
 * @param now    Current timestamp (defaults to Date.now())
 */
export function computeConsolidationScore(
  entry: MemoryEntry,
  config: ConsolidationConfig = DEFAULT_CONSOLIDATION_CONFIG,
  now: number = Date.now(),
): ConsolidationScore {
  const meta = parseSmartMetadata(entry.metadata, entry);
  const createdAt = entry.timestamp > 0 ? entry.timestamp : now;

  const accessRecency = scoreAccessRecency(meta.last_accessed_at || createdAt, now);
  const accessFrequency = scoreAccessFrequency(meta.access_count);
  const injectionUse = scoreInjectionUse(meta.injected_count);
  const confirmation = scoreConfirmation(meta.last_confirmed_use_at, createdAt, now);
  const badRecall = scoreBadRecall(meta.bad_recall_count);
  const tierStability = scoreTierStability(createdAt, meta.tier, now);

  // Weighted composite. Bad recall is a penalty (subtracted).
  const {
    weightAccessRecency: wRecency,
    weightAccessFrequency: wFreq,
    weightInjectionUse: wInject,
    weightConfirmation: wConfirm,
    weightBadRecall: wBad,
    weightTierStability: wTier,
  } = config;

  const score =
    wRecency * accessRecency +
    wFreq * accessFrequency +
    wInject * injectionUse +
    wConfirm * confirmation +
    wTier * tierStability -
    wBad * (1 - badRecall); // penalty: 0 bad recalls → 0 penalty

  // Clamp to [0, 1]
  const clampedScore = Math.max(0, Math.min(1, score));

  // Determine action
  let action: ConsolidationScore["action"] = "maintain";
  if (clampedScore >= config.promoteThreshold) {
    action = "promote";
  } else if (clampedScore <= config.archiveThreshold) {
    action = "archive";
  }
  if (meta.bad_recall_count >= config.suppressThreshold) {
    action = "suppress";
  }

  return {
    memoryId: entry.id,
    score: clampedScore,
    components: {
      accessRecency,
      accessFrequency,
      injectionUse,
      confirmation,
      badRecall,
      tierStability,
    },
    action,
    currentTier: meta.tier,
  };
}

/**
 * Compute consolidation scores for multiple entries.
 */
export function computeConsolidationScores(
  entries: MemoryEntry[],
  config: ConsolidationConfig = DEFAULT_CONSOLIDATION_CONFIG,
  now: number = Date.now(),
): ConsolidationScore[] {
  return entries.map((e) => computeConsolidationScore(e, config, now));
}

// ============================================================================
// Tier transition logic
// ============================================================================

/**
 * Determine the target tier and state based on consolidation score and current tier.
 *
 * Transition rules:
 *   - score >= promoteThreshold AND current tier != core → promote to core
 *   - score <= archiveThreshold AND age >= minArchiveAgeDays → archive
 *   - bad_recall >= suppressThreshold → suppress (regardless of score)
 *   - otherwise → maintain current tier
 */
function computeTierTransition(
  score: ConsolidationScore,
  entry: MemoryEntry,
  config: ConsolidationConfig,
  now: number,
): { newTier: MemoryTier; newState: MemoryState | null; action: string } {
  const meta = parseSmartMetadata(entry.metadata, entry);
  const ageDays = (now - (entry.timestamp || now)) / (1000 * 60 * 60 * 24);

  switch (score.action) {
    case "promote":
      if (meta.tier !== "core") {
        return { newTier: "core", newState: "confirmed", action: "promote-to-core" };
      }
      return { newTier: meta.tier, newState: null, action: "maintain" };

    case "suppress":
      return { newTier: meta.tier, newState: "archived", action: "suppress" };

    case "archive":
      if (ageDays >= config.minArchiveAgeDays && meta.state !== "archived") {
        return { newTier: "peripheral", newState: "archived", action: "archive" };
      }
      return { newTier: meta.tier, newState: null, action: "maintain" };

    default:
      return { newTier: meta.tier, newState: null, action: "maintain" };
  }
}

// ============================================================================
// Main sweep runner
// ============================================================================

/**
 * Run a single consolidation sweep over memories.
 *
 * Fetches memories up to `maxMemoriesPerSweep`, computes consolidation scores,
 * applies tier transitions, and patches metadata.
 *
 * @param store    Storage backend
 * @param config   Consolidation configuration
 * @param scopes   Scope filter; undefined = all scopes
 * @param logger   Optional logger
 */
export async function runConsolidationSweep(
  store: ConsolidationStore,
  config: ConsolidationConfig,
  scopes?: string[],
  logger?: ConsolidationLogger,
): Promise<ConsolidationResult> {
  const now = Date.now();
  const cutoff = now; // evaluate all memories (age filtering in transition logic)

  const entries = await store.fetchForConsolidation(
    cutoff,
    scopes,
    config.maxMemoriesPerSweep,
  );

  if (entries.length === 0) {
    return { evaluated: 0, promoted: 0, archived: 0, suppressed: 0, dryRun: config.dryRun };
  }

  const scores = computeConsolidationScores(entries, config, now);

  let promoted = 0;
  let archived = 0;
  let suppressed = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const score = scores[i];

    const transition = computeTierTransition(score, entry, config, now);
    if (transition.action === "maintain") continue;

    if (config.dryRun) {
      logger?.info(
        `consolidation [dry-run]: ${entry.id.slice(0, 8)} → ${transition.action} ` +
        `(score=${score.score.toFixed(3)}, tier=${score.currentTier})`,
      );
      if (transition.action === "promote-to-core") promoted++;
      else if (transition.action === "archive") archived++;
      else if (transition.action === "suppress") suppressed++;
      continue;
    }

    try {
      const meta = parseSmartMetadata(entry.metadata, entry);
      const patch = buildSmartMetadata(entry, {
        tier: transition.newTier,
        ...(transition.newState !== null ? { state: transition.newState } : {}),
      });

      if (transition.action === "suppress") {
        // Also set suppressed_until_turn to next turn
        (patch as Record<string, unknown>).suppressed_until_turn =
          (meta.suppressed_until_turn || 0) + 1;
      }

      await store.patchMetadata(entry.id, JSON.parse(stringifySmartMetadata(patch)), scopes);

      switch (transition.action) {
        case "promote-to-core": promoted++; break;
        case "archive": archived++; break;
        case "suppress": suppressed++; break;
      }

      logger?.info(
        `consolidation: ${entry.id.slice(0, 8)} → ${transition.action} ` +
        `(score=${score.score.toFixed(3)}, tier=${transition.newTier})`,
      );
    } catch (err) {
      logger?.warn(
        `consolidation: failed to apply transition for ${entry.id.slice(0, 8)}: ${String(err)}`,
      );
    }
  }

  logger?.info(
    `consolidation: evaluated=${entries.length} promoted=${promoted} ` +
    `archived=${archived} suppressed=${suppressed}`,
  );

  return {
    evaluated: entries.length,
    promoted,
    archived,
    suppressed,
    dryRun: false,
  };
}

// ============================================================================
// Cooldown helpers
// ============================================================================

/**
 * Check whether enough time has passed since the last consolidation run.
 */
export async function shouldRunConsolidation(
  stateFile: string,
  cooldownHours: number,
): Promise<boolean> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(stateFile, "utf8");
    const state = JSON.parse(raw) as { lastRunAt?: number };
    if (typeof state.lastRunAt === "number") {
      const elapsed = Date.now() - state.lastRunAt;
      return elapsed >= cooldownHours * 60 * 60 * 1000;
    }
  } catch {
    // File doesn't exist or is malformed — treat as never run
  }
  return true;
}

export async function recordConsolidationRun(stateFile: string): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ lastRunAt: Date.now() }), "utf8");
}
