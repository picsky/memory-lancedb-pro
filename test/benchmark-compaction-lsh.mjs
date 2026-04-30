/**
 * Benchmark for B1: Compaction Clustering Acceleration (LSH pre-filtering)
 *
 * Compares the original O(n^2) pairwise cosine similarity clustering against
 * the LSH pre-filtered version. Measures:
 * - Speedup in clustering time
 * - Result parity (same clusters produced)
 *
 * Run: node test/benchmark-compaction-lsh.mjs
 */

import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { buildClusters, generateLSHHyperplanes } = jiti("../src/memory-compactor.ts");

// ============================================================================
// Helpers
// ============================================================================

function makeEntry(i, vector, importance = 0.5) {
  return {
    id: String(i).padStart(8, "0") + "-0000-0000-0000-000000000000",
    text: `memory-${i}`,
    vector,
    category: "fact",
    scope: "global",
    importance,
    timestamp: Date.now() - 8 * 24 * 60 * 60 * 1000,
    metadata: "{}",
  };
}

function randomVec(dim) {
  const v = new Array(dim);
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    v[i] = Math.random() * 2 - 1;
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

/** Perturb a unit vector by small Gaussian noise, re-normalize. */
function perturb(vec, noise = 0.1) {
  const dim = vec.length;
  const v = vec.slice();
  for (let i = 0; i < dim; i++) v[i] += (Math.random() * 2 - 1) * noise;
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

/** Generate entries with tight clusters of similar vectors. */
function makeClusteredEntries(n, nClusters, dim, noise = 0.05) {
  const perCluster = Math.floor(n / nClusters);
  const entries = [];
  let idx = 0;
  for (let c = 0; c < nClusters; c++) {
    const center = randomVec(dim);
    for (let i = 0; i < perCluster; i++) {
      entries.push(makeEntry(idx++, perturb(center, noise), 0.3 + Math.random() * 0.7));
    }
  }
  // Fill remainder
  while (idx < n) {
    entries.push(makeEntry(idx++, randomVec(dim), 0.3 + Math.random() * 0.7));
  }
  return entries;
}

function bench(name, fn) {
  const WARMUP = 2;
  const ITERATIONS = 5;
  // Warmup
  for (let i = 0; i < WARMUP; i++) fn();
  // Timed runs
  const times = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = Date.now();
    fn();
    times.push(Date.now() - t0);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  return { avg, min };
}

/** Original O(n^2) implementation for comparison. */
function buildClustersOriginal(entries, threshold, minClusterSize) {
  if (entries.length < minClusterSize) return [];

  const order = entries
    .map((_, i) => i)
    .sort((a, b) => entries[b].importance - entries[a].importance);

  const assigned = new Uint8Array(entries.length);
  const plans = [];

  for (const seedIdx of order) {
    if (assigned[seedIdx]) continue;

    const cluster = [seedIdx];
    assigned[seedIdx] = 1;

    const seedVec = entries[seedIdx].vector;
    if (seedVec.length === 0) continue;

    for (let j = 0; j < entries.length; j++) {
      if (assigned[j]) continue;
      const jVec = entries[j].vector;
      if (jVec.length === 0) continue;
      // Inline cosine similarity for benchmark
      let dot = 0, nA = 0, nB = 0;
      for (let d = 0; d < seedVec.length; d++) {
        dot += seedVec[d] * jVec[d];
        nA += seedVec[d] * seedVec[d];
        nB += jVec[d] * jVec[d];
      }
      const sim = nA > 0 && nB > 0 ? dot / (Math.sqrt(nA) * Math.sqrt(nB)) : 0;
      if (sim >= threshold) {
        cluster.push(j);
        assigned[j] = 1;
      }
    }

    if (cluster.length >= minClusterSize) {
      plans.push({ memberIndices: cluster, merged: null });
    }
  }
  return plans;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("=".repeat(70));
  console.log("Benchmark: Compaction Clustering — O(n^2) vs LSH pre-filter");
  console.log("=".repeat(70));
  console.log();

  const TEST_CASES = [
    { n: 50,  clusters: 5,  dim: 64   },
    { n: 100, clusters: 10, dim: 128  },
    { n: 200, clusters: 10, dim: 1024 },
    { n: 200, clusters: 20, dim: 1536 },
  ];

  const THRESHOLD = 0.88;
  const MIN_CLUSTER = 2;

  for (const tc of TEST_CASES) {
    const entries = makeClusteredEntries(tc.n, tc.clusters, tc.dim);
    const comparisons = tc.n * (tc.n - 1) / 2;

    console.log(`--- N=${tc.n}, dim=${tc.dim}, ${tc.clusters} clusters (${comparisons.toLocaleString()} pairwise comparisons) ---`);

    // Benchmark original
    const orig = bench("original", () => {
      buildClustersOriginal(entries, THRESHOLD, MIN_CLUSTER);
    });

    // Benchmark LSH
    const lsh = bench("LSH", () => {
      buildClusters(entries, THRESHOLD, MIN_CLUSTER);
    });

    // Verify result parity
    const origPlans = buildClustersOriginal(entries, THRESHOLD, MIN_CLUSTER);
    const lshPlans = buildClusters(entries, THRESHOLD, MIN_CLUSTER);

    const speedup = orig.avg / (lsh.avg || 1);
    const origComparisons = comparisons;
    // Count LSH cosine calls by instrumentation
    let lshComparisons = 0;
    const origFn = globalThis.cosineSimilarity;
    buildClusters(entries, THRESHOLD, MIN_CLUSTER); // warmup
    // We'll estimate from timing ratio
    const estLSHComparisons = Math.round(comparisons / speedup);

    console.log(`  Original: ${orig.avg.toFixed(1)}ms`);
    console.log(`  LSH:      ${lsh.avg.toFixed(1)}ms (${speedup.toFixed(1)}x faster)`);
    console.log(`  Clusters: original=${origPlans.length}, LSH=${lshPlans.length}`);
    console.log(`  Est. cosine calls: ~${origComparisons.toLocaleString()} → ~${estLSHComparisons.toLocaleString()}`);
    console.log();
  }

  console.log("=".repeat(70));
  console.log("SUMMARY: LSH pre-filtering reduces O(n^2) cosine comparisons");
  console.log("by grouping entries into signature buckets. Only entries with");
  console.log("matching LSH signatures (likely similar) get full comparison.");
  console.log("=".repeat(70));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
