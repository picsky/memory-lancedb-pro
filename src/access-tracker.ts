/**
 * Access Tracker
 *
 * Tracks memory access patterns to support reinforcement-based decay.
 * Frequently accessed memories decay more slowly (longer effective half-life).
 *
 * Key exports:
 * - parseAccessMetadata   — extract accessCount/lastAccessedAt from metadata JSON
 * - buildUpdatedMetadata  — merge access fields into existing metadata JSON
 * - computeEffectiveHalfLife — compute reinforced half-life from access history
 * - AccessTracker         — debounced write-back tracker for batch metadata updates
 */

import type { MemoryStore } from "./store.js";

// ============================================================================
// Types
// ============================================================================

export interface AccessMetadata {
  readonly accessCount: number;
  readonly lastAccessedAt: number;
}

export interface AccessTrackerOptions {
  readonly store: MemoryStore;
  readonly logger: {
    warn: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
  readonly debounceMs?: number;
}

// ============================================================================
// Constants
// ============================================================================

const MIN_ACCESS_COUNT = 0;
const MAX_ACCESS_COUNT = 10_000;

/** Access count itself decays with a 30-day half-life */
const ACCESS_DECAY_HALF_LIFE_DAYS = 30;

/** Confidence update delta per confirmed/bad event. */
const CONFIDENCE_DELTA = 0.05;

/** Confidence decay rate per day of non-use (slow leak). */
const CONFIDENCE_DECAY_RATE_PER_DAY = 0.001; // ~36% loss over 1 year if never used

/** Minimum confidence floor. */
const MIN_CONFIDENCE = 0.1;

// ============================================================================
// Utility
// ============================================================================

function clampAccessCount(value: number): number {
  if (!Number.isFinite(value)) return MIN_ACCESS_COUNT;
  return Math.min(
    MAX_ACCESS_COUNT,
    Math.max(MIN_ACCESS_COUNT, Math.floor(value)),
  );
}

// ============================================================================
// Metadata Parsing
// ============================================================================

/**
 * Parse access-related fields from a metadata JSON string.
 *
 * Handles: undefined, empty string, malformed JSON, negative numbers,
 * numbers exceeding 10000. Always returns a valid AccessMetadata.
 */
export function parseAccessMetadata(
  metadata: string | undefined,
): AccessMetadata {
  if (metadata === undefined || metadata === "") {
    return { accessCount: 0, lastAccessedAt: 0 };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return { accessCount: 0, lastAccessedAt: 0 };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { accessCount: 0, lastAccessedAt: 0 };
  }

  const obj = parsed as Record<string, unknown>;

  // Support both camelCase and snake_case keys (beta smart-memory uses snake_case).
  const rawCountAny = obj.accessCount ?? obj.access_count;
  const rawCount =
    typeof rawCountAny === "number" ? rawCountAny : Number(rawCountAny ?? 0);

  const rawLastAny = obj.lastAccessedAt ?? obj.last_accessed_at;
  const rawLastAccessed =
    typeof rawLastAny === "number" ? rawLastAny : Number(rawLastAny ?? 0);

  return {
    accessCount: clampAccessCount(rawCount),
    lastAccessedAt:
      Number.isFinite(rawLastAccessed) && rawLastAccessed >= 0
        ? rawLastAccessed
        : 0,
  };
}

// ============================================================================
// Metadata Building
// ============================================================================

/**
 * Merge an access-count increment into existing metadata JSON.
 *
 * Preserves ALL existing fields in the metadata object — only overwrites
 * `accessCount` and `lastAccessedAt`. Returns a new JSON string.
 */
export function buildUpdatedMetadata(
  existingMetadata: string | undefined,
  accessDelta: number,
): string {
  let existing: Record<string, unknown> = {};

  if (existingMetadata !== undefined && existingMetadata !== "") {
    try {
      const parsed = JSON.parse(existingMetadata);
      if (typeof parsed === "object" && parsed !== null) {
        existing = { ...parsed };
      }
    } catch {
      // malformed JSON — start fresh but preserve nothing
    }
  }

  const prev = parseAccessMetadata(existingMetadata);
  const newCount = clampAccessCount(prev.accessCount + accessDelta);

  const now = Date.now();

  return JSON.stringify({
    ...existing,
    // Write both camelCase and snake_case for compatibility.
    accessCount: newCount,
    lastAccessedAt: now,
    access_count: newCount,
    last_accessed_at: now,
  });
}

// ============================================================================
// Effective Half-Life Computation
// ============================================================================

/**
 * Compute the effective half-life for a memory based on its access history.
 *
 * The access count itself decays over time (30-day half-life for access
 * freshness), so stale accesses contribute less reinforcement. The extension
 * uses a logarithmic curve (`Math.log1p`) to provide diminishing returns.
 *
 * @param baseHalfLife        - Base half-life in days (e.g. 30)
 * @param accessCount         - Raw number of times the memory was accessed
 * @param lastAccessedAt      - Timestamp (ms) of last access
 * @param reinforcementFactor - Scaling factor for reinforcement (0 = disabled)
 * @param maxMultiplier       - Hard cap: result <= baseHalfLife * maxMultiplier
 * @returns Effective half-life in days
 */
export function computeEffectiveHalfLife(
  baseHalfLife: number,
  accessCount: number,
  lastAccessedAt: number,
  reinforcementFactor: number,
  maxMultiplier: number,
): number {
  // Short-circuit: no reinforcement or no accesses
  if (reinforcementFactor === 0 || accessCount <= 0) {
    return baseHalfLife;
  }

  const now = Date.now();
  const daysSinceLastAccess = Math.max(
    0,
    (now - lastAccessedAt) / (1000 * 60 * 60 * 24),
  );

  // Access freshness decays exponentially with 30-day half-life
  const accessFreshness = Math.exp(
    -daysSinceLastAccess * (Math.LN2 / ACCESS_DECAY_HALF_LIFE_DAYS),
  );

  // Effective access count after freshness decay
  const effectiveAccessCount = accessCount * accessFreshness;

  // Logarithmic extension for diminishing returns
  const extension =
    baseHalfLife * reinforcementFactor * Math.log1p(effectiveAccessCount);

  const result = baseHalfLife + extension;

  // Hard cap
  const cap = baseHalfLife * maxMultiplier;
  return Math.min(result, cap);
}

// ============================================================================
// Confidence Update Computation
// ============================================================================

/**
 * Compute how confidence should change based on recall outcomes.
 *
 * Rules:
 * - Confirmed useful (support / confirmed_use): confidence += delta
 * - Bad recall (contradicted / useless): confidence -= delta
 * - Long-term non-use: slow decay (1 per day of CONFIDENCE_DECAY_RATE)
 *
 * @param currentConfidence  Current confidence [0, 1]
 * @param badRecallCount     Number of bad recall events
 * @param lastConfirmedUseAt Timestamp of last confirmed use (0 if never)
 * @param lastAccessedAt     Timestamp of last access (0 if never)
 * @param createdAt          Memory creation timestamp
 * @param now                Current timestamp
 * @returns New confidence value [0, 1]
 */
export function computeConfidenceUpdate(
  currentConfidence: number,
  badRecallCount: number,
  lastConfirmedUseAt: number,
  lastAccessedAt: number,
  createdAt: number,
  now: number = Date.now(),
): number {
  if (!Number.isFinite(currentConfidence)) currentConfidence = 0.7;

  let confidence = currentConfidence;

  // Bad recall penalty (cumulative, capped at max 0.5 total loss)
  const badRecallPenalty = Math.min(0.5, badRecallCount * CONFIDENCE_DELTA);
  confidence -= badRecallPenalty;

  // Confirmed use bonus (only if there was at least one confirmed use)
  if (lastConfirmedUseAt > 0) {
    confidence += CONFIDENCE_DELTA * 0.5; // smaller bonus, cumulative effect is limited
  }

  // Long-term non-use decay: slow leak
  const lastActivity = Math.max(lastAccessedAt, lastConfirmedUseAt, createdAt);
  const daysSinceActivity = Math.max(0, (now - lastActivity) / (1000 * 60 * 60 * 24));
  if (daysSinceActivity > 30) {
    // Only start decaying after 30 days of inactivity
    const decay = Math.min(0.3, (daysSinceActivity - 30) * CONFIDENCE_DECAY_RATE_PER_DAY);
    confidence -= decay;
  }

  return Math.max(MIN_CONFIDENCE, Math.min(1, confidence));
}

/**
 * Build updated metadata including confidence recalculation.
 *
 * Extends `buildUpdatedMetadata` to also update confidence based on
 * recall outcomes. Use this when the access event also carries outcome
 * information (e.g., the memory was contradicted or confirmed useful).
 */
export function buildUpdatedMetadataWithConfidence(
  existingMetadata: string | undefined,
  accessDelta: number,
  outcome?: { confirmed?: boolean; contradicted?: boolean },
  now: number = Date.now(),
): string {
  const base = buildUpdatedMetadata(existingMetadata, accessDelta);
  const parsed = parseSmartMetadataForConfidence(base);

  const newConfidence = computeConfidenceUpdate(
    parsed.confidence,
    parsed.bad_recall_count + (outcome?.contradicted ? 1 : 0),
    parsed.last_confirmed_use_at ?? 0,
    parsed.last_accessed_at || now,
    parsed.valid_from || now,
    now,
  );

  // Merge confidence back into metadata
  try {
    const obj = JSON.parse(base);
    obj.confidence = newConfidence;
    if (outcome?.confirmed) {
      obj.last_confirmed_use_at = now;
    }
    if (outcome?.contradicted) {
      obj.bad_recall_count = (obj.bad_recall_count ?? 0) + 1;
    }
    return JSON.stringify(obj);
  } catch {
    return base;
  }
}

/**
 * Minimal parse for confidence fields (avoid circular import with smart-metadata).
 */
function parseSmartMetadataForConfidence(
  metadata: string,
): {
  confidence: number;
  bad_recall_count: number;
  last_confirmed_use_at: number | undefined;
  last_accessed_at: number;
  valid_from: number;
} {
  try {
    const obj = JSON.parse(metadata);
    return {
      confidence: typeof obj.confidence === "number" ? obj.confidence : 0.7,
      bad_recall_count: typeof obj.bad_recall_count === "number" ? obj.bad_recall_count : 0,
      last_confirmed_use_at: typeof obj.last_confirmed_use_at === "number" ? obj.last_confirmed_use_at : undefined,
      last_accessed_at: typeof obj.last_accessed_at === "number" ? obj.last_accessed_at : 0,
      valid_from: typeof obj.valid_from === "number" ? obj.valid_from : 0,
    };
  } catch {
    return {
      confidence: 0.7,
      bad_recall_count: 0,
      last_confirmed_use_at: undefined,
      last_accessed_at: 0,
      valid_from: 0,
    };
  }
}

// ============================================================================
// AccessTracker Class
// ============================================================================

/**
 * Debounced write-back tracker for memory access events.
 *
 * `recordAccess()` is synchronous (Map update only, no I/O). Pending deltas
 * accumulate until `flush()` is called (or by a future scheduled callback).
 * On flush, all pending entries are read in a single batch query via
 * `store.batchGetById()`, their metadata is merged in JS, then written
 * back in a single lock acquisition via `store.bulkPatchMetadata()`.
 */
export class AccessTracker {
  private readonly pending: Map<string, number> = new Map();
  // Tracks retry count per ID so that delta is never amplified across failures.
  private readonly _retryCount = new Map<string, number>();
  private readonly _maxRetries = 5;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;
  private readonly debounceMs: number;
  private readonly store: MemoryStore;
  private readonly logger: {
    warn: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };

  constructor(options: AccessTrackerOptions) {
    this.store = options.store;
    this.logger = options.logger;
    this.debounceMs = options.debounceMs ?? 5_000;
  }

  /**
   * Record one access for each of the given memory IDs.
   * Synchronous — only updates the in-memory pending map.
   */
  recordAccess(ids: readonly string[]): void {
    for (const id of ids) {
      const current = this.pending.get(id) ?? 0;
      this.pending.set(id, current + 1);
    }

    // Reset debounce timer
    this.resetTimer();
  }

  /**
   * Return a snapshot of all pending (id -> delta) entries.
   */
  getPendingUpdates(): Map<string, number> {
    return new Map(this.pending);
  }

  /**
   * Flush pending access deltas to the store.
   *
   * If a flush is already in progress, awaits the current flush to complete.
   * If new pending data accumulated during the in-flight flush, a follow-up
   * flush is automatically triggered.
   */
  async flush(): Promise<void> {
    this.clearTimer();

    // If a flush is in progress, wait for it to finish
    if (this.flushPromise) {
      await this.flushPromise;
      // After the in-flight flush completes, check if new data accumulated
      if (this.pending.size > 0) {
        return this.flush();
      }
      return;
    }

    if (this.pending.size === 0) return;

    this.flushPromise = this.doFlush();
    try {
      await this.flushPromise;
    } finally {
      this.flushPromise = null;
    }

    // If new data accumulated during flush, schedule a follow-up
    if (this.pending.size > 0) {
      this.resetTimer();
    }
  }

  /**
   * Tear down the tracker — cancel timers and flush pending state.
   */
  destroy(): void {
    this.clearTimer();
    if (this.pending.size > 0) {
      this.logger.warn(
        `access-tracker: destroying with ${this.pending.size} pending writes — attempting final flush (3s timeout)`,
      );
      // Snapshot pending entries BEFORE clearing so the flush has data to write.
      const snapshot = new Map(this.pending);
      this.pending.clear();
      this._retryCount.clear();
      // Fire-and-forget final flush with a hard 3s timeout.
      // Uses the snapshot so that data is available even though this.pending is cleared.
      const flushWithTimeout = Promise.race([
        this.doFlushFromSnapshot(snapshot),
        new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
      ]);
      void flushWithTimeout.catch(() => {
        // Suppress unhandled rejection during shutdown.
      });
    } else {
      this.pending.clear();
      this._retryCount.clear();
    }
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private async doFlush(): Promise<void> {
    const batch = new Map(this.pending);
    this.pending.clear();

    // Step 1: Batch-read all pending entries in a single query
    const ids = [...batch.keys()];
    const existingEntries = await this.store.batchGetById(ids);
    const entryMap = new Map(existingEntries.map(e => [e.id, e]));

    // Step 2: Build metadata patches for entries that exist
    const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const notFoundIds = new Set<string>();

    for (const [id, delta] of batch) {
      const entry = entryMap.get(id);
      if (!entry) {
        // ID not found — memory was deleted or outside scope.
        // Drop silently and clear retry counter.
        this._retryCount.delete(id);
        notFoundIds.add(id);
        continue;
      }

      const updatedMeta = buildUpdatedMetadata(entry.metadata, delta);
      patches.push({ id, patch: { metadata: updatedMeta } });
    }

    // Step 3: Batch-write in a single lock acquisition
    if (patches.length > 0) {
      try {
        const result = await this.store.bulkPatchMetadata(patches);
        // Clear retry counters for all successfully written entries
        for (const id of result.success) {
          this._retryCount.delete(id);
        }
        // Handle failures (requeue with retry)
        for (const { id, error } of result.failed) {
          this._handleWriteBackFailure(id, batch.get(id)!, error);
        }
      } catch (err) {
        // Entire bulk operation failed — requeue ALL pending entries
        for (const [id, delta] of batch) {
          if (!notFoundIds.has(id)) {
            this._handleWriteBackFailure(id, delta, String(err));
          }
        }
      }
    }
  }

  private _handleWriteBackFailure(id: string, delta: number, error: string): void {
    const retryCount = (this._retryCount.get(id) ?? 0) + 1;
    if (retryCount > this._maxRetries) {
      this._retryCount.delete(id);
      this.logger.error?.(
        `access-tracker: dropping ${id.slice(0, 8)} after ${retryCount} failed retries`,
      );
    } else {
      this._retryCount.set(id, retryCount);
      this.pending.set(id, (this.pending.get(id) ?? 0) + delta);
      this.logger.warn(
        `access-tracker: write-back failed for ${id.slice(0, 8)} (attempt ${retryCount}/${this._maxRetries}):`,
        error,
      );
    }
  }

  /**
   * Flush a pre-captured snapshot of pending entries.
   * Used by destroy() to avoid clearing this.pending before the flush runs.
   * Failures are dropped silently (no retry) since the tracker is shutting down.
   */
  private async doFlushFromSnapshot(snapshot: Map<string, number>): Promise<void> {
    if (snapshot.size === 0) return;

    // Batch-read all snapshot entries
    const ids = [...snapshot.keys()];
    const existingEntries = await this.store.batchGetById(ids);
    const entryMap = new Map(existingEntries.map(e => [e.id, e]));

    // Build patches
    const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
    for (const [id, delta] of snapshot) {
      const entry = entryMap.get(id);
      if (!entry) continue;
      const updatedMeta = buildUpdatedMetadata(entry.metadata, delta);
      patches.push({ id, patch: { metadata: updatedMeta } });
    }

    // Batch-write in single lock acquisition (best-effort)
    if (patches.length > 0) {
      try {
        await this.store.bulkPatchMetadata(patches);
      } catch {
        // Best-effort during shutdown — suppress errors.
      }
    }
  }

  private resetTimer(): void {
    this.clearTimer();
    this.debounceTimer = setTimeout(() => {
      void this.flush();
    }, this.debounceMs);
  }

  private clearTimer(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
