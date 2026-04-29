/**
 * Tests for batch admission LLM scoring optimization.
 *
 * Verifies that:
 * 1. scoreBatchUtility() correctly returns N scores in a single LLM call
 * 2. LLM failure falls back to individual scoring
 * 3. batchEvaluate() records metrics correctly
 * 4. SmartExtractor uses batch admission (1 LLM call instead of N)
 * 5. Batch failure falls back to per-candidate evaluation
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { AdmissionController, normalizeAdmissionControlConfig } = jiti("../src/admission-control.ts");
const { MetricsCollector } = jiti("../src/metrics-collector.ts");

// ============================================================================
// Helpers
// ============================================================================

function makeStore() {
  return {
    async vectorSearch(_vector, _limit, _minScore, _scopeFilter) { return []; },
    async store(entry) { return entry; },
    async bulkStore(entries) { return entries; },
    async update(_id, _patch, _scopeFilter) {},
    async getById(_id, _scopeFilter) { return null; },
  };
}

function makeEmbedder() {
  return {
    async embed(_text) { return Array(384).fill(0.1); },
    async embedBatch(texts) { return texts.map(() => Array(384).fill(0.1)); },
  };
}

/**
 * Mock LLM that dynamically detects how many candidates are in a batch prompt.
 * The batch prompt contains numbered entries like "1. Category: ...", so we
 * count those to return the correct number of scores.
 */
function makeLlm(options = {}) {
  const {
    utilityShouldFail = false,
    utilityScores = [0.8, 0.3, 0.6],
    batchMalformed = false,
  } = options;

  const calls = { utility: 0, batchUtility: 0 };

  return {
    calls,
    async completeJson(_prompt, mode) {
      if (mode === "admission-batch-utility") {
        calls.batchUtility++;
        if (utilityShouldFail) throw new Error("mock batch utility failure");
        if (batchMalformed) return { wrong: "shape" };
        // Count candidate entries in the prompt to return the right number
        const candidateCount = (_prompt.match(/^\d+\.\s+Category:/gm) || []).length || utilityScores.length;
        return Array.from({ length: candidateCount }, (_, i) => ({
          index: i + 1,
          utility: utilityScores[i % utilityScores.length],
          reason: `batch score for candidate ${i + 1}`,
        }));
      }
      if (mode === "admission-utility") {
        calls.utility++;
        if (utilityShouldFail) throw new Error("mock utility failure");
        const idx = calls.utility - 1;
        return {
          utility: utilityScores[idx % utilityScores.length],
          reason: `individual score for candidate ${idx + 1}`,
        };
      }
      if (mode === "extract-candidates") {
        return { memories: [] };
      }
      if (mode === "dedup-decision") {
        return { decision: "create", reason: "no match" };
      }
      return null;
    },
  };
}

function makeConfig() {
  return normalizeAdmissionControlConfig({
    enabled: true,
    preset: "balanced",
    utilityMode: "standalone",
    auditMetadata: true,
  });
}

function makeController(llm, config) {
  return new AdmissionController(makeStore(), llm, config || makeConfig(), () => {});
}

function makeCandidate(abstract, category = "preferences") {
  return { category, abstract, overview: "test overview", content: "test content" };
}

function makeVector() {
  return Array(384).fill(0.1);
}

// ============================================================================
// Tests: batchEvaluate on AdmissionController
// ============================================================================

describe("batch admission utility scoring", () => {

  it("returns correct number of scores for N candidates", async () => {
    const llm = makeLlm({ utilityScores: [0.9, 0.2, 0.7, 0.5] });
    const controller = makeController(llm);

    const candidates = [
      makeCandidate("user prefers dark mode"),
      makeCandidate("user lives in Shanghai"),
      makeCandidate("user likes Python"),
      makeCandidate("user has a cat"),
    ];

    const results = await controller.batchEvaluate(
      candidates.map((c) => ({
        candidate: c,
        candidateVector: makeVector(),
        conversationText: "test conversation",
        scopeFilter: ["global"],
      })),
    );

    assert.strictEqual(results.length, 4, "should return 4 results for 4 candidates");
    assert.strictEqual(llm.calls.batchUtility, 1, "should call batch utility exactly once");
    assert.strictEqual(llm.calls.utility, 0, "should NOT call individual utility scoring");
  });

  it("dynamically matches score count to candidate count", async () => {
    // Even though utilityScores has 3 entries, only 2 candidates are sent
    const llm = makeLlm({ utilityScores: [0.8, 0.6, 0.4] });
    const controller = makeController(llm);

    const candidates = [
      makeCandidate("only two candidates here"),
      makeCandidate("second candidate text goes"),
    ];

    const results = await controller.batchEvaluate(
      candidates.map((c) => ({
        candidate: c,
        candidateVector: makeVector(),
        conversationText: "test conversation",
        scopeFilter: ["global"],
      })),
    );

    assert.strictEqual(results.length, 2, "should return 2 results for 2 candidates");
    assert.strictEqual(llm.calls.batchUtility, 1, "batch utility called once");
    assert.strictEqual(llm.calls.utility, 0, "no individual scoring needed");
  });

  it("falls back to individual scoring when batch LLM throws", async () => {
    const llm = makeLlm({ utilityShouldFail: true, utilityScores: [0.8, 0.3] });
    const controller = makeController(llm);

    const candidates = [
      makeCandidate("fallback test candidate one"),
      makeCandidate("fallback test candidate two"),
    ];

    const results = await controller.batchEvaluate(
      candidates.map((c) => ({
        candidate: c,
        candidateVector: makeVector(),
        conversationText: "test conversation",
        scopeFilter: ["global"],
      })),
    );

    assert.strictEqual(results.length, 2, "should return 2 results via fallback");
    assert.ok(llm.calls.utility >= 2, `should call individual scoring at least twice, got ${llm.calls.utility}`);
  });

  it("falls back to individual scoring when batch returns malformed response", async () => {
    const llm = makeLlm({ batchMalformed: true, utilityScores: [0.7, 0.4, 0.9] });
    const controller = makeController(llm);

    const candidates = [
      makeCandidate("malformed response test one"),
      makeCandidate("malformed response test two"),
      makeCandidate("malformed response test three"),
    ];

    const results = await controller.batchEvaluate(
      candidates.map((c) => ({
        candidate: c,
        candidateVector: makeVector(),
        conversationText: "test conversation",
        scopeFilter: ["global"],
      })),
    );

    assert.strictEqual(results.length, 3, "should return 3 results via fallback");
    assert.ok(llm.calls.utility >= 3, `should call individual scoring for all candidates, got ${llm.calls.utility}`);
  });

  it("utilityMode=off returns default scores without LLM calls", async () => {
    const llm = makeLlm();
    const config = makeConfig();
    config.utilityMode = "off";
    const controller = makeController(llm, config);

    const candidates = [
      makeCandidate("utility off candidate one"),
      makeCandidate("utility off candidate two"),
    ];

    const results = await controller.batchEvaluate(
      candidates.map((c) => ({
        candidate: c,
        candidateVector: makeVector(),
        conversationText: "test conversation",
        scopeFilter: ["global"],
      })),
    );

    assert.strictEqual(results.length, 2);
    assert.strictEqual(llm.calls.batchUtility, 0, "should NOT call batch utility when mode=off");
    assert.strictEqual(llm.calls.utility, 0, "should NOT call individual utility when mode=off");
    for (const r of results) {
      assert.strictEqual(r.audit.feature_scores.utility, 0.5);
    }
  });

  it("empty candidate array returns empty array", async () => {
    const llm = makeLlm();
    const controller = makeController(llm);

    const results = await controller.batchEvaluate([]);

    assert.deepStrictEqual(results, []);
    assert.strictEqual(llm.calls.batchUtility, 0, "should not call LLM for empty batch");
  });

  it("records metrics for each candidate in batch", async () => {
    const llm = makeLlm({ utilityScores: [0.8, 0.3, 0.6] });
    const controller = makeController(llm);
    const metrics = new MetricsCollector();
    controller.setMetricsRecorder(metrics);

    const candidates = [
      makeCandidate("metrics candidate one"),
      makeCandidate("metrics candidate two"),
      makeCandidate("metrics candidate three"),
    ];

    await controller.batchEvaluate(
      candidates.map((c) => ({
        candidate: c,
        candidateVector: makeVector(),
        conversationText: "test conversation",
        scopeFilter: ["global"],
      })),
    );

    const m = metrics.getMetrics();
    assert.strictEqual(m.admission.totalEvaluations, 3, "should record 3 admission evaluations");
    assert.strictEqual(m.admission.llmCalls, 3, "should record 3 LLM calls (one per candidate in batch metrics)");
  });
});

// ============================================================================
// Tests: SmartExtractor integration with batch admission
// ============================================================================

describe("SmartExtractor batch admission integration", () => {

  const { SmartExtractor } = jiti("../src/smart-extractor.ts");

  /**
   * LLM mock that parses the batch prompt to determine candidate count,
   * ensuring the returned score array always matches the actual batch size.
   */
  function makeExtractorLlm(options = {}) {
    const { batchShouldFail = false } = options;
    const calls = { batchUtility: 0, utility: 0, extract: 0, dedup: 0 };

    return {
      calls,
      async completeJson(_prompt, mode) {
        if (mode === "extract-candidates") {
          calls.extract++;
          return {
            memories: [
              { category: "preferences", abstract: "用户偏好深色主题界面设置以减少视觉疲劳", overview: "", content: "用户明确表示偏好深色主题" },
              { category: "entities", abstract: "张三是用户的大学同班同学", overview: "", content: "张三在对话中被提及为大学同学" },
              { category: "cases", abstract: "用户最近在学习Rust编程语言内存安全", overview: "", content: "用户对Rust语言所有权系统感兴趣" },
            ],
          };
        }
        if (mode === "admission-batch-utility") {
          calls.batchUtility++;
          if (batchShouldFail) throw new Error("mock batch failure");
          // Dynamically match the number of candidates in the prompt
          const n = (_prompt.match(/^\d+\.\s+Category:/gm) || []).length;
          return Array.from({ length: n || 1 }, (_, i) => ({
            index: i + 1,
            utility: 0.6 + i * 0.1,
            reason: `batch score ${i + 1}`,
          }));
        }
        if (mode === "admission-utility") {
          calls.utility++;
          return { utility: 0.5, reason: "individual fallback score" };
        }
        if (mode === "dedup-decision") {
          calls.dedup++;
          return { decision: "create", reason: "no match" };
        }
        return null;
      },
    };
  }

  function makeExtractorStore() {
    return {
      async vectorSearch() { return []; },
      async store(entry) { return entry; },
      async bulkStore(entries) { return entries; },
      async update() {},
      async getById() { return null; },
    };
  }

  function makeExtractorEmbedder() {
    // Return distinct vectors per text so batchDedup doesn't collapse candidates
    let batchCallId = 0;
    return {
      async embed(_text) { return Array(384).fill(0.1); },
      async embedBatch(texts) {
        batchCallId++;
        return texts.map((t, i) => {
          const vec = Array(384).fill(0);
          const seed = batchCallId * 1000 + i * 17 + t.length;
          for (let j = 0; j < 384; j++) {
            vec[j] = ((seed * (j + 1) * 7) % 1000) / 1000;
          }
          return vec;
        });
      },
    };
  }

  function makeExtractor(llm) {
    return new SmartExtractor(makeExtractorStore(), makeExtractorEmbedder(), llm, {
      user: "User",
      extractMinMessages: 1,
      extractMaxChars: 8000,
      defaultScope: "global",
      log() {},
      debugLog() {},
      admissionControl: {
        ...normalizeAdmissionControlConfig({
          enabled: true,
          preset: "balanced",
          utilityMode: "standalone",
          auditMetadata: true,
        }),
      },
    });
  }

  it("uses batch admission for multiple candidates", async () => {
    const llm = makeExtractorLlm();
    const extractor = makeExtractor(llm);

    const stats = await extractor.extractAndPersist("测试对话内容包含多个候选记忆", "s1");

    assert.ok(stats.created + stats.merged + stats.skipped >= 0, "extraction should complete");
    assert.strictEqual(llm.calls.batchUtility, 1,
      `expected 1 batch utility call, got ${llm.calls.batchUtility}`);
    assert.strictEqual(llm.calls.utility, 0,
      `expected 0 individual utility calls (batch replaced them), got ${llm.calls.utility}`);
  });

  it("falls back to per-candidate evaluation when batch fails", async () => {
    const llm = makeExtractorLlm({ batchShouldFail: true });
    const extractor = makeExtractor(llm);

    const stats = await extractor.extractAndPersist("fallback test conversation", "s1");

    assert.ok(stats.created + stats.merged + stats.skipped >= 0, "extraction should complete");
    assert.strictEqual(llm.calls.batchUtility, 1, "batch utility should have been attempted");
    assert.ok(llm.calls.utility >= 1,
      `expected at least 1 individual utility call as fallback, got ${llm.calls.utility}`);
  });

  it("skips batch admission when admission control is disabled", async () => {
    const store = makeExtractorStore();
    const embedder = makeExtractorEmbedder();

    const llm = {
      calls: { batchUtility: 0, utility: 0, extract: 0 },
      async completeJson(_prompt, mode) {
        if (mode === "extract-candidates") {
          this.calls.extract++;
          return {
            memories: [
              { category: "preferences", abstract: "无配置测试候选记忆", overview: "", content: "无admission control配置" },
            ],
          };
        }
        if (mode === "admission-batch-utility" || mode === "admission-utility") {
          this.calls.batchUtility++;
          this.calls.utility++;
          throw new Error("should not be called when AC disabled");
        }
        if (mode === "dedup-decision") {
          return { decision: "create", reason: "no match" };
        }
        return null;
      },
    };

    const extractor = new SmartExtractor(store, embedder, llm, {
      user: "User",
      extractMinMessages: 1,
      defaultScope: "global",
      log() {},
      debugLog() {},
      // No admissionControl config — disabled by default
    });

    const stats = await extractor.extractAndPersist("no admission config test", "s1");

    assert.ok(stats.created >= 0, "extraction should complete");
    assert.strictEqual(llm.calls.batchUtility, 0, "batch utility should not be called when AC disabled");
    assert.strictEqual(llm.calls.utility, 0, "individual utility should not be called when AC disabled");
  });
});
