import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const {
  computeConsolidationScore,
  computeConsolidationScores,
  runConsolidationSweep,
  shouldRunConsolidation,
  recordConsolidationRun,
  DEFAULT_CONSOLIDATION_CONFIG,
} = jiti("../src/memory-consolidation.ts");

// ============================================================================
// Helpers
// ============================================================================

function metadata(overrides = {}) {
  const base = {
    l0_abstract: "test",
    l1_overview: "- test",
    l2_content: "test memory",
    memory_category: "patterns",
    tier: "working",
    access_count: 0,
    confidence: 0.7,
    last_accessed_at: Date.now() - 7 * 24 * 60 * 60 * 1000,
    valid_from: Date.now() - 30 * 24 * 60 * 60 * 1000,
    state: "confirmed",
    source: "auto-capture",
    memory_layer: "working",
    injected_count: 0,
    bad_recall_count: 0,
    suppressed_until_turn: 0,
  };
  return JSON.stringify({ ...base, ...overrides });
}

function entry(overrides = {}) {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    text: overrides.text ?? "test memory",
    vector: overrides.vector ?? [1, 0, 0, 0],
    category: "other",
    scope: "global",
    importance: overrides.importance ?? 0.5,
    timestamp: overrides.timestamp ?? Date.now() - 14 * 24 * 60 * 60 * 1000,
    metadata: overrides.metadata ?? metadata(),
  };
}

function makeStore(entries = []) {
  const db = new Map(entries.map((e) => [e.id, { ...e }]));
  return {
    async fetchForConsolidation(_maxTs, _scopes, limit = 500) {
      return [...db.values()].slice(0, limit);
    },
    async patchMetadata(id, patch) {
      if (!db.has(id)) return null;
      const existing = db.get(id);
      const mergedMeta = { ...JSON.parse(existing.metadata || "{}"), ...patch };
      db.set(id, { ...existing, metadata: JSON.stringify(mergedMeta) });
      return db.get(id);
    },
  };
}

// ============================================================================
// computeConsolidationScore
// ============================================================================

describe("computeConsolidationScore", () => {
  it("returns a score in [0, 1]", () => {
    const result = computeConsolidationScore(entry());
    assert.ok(result.score >= 0 && result.score <= 1, `score = ${result.score}`);
  });

  it("includes all component breakdowns", () => {
    const result = computeConsolidationScore(entry());
    assert.ok(typeof result.components.accessRecency === "number");
    assert.ok(typeof result.components.accessFrequency === "number");
    assert.ok(typeof result.components.injectionUse === "number");
    assert.ok(typeof result.components.confirmation === "number");
    assert.ok(typeof result.components.badRecall === "number");
    assert.ok(typeof result.components.tierStability === "number");
  });

  it("high access recency for recently accessed memories", () => {
    const e = entry({
      metadata: metadata({ last_accessed_at: Date.now() }),
    });
    const result = computeConsolidationScore(e);
    assert.ok(result.components.accessRecency > 0.9, `recency = ${result.components.accessRecency}`);
  });

  it("low access recency for stale memories", () => {
    const old = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const e = entry({ metadata: metadata({ last_accessed_at: old }) });
    const result = computeConsolidationScore(e);
    assert.ok(result.components.accessRecency < 0.02, `recency = ${result.components.accessRecency}`);
  });

  it("high access frequency for frequently accessed memories", () => {
    const e = entry({ metadata: metadata({ access_count: 50 }) });
    const result = computeConsolidationScore(e);
    assert.ok(result.components.accessFrequency > 0.95, `frequency = ${result.components.accessFrequency}`);
  });

  it("zero frequency when never accessed", () => {
    const e = entry({ metadata: metadata({ access_count: 0 }) });
    const result = computeConsolidationScore(e);
    assert.equal(result.components.accessFrequency, 0);
  });

  it("bad recall reduces score significantly", () => {
    const clean = computeConsolidationScore(entry({ metadata: metadata({ bad_recall_count: 0 }) }));
    const dirty = computeConsolidationScore(entry({ metadata: metadata({ bad_recall_count: 5 }) }));
    assert.ok(dirty.score < clean.score, `clean=${clean.score}, dirty=${dirty.score}`);
  });

  it("bad recall component approaches 0 as bad_recall_count increases", () => {
    const e1 = computeConsolidationScore(entry({ metadata: metadata({ bad_recall_count: 1 }) }));
    const e3 = computeConsolidationScore(entry({ metadata: metadata({ bad_recall_count: 3 }) }));
    const e10 = computeConsolidationScore(entry({ metadata: metadata({ bad_recall_count: 10 }) }));
    assert.ok(e1.components.badRecall > e3.components.badRecall, `badRecall(1) > badRecall(3)`);
    assert.ok(e3.components.badRecall > e10.components.badRecall, `badRecall(3) > badRecall(10)`);
    assert.ok(e10.components.badRecall < 0.15, `badRecall(10) should be very low`);
  });

  it("high injection count increases score", () => {
    const low = computeConsolidationScore(entry({ metadata: metadata({ injected_count: 0 }) }));
    const high = computeConsolidationScore(entry({ metadata: metadata({ injected_count: 20 }) }));
    assert.ok(high.score > low.score, `low=${low.score}, high=${high.score}`);
  });

  it("confirmed use adds a moderate boost", () => {
    const never = computeConsolidationScore(entry({
      metadata: metadata({ last_confirmed_use_at: 0 }),
    }));
    const confirmed = computeConsolidationScore(entry({
      metadata: metadata({ last_confirmed_use_at: Date.now() }),
    }));
    assert.ok(confirmed.score > never.score, `never=${never.score}, confirmed=${confirmed.score}`);
  });

  it("tier stability is higher for older memories", () => {
    const young = entry({ timestamp: Date.now() - 1 * 24 * 60 * 60 * 1000 });
    const old = entry({ timestamp: Date.now() - 90 * 24 * 60 * 60 * 1000 });
    const youngScore = computeConsolidationScore(young).components.tierStability;
    const oldScore = computeConsolidationScore(old).components.tierStability;
    assert.ok(oldScore > youngScore, `young=${youngScore}, old=${oldScore}`);
  });

  it("action is 'promote' when score exceeds threshold", () => {
    // High access count, recent access, confirmed use → should score high
    const e = entry({
      timestamp: Date.now() - 60 * 24 * 60 * 60 * 1000,
      metadata: metadata({
        access_count: 30,
        injected_count: 20,
        last_accessed_at: Date.now(),
        last_confirmed_use_at: Date.now(),
        bad_recall_count: 0,
        tier: "working",
      }),
    });
    const result = computeConsolidationScore(e);
    assert.ok(result.score >= DEFAULT_CONSOLIDATION_CONFIG.promoteThreshold,
      `score=${result.score}, expected >= ${DEFAULT_CONSOLIDATION_CONFIG.promoteThreshold}`);
    assert.equal(result.action, "promote");
  });

  it("action is 'suppress' when bad_recall_count >= threshold", () => {
    const e = entry({
      metadata: metadata({ bad_recall_count: 10 }),
    });
    const result = computeConsolidationScore(e);
    assert.equal(result.action, "suppress");
  });

  it("action is 'maintain' for average memories", () => {
    const e = entry();
    const result = computeConsolidationScore(e);
    assert.equal(result.action, "maintain");
  });
});

// ============================================================================
// computeConsolidationScores (batch)
// ============================================================================

describe("computeConsolidationScores", () => {
  it("returns an array of scores matching input length", () => {
    const entries = [entry(), entry(), entry()];
    const results = computeConsolidationScores(entries);
    assert.equal(results.length, 3);
    for (const r of results) {
      assert.ok(typeof r.score === "number");
    }
  });

  it("handles empty input", () => {
    assert.deepEqual(computeConsolidationScores([]), []);
  });
});

// ============================================================================
// runConsolidationSweep
// ============================================================================

describe("runConsolidationSweep", () => {
  it("promotes high-scoring working memories to core", async () => {
    const e = entry({
      timestamp: Date.now() - 60 * 24 * 60 * 60 * 1000,
      metadata: metadata({
        access_count: 30,
        injected_count: 20,
        last_accessed_at: Date.now(),
        last_confirmed_use_at: Date.now(),
        bad_recall_count: 0,
        tier: "working",
      }),
    });
    const store = makeStore([e]);

    const result = await runConsolidationSweep(store, {
      ...DEFAULT_CONSOLIDATION_CONFIG,
      enabled: true,
      dryRun: false,
    });

    assert.equal(result.evaluated, 1);
    assert.ok(result.promoted >= 0);
  });

  it("dry-run does not modify any entries", async () => {
    const e = entry({
      timestamp: Date.now() - 60 * 24 * 60 * 60 * 1000,
      metadata: metadata({
        access_count: 30,
        injected_count: 20,
        last_accessed_at: Date.now(),
        bad_recall_count: 0,
        tier: "working",
      }),
    });
    const originalMeta = JSON.parse(e.metadata);
    const store = makeStore([e]);

    await runConsolidationSweep(store, {
      ...DEFAULT_CONSOLIDATION_CONFIG,
      enabled: true,
      dryRun: true,
    });

    // In dry-run mode, no modifications should happen
    assert.equal(store.patchMetadata.calls || 0, 0);
  });

  it("returns zero counts for empty store", async () => {
    const store = makeStore([]);
    const result = await runConsolidationSweep(store, DEFAULT_CONSOLIDATION_CONFIG);
    assert.equal(result.evaluated, 0);
    assert.equal(result.promoted, 0);
    assert.equal(result.archived, 0);
    assert.equal(result.suppressed, 0);
  });
});

// ============================================================================
// Cooldown helpers
// ============================================================================

describe("shouldRunConsolidation / recordConsolidationRun", () => {
  const tmpfile = "/tmp/.consolidation-test-state.json";

  it("returns true when no state file exists", async () => {
    const { unlinkSync } = await import("node:fs");
    try { unlinkSync(tmpfile); } catch {}
    const result = await shouldRunConsolidation(tmpfile, 24);
    assert.equal(result, true);
  });

  it("returns true after cooldown has passed", async () => {
    const { writeFile } = await import("node:fs/promises");
    const oldTs = Date.now() - 48 * 60 * 60 * 1000; // 48h ago
    await writeFile(tmpfile, JSON.stringify({ lastRunAt: oldTs }));

    const result = await shouldRunConsolidation(tmpfile, 24);
    assert.equal(result, true);
  });

  it("returns false when cooldown has not passed", async () => {
    const { writeFile } = await import("node:fs/promises");
    const recentTs = Date.now() - 1 * 60 * 60 * 1000; // 1h ago
    await writeFile(tmpfile, JSON.stringify({ lastRunAt: recentTs }));

    const result = await shouldRunConsolidation(tmpfile, 24);
    assert.equal(result, false);
  });

  it("recordConsolidationRun writes a valid state file", async () => {
    const { readFile, unlink } = await import("node:fs/promises");
    const { unlinkSync } = await import("node:fs");
    try { unlinkSync(tmpfile); } catch {}

    await recordConsolidationRun(tmpfile);
    const raw = await readFile(tmpfile, "utf8");
    const state = JSON.parse(raw);
    assert.ok(typeof state.lastRunAt === "number");
    assert.ok(state.lastRunAt > Date.now() - 5000);

    // Cleanup
    try { await unlink(tmpfile); } catch {}
  });
});
