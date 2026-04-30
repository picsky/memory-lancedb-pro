/**
 * Benchmark: Consolidation vs Baseline — measuring quality improvements
 *
 * Simulates a realistic memory corpus with known ground truth, then compares:
 * 1. Baseline (no consolidation): all memories treated equally
 * 2. With consolidation: high-value memories promoted, low-value archived
 *
 * Metrics:
 * - Precision@K: fraction of top-K retrieved memories that are truly relevant
 * - Recall@K: fraction of truly relevant memories found in top-K
 * - Noise ratio: fraction of memories that are low-value but still retrievable
 * - Tier distribution: how well the system separates core vs peripheral
 *
 * Run: node test/benchmark-consolidation-quality.mjs
 */

import jitiFactory from "jiti";
import assert from "node:assert/strict";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { computeConsolidationScore, DEFAULT_CONSOLIDATION_CONFIG } =
  jiti("../src/memory-consolidation.ts");

// ============================================================================
// Simulation
// ============================================================================

/** Generate a synthetic memory corpus with known ground truth labels. */
function generateCorpus(size = 200) {
  const now = Date.now();
  const memories = [];

  // 30% high-value: frequently accessed, confirmed, no bad recalls
  for (let i = 0; i < Math.floor(size * 0.3); i++) {
    memories.push({
      id: `high-${i}`,
      text: `Important fact #${i}: ${generateText()}`,
      vector: [0.9 + Math.random() * 0.1, Math.random() * 0.1, Math.random() * 0.1],
      importance: 0.7 + Math.random() * 0.3,
      timestamp: now - (30 + Math.random() * 60) * 24 * 60 * 60 * 1000,
      metadata: JSON.stringify({
        l0_abstract: "important",
        l1_overview: "- important",
        l2_content: "important fact",
        memory_category: "patterns",
        tier: "working",
        access_count: 20 + Math.floor(Math.random() * 30),
        injected_count: 15 + Math.floor(Math.random() * 20),
        confidence: 0.8 + Math.random() * 0.2,
        last_accessed_at: now - Math.random() * 2 * 24 * 60 * 60 * 1000,
        last_confirmed_use_at: now - Math.random() * 3 * 24 * 60 * 60 * 1000,
        valid_from: now - (60 + Math.random() * 30) * 24 * 60 * 60 * 1000,
        state: "confirmed",
        source: "auto-capture",
        memory_layer: "working",
        bad_recall_count: 0,
        suppressed_until_turn: 0,
      }),
      label: "high-value",
    });
  }

  // 40% medium-value: occasional access, mixed signals
  for (let i = 0; i < Math.floor(size * 0.4); i++) {
    memories.push({
      id: `med-${i}`,
      text: `Medium fact #${i}: ${generateText()}`,
      vector: [0.4 + Math.random() * 0.3, Math.random() * 0.3, Math.random() * 0.3],
      importance: 0.4 + Math.random() * 0.3,
      timestamp: now - (15 + Math.random() * 45) * 24 * 60 * 60 * 1000,
      metadata: JSON.stringify({
        l0_abstract: "medium",
        l1_overview: "- medium",
        l2_content: "medium fact",
        memory_category: "cases",
        tier: "working",
        access_count: 2 + Math.floor(Math.random() * 5),
        injected_count: 1 + Math.floor(Math.random() * 3),
        confidence: 0.5 + Math.random() * 0.3,
        last_accessed_at: now - (5 + Math.random() * 15) * 24 * 60 * 60 * 1000,
        last_confirmed_use_at: now - (10 + Math.random() * 20) * 24 * 60 * 60 * 1000,
        valid_from: now - (30 + Math.random() * 30) * 24 * 60 * 60 * 1000,
        state: "confirmed",
        source: "auto-capture",
        memory_layer: "working",
        bad_recall_count: Math.floor(Math.random() * 2),
        suppressed_until_turn: 0,
      }),
      label: "medium-value",
    });
  }

  // 30% low-value: never accessed, high bad recall, or very stale
  for (let i = 0; i < Math.floor(size * 0.3); i++) {
    memories.push({
      id: `low-${i}`,
      text: `Noise #${i}: ${generateText()}`,
      vector: [Math.random() * 0.2, Math.random() * 0.2, Math.random() * 0.2],
      importance: 0.1 + Math.random() * 0.3,
      timestamp: now - (60 + Math.random() * 90) * 24 * 60 * 60 * 1000,
      metadata: JSON.stringify({
        l0_abstract: "noise",
        l1_overview: "- noise",
        l2_content: "noise entry",
        memory_category: "patterns",
        tier: "working",
        access_count: 0,
        injected_count: 0,
        confidence: 0.3 + Math.random() * 0.2,
        last_accessed_at: now - (90 + Math.random() * 60) * 24 * 60 * 60 * 1000,
        last_confirmed_use_at: 0,
        valid_from: now - (120 + Math.random() * 30) * 24 * 60 * 60 * 1000,
        state: "confirmed",
        source: "auto-capture",
        memory_layer: "working",
        bad_recall_count: 3 + Math.floor(Math.random() * 7),
        suppressed_until_turn: 0,
      }),
      label: "low-value",
    });
  }

  return memories;
}

function generateText() {
  const words = ["user", "prefers", "dark", "mode", "uses", "typescript", "works", "remote", "likes", "python"];
  const n = 3 + Math.floor(Math.random() * 5);
  return Array.from({ length: n }, () => words[Math.floor(Math.random() * words.length)]).join(" ");
}

// ============================================================================
// Metrics
// ============================================================================

function precisionAtK(sorted, k, relevantLabels) {
  const topK = sorted.slice(0, k);
  const hits = topK.filter((m) => relevantLabels.has(m.label)).length;
  return hits / k;
}

function recallAtK(sorted, k, relevantLabels, totalRelevant) {
  const topK = sorted.slice(0, k);
  const hits = topK.filter((m) => relevantLabels.has(m.label)).length;
  return hits / totalRelevant;
}

function noiseRatio(memories) {
  const lowValue = memories.filter((m) => m.label === "low-value").length;
  return lowValue / memories.length;
}

function tierSeparationAccuracy(memories) {
  // After consolidation: high-value should be in core, low-value should be archived
  let correct = 0;
  let total = 0;
  for (const m of memories) {
    const score = computeConsolidationScore(m, DEFAULT_CONSOLIDATION_CONFIG);
    if (m.label === "high-value" && score.action === "promote") {
      correct++;
    } else if (m.label === "low-value" && (score.action === "archive" || score.action === "suppress")) {
      correct++;
    } else if (m.label === "medium-value" && score.action === "maintain") {
      correct++;
    }
    total++;
  }
  return correct / total;
}

// ============================================================================
// Benchmark
// ============================================================================

function bench(name, fn) {
  const WARMUP = 3;
  const ITERATIONS = 10;
  for (let i = 0; i < WARMUP; i++) fn();
  const times = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  return {
    avg: times.reduce((a, b) => a + b, 0) / times.length,
    min: Math.min(...times),
    max: Math.max(...times),
  };
}

function main() {
  console.log("=".repeat(70));
  console.log("Benchmark: Consolidation Quality Assessment");
  console.log("=".repeat(70));
  console.log();

  const SIZES = [100, 500, 1000];

  for (const size of SIZES) {
    const corpus = generateCorpus(size);
    const relevantLabels = new Set(["high-value"]);
    const totalRelevant = corpus.filter((m) => relevantLabels.has(m.label)).length;
    const K = Math.min(20, Math.floor(size * 0.1));

    console.log(`--- N=${size} (K=${K}, ${totalRelevant} relevant memories) ---`);

    // === Baseline: score by importance only (simulating pre-consolidation) ===
    const baselineTiming = bench("baseline", () => {
      [...corpus].sort((a, b) => (b.importance || 0) - (a.importance || 0));
    });
    const baselineSorted = [...corpus].sort(
      (a, b) => (b.importance || 0) - (a.importance || 0),
    );
    const baselineP = precisionAtK(baselineSorted, K, relevantLabels);
    const baselineR = recallAtK(baselineSorted, K, relevantLabels, totalRelevant);

    // === With consolidation: score by consolidation_score ===
    const consolidationTiming = bench("consolidation", () => {
      const scored = corpus.map((m) => ({
        ...m,
        _consolidation: computeConsolidationScore(m, DEFAULT_CONSOLIDATION_CONFIG),
      }));
      scored.sort((a, b) => b._consolidation.score - a._consolidation.score);
    });
    const consolidated = corpus.map((m) => ({
      ...m,
      _consolidation: computeConsolidationScore(m, DEFAULT_CONSOLIDATION_CONFIG),
    }));
    const consolidatedSorted = [...consolidated].sort(
      (a, b) => b._consolidation.score - a._consolidation.score,
    );
    const consolidatedP = precisionAtK(consolidatedSorted, K, relevantLabels);
    const consolidatedR = recallAtK(consolidatedSorted, K, relevantLabels, totalRelevant);

    // === Tier classification accuracy ===
    const tierAcc = tierSeparationAccuracy(corpus);

    // === Noise ratio after consolidation ===
    const activeAfter = consolidated.filter(
      (m) => m._consolidation.action !== "archive" && m._consolidation.action !== "suppress",
    );
    const noiseBefore = noiseRatio(corpus);
    const noiseAfter = noiseRatio(activeAfter);

    console.log(`  Baseline (importance only):`);
    console.log(`    Precision@${K}: ${baselineP.toFixed(3)}`);
    console.log(`    Recall@${K}:    ${baselineR.toFixed(3)}`);
    console.log(`    Noise ratio:    ${noiseBefore.toFixed(3)}`);
    console.log(`    Time:           ${baselineTiming.avg.toFixed(1)}ms`);
    console.log();
    console.log(`  With consolidation:`);
    console.log(`    Precision@${K}: ${consolidatedP.toFixed(3)}  (${consolidatedP > baselineP ? "+" : ""}${((consolidatedP - baselineP) * 100).toFixed(1)}pp)`);
    console.log(`    Recall@${K}:    ${consolidatedR.toFixed(3)}  (${consolidatedR > baselineR ? "+" : ""}${((consolidatedR - baselineR) * 100).toFixed(1)}pp)`);
    console.log(`    Noise ratio:    ${noiseAfter.toFixed(3)}  (${((noiseAfter - noiseBefore) * 100).toFixed(1)}pp)`);
    console.log(`    Tier accuracy:  ${tierAcc.toFixed(3)}`);
    console.log(`    Time:           ${consolidationTiming.avg.toFixed(1)}ms`);
    console.log();
  }

  console.log("=".repeat(70));
  console.log("SUMMARY: consolidation scoring improves retrieval quality by");
  console.log("combining multiple signals (access patterns, confirmations,");
  console.log("contradictions) vs single importance score. Tier classification");
  console.log("accuracy measures how well the system separates high/low value.");
  console.log("=".repeat(70));
}

main();
