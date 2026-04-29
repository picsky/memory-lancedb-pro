/**
 * Shared utility functions used across multiple modules.
 */

// ============================================================================
// Clamp utilities
// ============================================================================

/** Clamp a number to [lo, hi]. */
export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Clamp to [min, max], returning min for non-finite input. */
export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Clamp to [0, 1], returning fallback for non-finite input. */
export function clamp01(value: number, fallback = 0.7): number {
  if (!Number.isFinite(value)) return Number.isFinite(fallback) ? fallback : 0;
  return Math.min(1, Math.max(0, value));
}

/** Clamp to [0, 1] with a configurable floor. */
export function clamp01WithFloor(value: number, floor: number): number {
  const safeFloor = clamp01(floor, 0);
  return Math.max(safeFloor, clamp01(value, safeFloor));
}

/** Clamp non-negative integer count, returning fallback for invalid input. */
export function clampCount(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/** Clamp positive integer, returning fallback for invalid input. */
export function clampPositiveInt(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

// ============================================================================
// Cosine similarity
// ============================================================================

/**
 * Cosine similarity between two vectors.
 * Returns 0 if vectors are empty, mismatched length, or have zero norm.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const norm = Math.sqrt(normA) * Math.sqrt(normB);
  return norm === 0 ? 0 : dotProduct / norm;
}
