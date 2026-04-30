/**
 * Benchmark for B2: Access Write-Back Batch Optimization
 *
 * Compares old sequential flush (N getById + N update) vs new batch flush
 * (1 batchGetById + 1 bulkPatchMetadata).
 *
 * Run: node test/benchmark-access-writeback.mjs
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");
const { AccessTracker, buildUpdatedMetadata } = jiti("../src/access-tracker.ts");

function makeStore(vectorDim = 3) {
  const dir = mkdtempSync(join(tmpdir(), "memory-lancedb-pro-bench-writeback-"));
  const store = new MemoryStore({ dbPath: dir, vectorDim });
  return { store, dir };
}

function makeEntry(i, overrides = {}) {
  return {
    text: `memory-${i}`.repeat(10),
    vector: Array(3).fill(0.1),
    category: "fact",
    scope: "global",
    importance: 0.5,
    metadata: JSON.stringify({ accessCount: i, lastAccessedAt: Date.now() }),
    ...overrides,
  };
}

async function insertEntries(store, n, baseTimestamp = 1000000) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const hex = String(i).padStart(8, "0");
    const id = `${hex}-0000-0000-0000-00000000000${i % 10}`;
    ids.push(id);
    await store.importEntry({
      id,
      ...makeEntry(i, { timestamp: baseTimestamp + i * 1000 }),
    });
  }
  return ids;
}

// ============================================================================
// Old sequential flush: simulate N getById + N update calls
// ============================================================================

async function sequentialFlush(store, ids) {
  for (const id of ids) {
    const entry = await store.getById(id);
    if (!entry) continue;
    const updatedMeta = buildUpdatedMetadata(entry.metadata, 1);
    await store.update(id, { metadata: updatedMeta });
  }
}

// ============================================================================
// New batch flush: 1 batchGetById + 1 bulkPatchMetadata
// ============================================================================

async function batchFlush(store, ids) {
  const entries = await store.batchGetById(ids);
  const patches = entries.map(entry => ({
    id: entry.id,
    patch: { metadata: buildUpdatedMetadata(entry.metadata, 1) },
  }));
  if (patches.length > 0) {
    await store.bulkPatchMetadata(patches);
  }
}

// ============================================================================
// Benchmark helpers
// ============================================================================

async function benchAsync(name, fn, iterations = 3) {
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const start = Date.now();
    await fn();
    times.push(Date.now() - start);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);
  return { name, avg, min, max, times };
}

// ============================================================================
// Main benchmark
// ============================================================================

async function main() {
  const WARMUP = 1;
  const ITERATIONS = 3;
  const SIZES = [5, 10, 20, 50];

  console.log("=".repeat(70));
  console.log("Benchmark: Access Write-Back Batch Optimization");
  console.log("=".repeat(70));
  console.log();

  for (const size of SIZES) {
    console.log(`--- N = ${size} pending entries ---`);

    const { store, dir } = makeStore(3);

    // Insert entries
    console.log(`  Inserting ${size} entries...`);
    const ids = await insertEntries(store, size);

    // Benchmark sequential flush (old)
    const rSeq = await benchAsync("sequential flush", () =>
      sequentialFlush(store, ids), ITERATIONS);

    // Reset: re-insert same entries for fair comparison
    // (sequential flush modified them via delete+add)
    rmSync(dir, { recursive: true, force: true });
    const { store: store2, dir: dir2 } = makeStore(3);
    const ids2 = await insertEntries(store2, size);

    // Benchmark batch flush (new)
    const rBatch = await benchAsync("batch flush", () =>
      batchFlush(store2, ids2), ITERATIONS);

    const speedup = rSeq.avg / rBatch.avg;
    const reduction = ((1 - rBatch.avg / rSeq.avg) * 100).toFixed(0);

    console.log(`  Old (sequential): ${rSeq.avg.toFixed(0)}ms avg (min: ${rSeq.min}ms, max: ${rSeq.max}ms)`);
    console.log(`  New (batch):      ${rBatch.avg.toFixed(0)}ms avg (min: ${rBatch.min}ms, max: ${rBatch.max}ms)`);
    console.log(`  Speedup:          ${speedup.toFixed(1)}x faster`);
    console.log(`  Time reduction:   ${reduction}%`);
    console.log(`  Lock acquisitions: ${size} → 1 (${((1 - 1/size) * 100).toFixed(0)}% fewer)`);
    console.log();

    // Cleanup
    rmSync(dir2, { recursive: true, force: true });
  }

  console.log("=".repeat(70));
  console.log("SUMMARY: Lock acquisition reduction");
  console.log("=".repeat(70));
  console.log();
  console.log("┌────────────┬──────────────────┬──────────────────┬──────────┐");
  console.log("│ N entries  │ Old lock acq.    │ New lock acq.    │ Reduction│");
  console.log("├────────────┼──────────────────┼──────────────────┼──────────┤");
  for (const size of SIZES) {
    const pct = ((1 - 1/size) * 100).toFixed(0);
    console.log(`│ ${String(size).padStart(10)} │ ${String(size).padStart(16)} │ ${String(1).padStart(16)} │ ${pct.padStart(8)}% │`);
  }
  console.log("└────────────┴──────────────────┴──────────────────┴──────────┘");
  console.log();
  console.log("Key insight: In real usage, the file lock can have up to ~151s max");
  console.log("wait time under contention. Reducing N lock acquisitions to 1");
  console.log("dramatically reduces the probability and impact of contention.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
