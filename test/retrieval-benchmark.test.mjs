/**
 * Retrieval Quality Benchmark — Ground Truth Test Set
 *
 * Seeds a deterministic LanceDB database with realistic memories,
 * runs a suite of test queries, and measures retrieval quality
 * against known ground truth. Produces a baseline report that
 * future optimizations can compare against.
 *
 * Metrics:
 *   - Precision@K: fraction of top-K results that are relevant
 *   - Recall@K: fraction of relevant items found in top-K
 *   - MRR (Mean Reciprocal Rank): 1/rank of first relevant result
 *   - NDCG@K: Normalized Discounted Cumulative Gain at K
 *
 * Usage: node test/retrieval-benchmark.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, before } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");
const { createRetriever, DEFAULT_RETRIEVAL_CONFIG } = jiti("../src/retriever.ts");

// ============================================================================
// Deterministic Embedder — TF-IDF on keyword-topic features
// ============================================================================

/**
 * Each feature maps to a specific topic keyword regex.
 * We compute TF (term frequency) per feature, then apply IDF
 * weighting across the corpus to make features discriminative.
 */
const TOPIC_FEATURES = [
  { name: "tea",         re: /(乌龙|抹茶|绿茶|红茶|茶)/gi, idf: 2.0 },
  { name: "coffee",      re: /(咖啡|拿铁|美式|coffee)/gi, idf: 2.0 },
  { name: "milk_alt",    re: /(乳糖|燕麦奶|豆奶|牛奶|oat|soy|milk)/gi, idf: 1.8 },
  { name: "typescript",  re: /\b(typescript|ts)\b/gi, idf: 2.2 },
  { name: "python",      re: /\b(python|pytorch|fastapi)\b/gi, idf: 2.0 },
  { name: "ai_ml",       re: /(AI|机器学习|模型|embedding|reranker|claude)/gi, idf: 1.5 },
  { name: "meeting",     re: /(会议|meeting|站会|standup|周会)/gi, idf: 1.8 },
  { name: "schedule",    re: /(日程|schedule|安排|计划)/gi, idf: 1.6 },
  { name: "git_ops",     re: /\b(git|commit|rebase|merge|push)\b/gi, idf: 1.8 },
  { name: "git_branch",  re: /\b(branch|feature\/|bugfix\/|hotfix\/)\b/gi, idf: 2.0 },
  { name: "pr_review",   re: /(PR|pull.request|review|pull request)/gi, idf: 1.8 },
  { name: "api_rest",    re: /\b(API|REST|GraphQL|endpoint)\b/gi, idf: 1.8 },
  { name: "api_design",  re: /(设计规范|规范|语义化|版本|document)/gi, idf: 1.5 },
  { name: "beijing",     re: /(北京|Beijing|朝阳|望京)/gi, idf: 2.5 },
  { name: "shanghai",    re: /(上海|Shanghai|浦东|张江)/gi, idf: 2.5 },
  { name: "office",      re: /(办公室|office|工位|座位|desk)/gi, idf: 1.5 },
  { name: "vegan",       re: /\b(vegan|素食|有机)\b/gi, idf: 2.2 },
  { name: "allergy",     re: /(过敏|allergy|不耐受)/gi, idf: 1.8 },
  { name: "lancedb",     re: /\b(LanceDB|lancedb)\b/gi, idf: 2.5 },
  { name: "postgres",    re: /\b(Postgres|postgres|MySQL|mysql)\b/gi, idf: 2.0 },
  { name: "redis",       re: /\b(Redis|redis)\b/gi, idf: 2.2 },
  { name: "database",    re: /(数据库|database|迁移|migration)/gi, idf: 1.3 },
  { name: "ui_svg",      re: /\b(SVG|svg|图标)\b/gi, idf: 2.0 },
  { name: "ui_css",      re: /\b(CSS|css|tailwind|Tailwind|Figma|figma)\b/gi, idf: 2.0 },
  { name: "design",      re: /(设计|design|前端|frontend|界面)/gi, idf: 1.3 },
  { name: "plugin",      re: /(插件|plugin|SDK|sdk)/gi, idf: 2.0 },
  { name: "testing",     re: /(Vitest|vitest|测试|单元|覆盖率)/gi, idf: 2.2 },
  { name: "jira",        re: /\b(Jira|jira)\b/gi, idf: 2.5 },
  { name: "coding",      re: /(编程|代码|TypeScript|代码 review|review)/gi, idf: 1.3 },
  { name: "preference",  re: /(偏好|喜欢|不喜欢|dislike|hate|avoid|不喝|不吃)/gi, idf: 1.2 },
  { name: "decision",    re: /(规范|要求|必须|统一|should|must|policy)/gi, idf: 1.1 },
  { name: "diet_general",re: /(饮食|饮食偏好|健康|health|diet|食品|有机)/gi, idf: 1.4 },
];

function makeDeterministicEmbedder(dim = TOPIC_FEATURES.length) {
  const toVector = (text) => {
    const s = String(text || "");
    const vec = [];
    for (const feat of TOPIC_FEATURES.slice(0, dim)) {
      const matches = s.match(feat.re);
      // TF: count of matches, normalized by text length
      const tf = matches ? matches.length / Math.max(1, s.length / 50) : 0;
      // TF-IDF: term frequency * inverse document frequency
      vec.push(tf * feat.idf);
    }
    while (vec.length < dim) vec.push(0);
    return vec;
  };

  return {
    async embedQuery(text) { return toVector(text); },
    async embedPassage(text) { return toVector(text); },
    async embedBatchPassage(texts) { return texts.map(toVector); },
    async test() { return { success: true, dimensions: dim }; },
  };
}

// ============================================================================
// Seed Data — Realistic Memories
// ============================================================================

/**
 * Each seed has: id, text, category, importance, and a fixed timestamp offset.
 * Ground truth is defined by which IDs are relevant to which queries.
 */
function createSeedMemories() {
  const now = Date.now();
  return [
    {
      id: "mem-0001-tea-pref",
      text: "用户偏好是乌龙茶，喜欢喝绿茶，也喜欢红茶。下午茶时间通常在3点。",
      category: "preference",
      importance: 0.9,
      timestamp: now - 86400000 * 30, // 30 days ago
    },
    {
      id: "mem-0002-coffee-dislike",
      text: "用户不喜欢冰美式咖啡，对拿铁也不感兴趣。乳糖不耐受。",
      category: "preference",
      importance: 0.85,
      timestamp: now - 86400000 * 25,
    },
    {
      id: "mem-0003-ts-plugin",
      text: "当前项目统一使用 TypeScript 编写插件逻辑，所有新插件必须遵循插件SDK规范。",
      category: "decision",
      importance: 0.95,
      timestamp: now - 86400000 * 20,
    },
    {
      id: "mem-0004-python-ml",
      text: "Python 用于机器学习模型训练，团队主要用 PyTorch 框架。",
      category: "fact",
      importance: 0.7,
      timestamp: now - 86400000 * 45,
    },
    {
      id: "mem-0005-meeting-monday",
      text: "每周一上午10点有团队站会(standup)，讨论上周进展和本周计划。",
      category: "fact",
      importance: 0.8,
      timestamp: now - 86400000 * 15,
    },
    {
      id: "mem-0006-git-rebase",
      text: "Git 工作流要求 rebase 后再 merge，不要直接 push 到 main 分支。PR 需要至少一个 review。",
      category: "decision",
      importance: 0.9,
      timestamp: now - 86400000 * 10,
    },
    {
      id: "mem-0007-api-design",
      text: "API 设计规范：RESTful 风格，使用语义化版本号，所有 endpoint 必须有文档。",
      category: "decision",
      importance: 0.85,
      timestamp: now - 86400000 * 12,
    },
    {
      id: "mem-0008-beijing-office",
      text: "北京办公室在朝阳区望京SOHO，工位分布在B座12层。",
      category: "entity",
      importance: 0.6,
      timestamp: now - 86400000 * 60,
    },
    {
      id: "mem-0009-health-vegan",
      text: "用户是素食主义者(vegan)，对坚果过敏。健康饮食偏好有机食品。",
      category: "preference",
      importance: 0.95,
      timestamp: now - 86400000 * 5,
    },
    {
      id: "mem-0010-lancedb-infra",
      text: "基础设施使用 LanceDB 作为向量数据库，Postgres 存储结构化数据，Redis 做缓存。",
      category: "entity",
      importance: 0.8,
      timestamp: now - 86400000 * 8,
    },
    {
      id: "mem-0011-ui-frontend",
      text: "前端界面设计要求支持 SVG 图标，CSS 使用 Tailwind 框架，统一设计规范在 Figma 中。",
      category: "decision",
      importance: 0.75,
      timestamp: now - 86400000 * 18,
    },
    {
      id: "mem-0012-schedule-review",
      text: "每周五下午进行代码 review 和技术分享，日程安排由团队 lead 负责。",
      category: "fact",
      importance: 0.7,
      timestamp: now - 86400000 * 22,
    },
    {
      id: "mem-0013-python-api",
      text: "Python 后端 API 使用 FastAPI 框架，所有接口需要参数校验和错误处理。",
      category: "fact",
      importance: 0.75,
      timestamp: now - 86400000 * 35,
    },
    {
      id: "mem-0014-office-shanghai",
      text: "上海办公室在浦东新区张江高科，有专门的 AI 实验室和测试设备。",
      category: "entity",
      importance: 0.6,
      timestamp: now - 86400000 * 50,
    },
    {
      id: "mem-0015-db-migration",
      text: "数据库迁移方案：从 MySQL 迁移到 Postgres 需要处理方言差异，注意自增主键和 JSON 字段兼容性。",
      category: "decision",
      importance: 0.85,
      timestamp: now - 86400000 * 40,
    },
    {
      id: "mem-0016-meeting-notes",
      text: "会议记录模板：包含议题、决策、待办事项和负责人。每周站会需要更新 Jira 状态。",
      category: "fact",
      importance: 0.65,
      timestamp: now - 86400000 * 28,
    },
    {
      id: "mem-0017-ts-testing",
      text: "TypeScript 单元测试使用 Vitest 框架，要求覆盖率达到 80% 以上，集成测试使用真实 LanceDB 后端。",
      category: "decision",
      importance: 0.8,
      timestamp: now - 86400000 * 14,
    },
    {
      id: "mem-0018-diet-lactose",
      text: "用户乳糖不耐受，不能喝含乳糖的牛奶，可以选择燕麦奶或豆奶替代。",
      category: "preference",
      importance: 0.8,
      timestamp: now - 86400000 * 7,
    },
    {
      id: "mem-0019-git-branch",
      text: "分支命名规范：feature/功能名、bugfix/问题描述、hotfix/紧急修复。主分支保护不允许 force push。",
      category: "decision",
      importance: 0.75,
      timestamp: now - 86400000 * 33,
    },
    {
      id: "mem-0020-ai-model",
      text: "AI 模型选型：文本生成使用 Claude，向量化用 text-embedding-3-small，reranking 用 Jina Reranker。",
      category: "entity",
      importance: 0.8,
      timestamp: now - 86400000 * 3,
    },
  ];
}

// ============================================================================
// Ground Truth — Query → Relevant Memory IDs
// ============================================================================

/**
 * Each query case defines:
 *   - query: the search query string
 *   - relevantIds: memory IDs that SHOULD appear in results
 *   - idealFirst: the ID expected to rank #1 (optional, for MRR)
 */
const QUERY_CASES = [
  {
    name: "tea preference",
    query: "用户喜欢喝什么茶",
    relevantIds: ["mem-0001-tea-pref"],
    idealFirst: "mem-0001-tea-pref",
  },
  {
    name: "coffee dislike",
    query: "用户不喜欢什么咖啡",
    relevantIds: ["mem-0002-coffee-dislike"],
    idealFirst: "mem-0002-coffee-dislike",
  },
  {
    name: "TypeScript plugin",
    query: "项目用什么语言写插件",
    relevantIds: ["mem-0003-ts-plugin"],
    idealFirst: "mem-0003-ts-plugin",
  },
  {
    name: "Python ML",
    query: "Python 机器学习框架",
    relevantIds: ["mem-0004-python-ml"],
    idealFirst: "mem-0004-python-ml",
  },
  {
    name: "meeting schedule",
    query: "每周会议安排",
    relevantIds: ["mem-0005-meeting-monday", "mem-0012-schedule-review", "mem-0016-meeting-notes"],
    idealFirst: "mem-0005-meeting-monday",
  },
  {
    name: "git workflow",
    query: "git rebase merge 规范",
    relevantIds: ["mem-0006-git-rebase", "mem-0019-git-branch"],
    idealFirst: "mem-0006-git-rebase",
  },
  {
    name: "API design",
    query: "API 接口设计规范",
    relevantIds: ["mem-0007-api-design", "mem-0013-python-api"],
    idealFirst: "mem-0007-api-design",
  },
  {
    name: "office location",
    query: "北京办公室在哪",
    relevantIds: ["mem-0008-beijing-office"],
    idealFirst: "mem-0008-beijing-office",
  },
  {
    name: "diet health",
    query: "用户的饮食偏好和健康要求",
    relevantIds: ["mem-0009-health-vegan", "mem-0018-diet-lactose", "mem-0002-coffee-dislike"],
    idealFirst: "mem-0009-health-vegan",
  },
  {
    name: "database infrastructure",
    query: "用什么数据库",
    relevantIds: ["mem-0010-lancedb-infra", "mem-0015-db-migration"],
    idealFirst: "mem-0010-lancedb-infra",
  },
  {
    name: "UI design",
    query: "前端 UI 设计要求",
    relevantIds: ["mem-0011-ui-frontend"],
    idealFirst: "mem-0011-ui-frontend",
  },
  {
    name: "testing framework",
    query: "TypeScript 测试框架和覆盖率",
    relevantIds: ["mem-0017-ts-testing", "mem-0003-ts-plugin"],
    idealFirst: "mem-0017-ts-testing",
  },
  {
    name: "AI model selection",
    query: "AI 模型选型 embedding reranker",
    relevantIds: ["mem-0020-ai-model"],
    idealFirst: "mem-0020-ai-model",
  },
  {
    name: "cross-category: health+diet",
    query: "用户乳糖不耐 饮食限制",
    relevantIds: ["mem-0018-diet-lactose", "mem-0009-health-vegan", "mem-0002-coffee-dislike"],
    idealFirst: "mem-0018-diet-lactose",
  },
  {
    name: "cross-category: git+PR",
    query: "branch PR review 规范",
    relevantIds: ["mem-0006-git-rebase", "mem-0019-git-branch"],
    idealFirst: "mem-0006-git-rebase",
  },
];

// ============================================================================
// Metrics Computation
// ============================================================================

function precisionAtK(results, relevantIds, k) {
  const topK = results.slice(0, k);
  const hits = topK.filter((r) => relevantIds.includes(r.entry.id)).length;
  return hits / k;
}

function recallAtK(results, relevantIds, k) {
  const topK = results.slice(0, k);
  const hits = topK.filter((r) => relevantIds.includes(r.entry.id)).length;
  return relevantIds.length === 0 ? 1 : hits / relevantIds.length;
}

function reciprocalRank(results, relevantIds) {
  for (let i = 0; i < results.length; i++) {
    if (relevantIds.includes(results[i].entry.id)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

function ndcgAtK(results, relevantIds, k) {
  const topK = results.slice(0, k);
  // DCG: sum(rel_i / log2(i+1))
  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    const rel = relevantIds.includes(topK[i].entry.id) ? 1 : 0;
    dcg += rel / Math.log2(i + 2); // i+2 because log2(1) = 0
  }
  // Ideal DCG: all relevant items at top
  const idealRels = Array(Math.min(relevantIds.length, k)).fill(1);
  let idcg = 0;
  for (let i = 0; i < idealRels.length; i++) {
    idcg += idealRels[i] / Math.log2(i + 2);
  }
  return idcg === 0 ? 1 : dcg / idcg;
}

// ============================================================================
// Benchmark Runner
// ============================================================================

const K = 5;

async function runBenchmark({ verbose = true } = {}) {
  const workDir = mkdtempSync(path.join(tmpdir(), "retrieval-benchmark-"));
  const embedder = makeDeterministicEmbedder(32);
  const store = new MemoryStore({
    dbPath: path.join(workDir, "db"),
    vectorDim: 32,
  });

  // Config: disable rerank (no external API), disable scoring modifiers
  // so the benchmark isolates vector + BM25 quality.
  // minScore=0 ensures the retriever always returns up to `limit` results,
  // so P@5 measures precision under realistic "fill the slot" behavior.
  const retriever = createRetriever(store, embedder, {
    ...DEFAULT_RETRIEVAL_CONFIG,
    rerank: "none",
    minScore: 0,
    hardMinScore: 0,
    recencyWeight: 0,
    recencyHalfLifeDays: 0,
    timeDecayHalfLifeDays: 0,
    filterNoise: false,
    candidatePoolSize: 20,
  });

  try {
    // Seed memories
    const seeds = createSeedMemories();
    const storedEntries = [];
    for (const seed of seeds) {
      const vector = await embedder.embedPassage(seed.text);
      const entry = await store.importEntry({
        id: seed.id,
        text: seed.text,
        vector,
        category: seed.category,
        scope: "global",
        importance: seed.importance,
        timestamp: seed.timestamp,
        metadata: "{}",
      });
      storedEntries.push(entry);
    }

    if (verbose) {
      console.log(`Seeded ${storedEntries.length} memories into benchmark database\n`);
    }

    // Run queries
    const caseResults = [];
    for (const testCase of QUERY_CASES) {
      const results = await retriever.retrieve({
        query: testCase.query,
        limit: K,
      });

      const p5 = precisionAtK(results, testCase.relevantIds, K);
      const r5 = recallAtK(results, testCase.relevantIds, K);
      const rr = reciprocalRank(results, testCase.relevantIds);
      const ndcg5 = ndcgAtK(results, testCase.relevantIds, K);

      const resultIds = results.map((r) => r.entry.id);
      const missing = testCase.relevantIds.filter(
        (id) => !resultIds.includes(id),
      );
      const unexpected = resultIds.filter(
        (id) => !testCase.relevantIds.includes(id),
      );
      const firstIsIdeal = testCase.idealFirst
        ? results[0]?.entry.id === testCase.idealFirst
        : null;

      caseResults.push({
        name: testCase.name,
        query: testCase.query,
        relevantIds: testCase.relevantIds,
        resultIds,
        missing,
        unexpected,
        firstIsIdeal,
        precisionAtK: p5,
        recallAtK: r5,
        reciprocalRank: rr,
        ndcgAtK: ndcg5,
      });

      if (verbose) {
        const status = p5 === 1 ? "PASS" : p5 >= 0.6 ? "OK" : "FAIL";
        console.log(
          `[${status}] ${testCase.name}  P@${K}=${p5.toFixed(2)}  R@${K}=${r5.toFixed(2)}  RR=${rr.toFixed(2)}  NDCG@${K}=${ndcg5.toFixed(2)}`,
        );
        if (missing.length > 0) {
          console.log(`       missing: ${missing.join(", ")}`);
        }
        if (unexpected.length > 0) {
          console.log(`       unexpected: ${unexpected.join(", ")}`);
        }
        if (firstIsIdeal === false) {
          console.log(
            `       expected #1: ${testCase.idealFirst}, got: ${results[0]?.entry.id ?? "(none)"}`,
          );
        }
      }
    }

    // Aggregate metrics
    const avgP5 = caseResults.reduce((s, c) => s + c.precisionAtK, 0) / caseResults.length;
    const avgR5 = caseResults.reduce((s, c) => s + c.recallAtK, 0) / caseResults.length;
    const avgRR = caseResults.reduce((s, c) => s + c.reciprocalRank, 0) / caseResults.length;
    const avgNDCG5 = caseResults.reduce((s, c) => s + c.ndcgAtK, 0) / caseResults.length;
    const idealFirstPct = caseResults.filter((c) => c.firstIsIdeal === true).length / caseResults.length;
    const passPct = caseResults.filter((c) => c.precisionAtK === 1).length / caseResults.length;

    const report = {
      benchmarkVersion: "1.0",
      timestamp: new Date().toISOString(),
      seedCount: storedEntries.length,
      queryCount: QUERY_CASES.length,
      k: K,
      aggregate: {
        avgPrecisionAtK: round3(avgP5),
        avgRecallAtK: round3(avgR5),
        avgMRR: round3(avgRR),
        avgNDCGAtK: round3(avgNDCG5),
        idealFirstPct: round3(idealFirstPct),
        passPct: round3(passPct),
      },
      cases: caseResults.map((c) => ({
        name: c.name,
        precisionAtK: round3(c.precisionAtK),
        recallAtK: round3(c.recallAtK),
        reciprocalRank: round3(c.reciprocalRank),
        ndcgAtK: round3(c.ndcgAtK),
        firstIsIdeal: c.firstIsIdeal,
        missing: c.missing,
        unexpected: c.unexpected,
      })),
    };

    if (verbose) {
      console.log("\n=== Aggregate Metrics ===");
      console.log(`  Avg P@${K}:       ${report.aggregate.avgPrecisionAtK}`);
      console.log(`  Avg R@${K}:       ${report.aggregate.avgRecallAtK}`);
      console.log(`  Avg MRR:         ${report.aggregate.avgMRR}`);
      console.log(`  Avg NDCG@${K}:    ${report.aggregate.avgNDCGAtK}`);
      console.log(`  Ideal First:     ${report.aggregate.idealFirstPct}`);
      console.log(`  Pass Rate:       ${report.aggregate.passPct}`);
    }

    return report;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

// ============================================================================
// Test Runner
// ============================================================================

describe("Retrieval Quality Benchmark", () => {
  let report;

  before(async () => {
    report = await runBenchmark({ verbose: false });
  });

  it("baseline: P@5 is stable (keyword embedder, no rerank)", () => {
    // With the deterministic keyword embedder and no reranking, P@5 reflects
    // how well topic-keyword vectors differentiate relevant from irrelevant
    // memories. This is the BASELINE — improvements (real embeddings, rerank,
    // better fusion) should raise this number.
    assert.ok(
      report.aggregate.avgPrecisionAtK >= 0.3,
      `avg P@5 = ${report.aggregate.avgPrecisionAtK}, baseline >= 0.3`,
    );
  });

  it("baseline: R@5 finds most relevant items", () => {
    assert.ok(
      report.aggregate.avgRecallAtK >= 0.8,
      `avg R@5 = ${report.aggregate.avgRecallAtK}, expected >= 0.8`,
    );
  });

  it("baseline: MRR — relevant item ranks first for most queries", () => {
    assert.ok(
      report.aggregate.avgMRR >= 0.9,
      `avg MRR = ${report.aggregate.avgMRR}, expected >= 0.9`,
    );
  });

  it("baseline: NDCG@5 captures ranking quality", () => {
    assert.ok(
      report.aggregate.avgNDCGAtK >= 0.8,
      `avg NDCG@5 = ${report.aggregate.avgNDCGAtK}, expected >= 0.8`,
    );
  });

  it("single-result queries: no relevant items missing from top-5", () => {
    const singleCases = report.cases.filter(
      (c) => c.relevantIds?.length === 1,
    );
    for (const c of singleCases) {
      assert.equal(
        c.missing.length,
        0,
        `case "${c.name}": missing relevant items: ${c.missing.join(", ")}`,
      );
    }
  });
});

// ============================================================================
// Baseline Export (run directly)
// ============================================================================

if (process.argv.some((a) => a === "--export-baseline")) {
  const report = await runBenchmark({ verbose: true });
  const baselinePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "retrieval-baseline.json",
  );
  writeFileSync(baselinePath, JSON.stringify(report, null, 2));
  console.log(`\nBaseline report saved to: ${baselinePath}`);
}
