/**
 * Metrics Collector Tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MetricsCollector } from "../src/metrics-collector.ts";

describe("MetricsCollector", () => {
  it("returns empty stats when no data recorded", () => {
    const mc = new MetricsCollector();
    const metrics = mc.getMetrics();

    assert.equal(metrics.retrieval.totalQueries, 0);
    assert.equal(metrics.admission.totalEvaluations, 0);
    assert.equal(metrics.storage.totalWrites, 0);
    assert.equal(metrics.embedding.totalCalls, 0);
    assert.equal(metrics.compaction.totalRuns, 0);
  });

  it("records and aggregates admission evaluations", () => {
    const mc = new MetricsCollector();

    mc.recordAdmissionEvaluation({
      decision: "admit",
      score: 0.72,
      latencyMs: 150,
      llmCalled: true,
      llmSucceeded: true,
      featureScores: { utility: 0.8, confidence: 0.6, novelty: 0.7, recency: 0.5, typePrior: 0.9 },
    });
    mc.recordAdmissionEvaluation({
      decision: "reject",
      score: 0.33,
      latencyMs: 95,
      llmCalled: true,
      llmSucceeded: false,
      featureScores: { utility: 0.3, confidence: 0.4, novelty: 0.2, recency: 0.8, typePrior: 0.3 },
    });
    mc.recordAdmissionEvaluation({
      decision: "pass_to_dedup",
      score: 0.55,
      latencyMs: 200,
      llmCalled: false,
      llmSucceeded: false,
      featureScores: { utility: 0.5, confidence: 0.5, novelty: 0.5, recency: 0.5, typePrior: 0.5 },
    });

    const adm = mc.getMetrics().admission;
    assert.equal(adm.totalEvaluations, 3);
    assert.equal(adm.admitted, 1);
    assert.equal(adm.rejected, 1);
    assert.equal(adm.passedToDedup, 1);
    assert.equal(adm.llmCalls, 2);
    assert.equal(adm.llmFailures, 1);
    assert.equal(Math.round(adm.avgLatencyMs), 148); // (150+95+200)/3 = 148.3
  });

  it("records and aggregates storage operations", () => {
    const mc = new MetricsCollector();

    mc.recordStorageOperation({ operation: "write", latencyMs: 45 });
    mc.recordStorageOperation({ operation: "write", latencyMs: 55 });
    mc.recordStorageOperation({ operation: "update", latencyMs: 80, lockContention: true });
    mc.recordStorageOperation({ operation: "delete", latencyMs: 30 });
    mc.recordStorageOperation({ operation: "update", latencyMs: 120, rollback: true });

    const sto = mc.getMetrics().storage;
    assert.equal(sto.totalWrites, 2);
    assert.equal(sto.totalUpdates, 2);
    assert.equal(sto.totalDeletes, 1);
    assert.equal(sto.avgWriteLatencyMs, 50);
    assert.equal(sto.lockContentions, 1);
    assert.equal(sto.updateRollbacks, 1);
  });

  it("records and aggregates embedding calls", () => {
    const mc = new MetricsCollector();

    mc.recordEmbeddingCall({ latencyMs: 50, cacheHit: false, timeout: false, error: false });
    mc.recordEmbeddingCall({ latencyMs: 2, cacheHit: true, timeout: false, error: false });
    mc.recordEmbeddingCall({ latencyMs: 100, cacheHit: false, timeout: true, error: false });
    mc.recordEmbeddingCall({ latencyMs: 30, cacheHit: false, timeout: false, error: true });

    const emb = mc.getMetrics().embedding;
    assert.equal(emb.totalCalls, 4);
    assert.equal(emb.cacheHits, 1);
    assert.equal(emb.cacheMisses, 3);
    assert.equal(emb.cacheHitRate, "25.0%");
    assert.equal(emb.timeouts, 1);
    assert.equal(emb.errors, 1);
    assert.equal(emb.avgLatencyMs, 46); // (50+2+100+30)/4 = 45.5 -> 46
  });

  it("records and aggregates compaction runs", () => {
    const mc = new MetricsCollector();

    mc.recordCompactionRun({
      latencyMs: 5000,
      scanned: 150,
      clusters: 3,
      deleted: 5,
      created: 2,
      dryRun: false,
    });
    mc.recordCompactionRun({
      latencyMs: 3000,
      scanned: 100,
      clusters: 2,
      deleted: 3,
      created: 1,
      dryRun: true,
    });

    const cmp = mc.getMetrics().compaction;
    assert.equal(cmp.totalRuns, 2);
    assert.equal(cmp.totalScanned, 250);
    assert.equal(cmp.totalClusters, 5);
    assert.equal(cmp.totalDeleted, 8);
    assert.equal(cmp.totalCreated, 3);
    assert.equal(cmp.avgLatencyMs, 4000);
    assert.equal(cmp.dryRuns, 1);
  });

  it("ring buffer caps at max size (admission)", () => {
    const mc = new MetricsCollector();

    // Record 600 evaluations (max is 500 for admission)
    for (let i = 0; i < 600; i++) {
      mc.recordAdmissionEvaluation({
        decision: i % 2 === 0 ? "admit" : "reject",
        score: 0.5 + i * 0.001,
        latencyMs: 100 + i,
        llmCalled: true,
        llmSucceeded: true,
        featureScores: {},
      });
    }

    const adm = mc.getMetrics().admission;
    assert.equal(adm.totalEvaluations, 500); // capped
  });

  it("reset clears all statistics", () => {
    const mc = new MetricsCollector();

    mc.recordAdmissionEvaluation({
      decision: "admit", score: 0.7, latencyMs: 100,
      llmCalled: true, llmSucceeded: true, featureScores: {},
    });
    mc.recordStorageOperation({ operation: "write", latencyMs: 50 });
    mc.recordEmbeddingCall({ latencyMs: 30, cacheHit: false, timeout: false, error: false });
    mc.recordCompactionRun({ latencyMs: 1000, scanned: 10, clusters: 1, deleted: 1, created: 1, dryRun: false });

    mc.reset();

    const metrics = mc.getMetrics();
    assert.equal(metrics.admission.totalEvaluations, 0);
    assert.equal(metrics.storage.totalWrites, 0);
    assert.equal(metrics.embedding.totalCalls, 0);
    assert.equal(metrics.compaction.totalRuns, 0);
  });

  it("exportToJson produces valid JSON", () => {
    const mc = new MetricsCollector();
    mc.recordAdmissionEvaluation({
      decision: "admit", score: 0.7, latencyMs: 100,
      llmCalled: true, llmSucceeded: true, featureScores: { utility: 0.8 },
    });

    const json = mc.exportToJson();
    const parsed = JSON.parse(json);

    assert.equal(typeof parsed, "object");
    assert.ok("admission" in parsed);
    assert.ok("storage" in parsed);
    assert.ok("embedding" in parsed);
    assert.ok("compaction" in parsed);
    assert.ok("retrieval" in parsed);
    assert.equal(parsed.admission.totalEvaluations, 1);
  });
});
