/**
 * Benchmark: Realistic Consolidation Quality Assessment
 *
 * More realistic simulation where importance (LLM one-time score) and actual
 * usage patterns (recall frequency, confirmations, contradictions) are NOT
 * perfectly correlated. This mirrors real-world conditions where:
 * - Some high-importance memories are rarely useful (overrated by LLM)
 * - Some low-importance memories are frequently needed (underrated by LLM)
 *
 * Metrics:
 * - Precision@K: fraction of top-K that are truly useful (high usage)
 * - Recall@K: fraction of truly useful memories found in top-K
 * - False positive rate: low-usage memories ranked in top-K
 * - False negative rate: high-usage memories missed from top-K
 *
 * Run: node test/benchmark-consolidation-realistic.mjs
 */

import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { computeConsolidationScore, DEFAULT_CONSOLIDATION_CONFIG } =
  jiti("../src/memory-consolidation.ts");

// ============================================================================
// Realistic Corpus Generation
// ============================================================================

function generateRealisticCorpus(size = 500, seed = 42) {
  const now = Date.now();
  let rng = seed;
  const next = () => { rng = (rng * 16807 + 0) % 2147483647; return rng / 2147483647; };

  const memories = [];

  for (let i = 0; i < size; i++) {
    // Generate 4 archetypes with varying importance/usage alignment
    const archetype = Math.floor(next() * 4);

    let importance, accessCount, injectedCount, badRecall, lastAccessDaysAgo, confirmed, confidence;

    switch (archetype) {
      case 0: // True signal: high usage, importance varies (LLM sometimes underrates)
        importance = 0.3 + next() * 0.5; // LLM may underrate
        accessCount = 15 + Math.floor(next() * 30);
        injectedCount = 10 + Math.floor(next() * 20);
        badRecall = 0;
        lastAccessDaysAgo = next() * 3;
        confirmed = true;
        confidence = 0.8 + next() * 0.2;
        break;

      case 1: // Overrated: high importance, low usage (LLM overrates trivial facts)
        importance = 0.8 + next() * 0.2;
        accessCount = Math.floor(next() * 3);
        injectedCount = Math.floor(next() * 2);
        badRecall = Math.floor(next() * 3);
        lastAccessDaysAgo = 20 + next() * 40;
        confirmed = false;
        confidence = 0.6 + next() * 0.3;
        break;

      case 2: // Underrated: low importance, high usage (seems trivial but is actually useful)
        importance = 0.1 + next() * 0.3;
        accessCount = 10 + Math.floor(next() * 25);
        injectedCount = 8 + Math.floor(next() * 15);
        badRecall = Math.floor(next() * 2);
        lastAccessDaysAgo = next() * 7;
        confirmed = next() > 0.3;
        confidence = 0.5 + next() * 0.4;
        break;

      case 3: // True noise: low importance, low usage, high bad recall
        importance = 0.1 + next() * 0.3;
        accessCount = Math.floor(next() * 2);
        injectedCount = 0;
        badRecall = 3 + Math.floor(next() * 7);
        lastAccessDaysAgo = 30 + next() * 60;
        confirmed = false;
        confidence = 0.2 + next() * 0.3;
        break;
    }

    const isTrulyUseful = archetype === 0 || archetype === 2;

    memories.push({
      id: `m-${i.toString().padStart(5, "0")}`,
      text: `memory-${i}`,
      vector: Array.from({ length: 4 }, () => next() * 2 - 1),
      importance,
      timestamp: now - (30 + next() * 60) * 24 * 60 * 60 * 1000,
      metadata: JSON.stringify({
        l0_abstract: "test",
        l1_overview: "- test",
        l2_content: "test memory",
        memory_category: "patterns",
        tier: "working",
        access_count: accessCount,
        injected_count: injectedCount,
        confidence,
        last_accessed_at: now - lastAccessDaysAgo * 24 * 60 * 60 * 1000,
        last_confirmed_use_at: confirmed ? now - (next() * 5) * 24 * 60 * 60 * 1000 : 0,
        valid_from: now - (60 + next() * 30) * 24 * 60 * 60 * 1000,
        state: "confirmed",
        source: "auto-capture",
        memory_layer: "working",
        bad_recall_count: badRecall,
        suppressed_until_turn: 0,
      }),
      _trulyUseful: isTrulyUseful,
      _archetype: archetype,
    });
  }

  return memories;
}

// ============================================================================
// Metrics
// ============================================================================

function precisionAtK(sorted, k) {
  const hits = sorted.slice(0, k).filter((m) => m._trulyUseful).length;
  return hits / k;
}

function recallAtK(sorted, k, totalUseful) {
  const hits = sorted.slice(0, k).filter((m) => m._trulyUseful).length;
  return hits / totalUseful;
}

function falsePositiveRate(sorted, k) {
  const topK = sorted.slice(0, k);
  const notUseful = topK.filter((m) => !m._trulyUseful).length;
  return notUseful / k;
}

function falseNegativeRate(sorted, k, totalUseful) {
  const foundInTopK = sorted.slice(0, k).filter((m) => m._trulyUseful).length;
  return (totalUseful - foundInTopK) / totalUseful;
}

// ============================================================================
// Benchmark
// ============================================================================

function bench(name, fn, iterations = 10) {
  for (let i = 0; i < 3; i++) fn();
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  return times.reduce((a, b) => a + b, 0) / times.length;
}

function main() {
  console.log("=".repeat(70));
  console.log("Benchmark: Realistic Consolidation Quality Assessment");
  console.log("=".repeat(70));
  console.log();
  console.log("Corpus: 4 archetypes (true signal, overrated, underrated, noise)");
  console.log("Importance ≠ usage: LLM one-time score doesn't match actual value");
  console.log();

  const SIZES = [100, 500, 1000, 2000];
  const K_VALUES = [10, 20, 50];

  for (const size of SIZES) {
    const corpus = generateRealisticCorpus(size);
    const totalUseful = corpus.filter((m) => m._trulyUseful).length;
    const trueNoiseRatio = corpus.filter((m) => !m._trulyUseful).length / size;

    console.log(`--- N=${size}, ${totalUseful} truly useful (${(totalUseful / size * 100).toFixed(0)}%), noise=${(trueNoiseRatio * 100).toFixed(0)}% ---`);
    console.log();

    for (const K of K_VALUES) {
      if (K > size) continue;

      // Baseline: sort by importance only
      const baseline = [...corpus].sort((a, b) => b.importance - a.importance);
      const bP = precisionAtK(baseline, K);
      const bR = recallAtK(baseline, K, totalUseful);
      const bFPR = falsePositiveRate(baseline, K);
      const bFNR = falseNegativeRate(baseline, K, totalUseful);

      // With consolidation
      const scored = corpus.map((m) => ({
        ...m,
        _score: computeConsolidationScore(m, DEFAULT_CONSOLIDATION_CONFIG).score,
      }));
      const consolidated = [...scored].sort((a, b) => b._score - a._score);
      const cP = precisionAtK(consolidated, K);
      const cR = recallAtK(consolidated, K, totalUseful);
      const cFPR = falsePositiveRate(consolidated, K);
      const cFNR = falseNegativeRate(consolidated, K, totalUseful);

      const pDelta = ((cP - bP) * 100).toFixed(1);
      const rDelta = ((cR - bR) * 100).toFixed(1);

      console.log(`  K=${K.toString().padStart(3)}: baseline P=${bP.toFixed(3)} R=${bR.toFixed(3)} FPR=${bFPR.toFixed(3)}  vs  consolidated P=${cP.toFixed(3)} R=${cR.toFixed(3)} FPR=${cFPR.toFixed(3)}  (ΔP=${pDelta > 0 ? "+" : ""}${pDelta}pp, ΔR=${rDelta > 0 ? "+" : ""}${rDelta}pp)`);
    }

    // Tier classification accuracy
    let correct = 0;
    for (const m of corpus) {
      const score = computeConsolidationScore(m, DEFAULT_CONSOLIDATION_CONFIG);
      if (m._trulyUseful && (score.action === "promote" || score.action === "maintain")) correct++;
      else if (!m._trulyUseful && (score.action === "archive" || score.action === "suppress")) correct++;
    }
    const tierAcc = correct / corpus.length;

    // Noise reduction
    const activeAfter = corpus.filter((m) => {
      const s = computeConsolidationScore(m, DEFAULT_CONSOLIDATION_CONFIG);
      return s.action !== "archive" && s.action !== "suppress";
    });
    const noiseAfter = activeAfter.filter((m) => !m._trulyUseful).length / activeAfter.length;

    // Performance timing
    const tBaseline = bench("baseline", () => {
      [...corpus].sort((a, b) => b.importance - a.importance);
    });
    const tConsolidation = bench("consolidation", () => {
      corpus.map((m) => computeConsolidationScore(m, DEFAULT_CONSOLIDATION_CONFIG));
    });

    console.log();
    console.log(`  Tier accuracy:     ${tierAcc.toFixed(3)}`);
    console.log(`  Noise ratio:       ${trueNoiseRatio.toFixed(3)} → ${noiseAfter.toFixed(3)}  (${((noiseAfter - trueNoiseRatio) * 100).toFixed(1)}pp)`);
    console.log(`  Scoring time:      baseline=${tBaseline.toFixed(2)}ms  consolidation=${tConsolidation.toFixed(2)}ms  (${(tConsolidation / tBaseline).toFixed(1)}x)`);
    console.log();
  }

  console.log("=".repeat(70));
  console.log("SUMMARY: consolidation improves retrieval quality when importance");
  console.log("(LLM one-time score) doesn't correlate with actual usage patterns.");
  console.log("Precision@K and false positive rate are the key metrics.");
  console.log("=".repeat(70));
}

main();
