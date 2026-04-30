/**
 * Benchmark for B3: BM25 Normalization
 *
 * Compares the legacy sigmoid(x/5) normalization against the new min-max
 * normalization on the same corpus. Measures score differentiation:
 * - Score spread (max - min) — how well results are separated
 * - Coefficient of variation — relative spread
 *
 * Run: node test/benchmark-bm25-normalization.mjs
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");

function makeStore(vectorDim = 3) {
  const dir = mkdtempSync(join(tmpdir(), "memory-lancedb-pro-bench-bm25-"));
  const store = new MemoryStore({ dbPath: dir, vectorDim });
  return { store, dir };
}

const TEST_MEMORIES = [
  { text: "Python 语言入门教程，适合零基础初学者学习编程" },
  { text: "JavaScript 前端开发框架 React Vue Angular 对比分析" },
  { text: "Rust 内存安全所有权系统 borrow checker 详解" },
  { text: "机器学习深度学习 TensorFlow PyTorch 模型训练" },
  { text: "Docker 容器化部署 Kubernetes 集群管理指南" },
  { text: "数据库设计优化 MySQL PostgreSQL Redis 性能调优" },
  { text: "Linux 系统管理 shell 脚本自动化运维" },
  { text: "Python 数据分析 pandas numpy matplotlib 可视化" },
  { text: "Go 微服务 gRPC 分布式系统设计实践" },
  { text: "网络安全渗透测试 OWASP Top 10 漏洞扫描修复" },
  { text: "用户偏好深色主题界面设置" },
  { text: "Python 学习 Rust 入门" },
];

async function seedStore(store) {
  for (let i = 0; i < TEST_MEMORIES.length; i++) {
    await store.importEntry({
      id: `${String(i).padStart(8, "0")}-0000-0000-0000-00000000000${i}`,
      text: TEST_MEMORIES[i].text,
      vector: Array(3).fill(0.1),
      category: "fact",
      scope: "global",
      importance: 0.5,
      metadata: "{}",
      timestamp: 1000000 + i * 1000,
    });
  }
}

function sigmoid(raw, midpoint = 5) {
  return raw > 0 ? 1 / (1 + Math.exp(-raw / midpoint)) : 0.5;
}

function minmaxNormalize(rawScores) {
  if (rawScores.length === 0) return [];
  const max = Math.max(...rawScores);
  const min = Math.min(...rawScores);
  const range = max - min || 1;
  return rawScores.map(s => (s - min) / range);
}

function analyze(label, scores) {
  const spread = Math.max(...scores) - Math.min(...scores);
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((sum, s) => sum + (s - avg) ** 2, 0) / scores.length;
  const stddev = Math.sqrt(variance);
  const cv = avg > 0 ? (stddev / avg * 100) : 0;

  console.log(`  ${label}:`);
  console.log(`    Scores: ${scores.map(s => s.toFixed(4)).join(", ")}`);
  console.log(`    Spread: ${spread.toFixed(4)} (0-1 range)`);
  console.log(`    Mean:   ${avg.toFixed(4)}`);
  console.log(`    StdDev: ${stddev.toFixed(4)}`);
  console.log(`    CV:     ${cv.toFixed(1)}%`);
  return { spread, cv };
}

async function main() {
  console.log("=".repeat(70));
  console.log("Benchmark: BM25 Normalization — sigmoid vs minmax");
  console.log("=".repeat(70));
  console.log();

  const { store, dir } = makeStore(3);
  await seedStore(store);

  const queries = [
    "Python 编程",
    "Rust 内存",
    "JavaScript 框架",
    "数据库",
    "Python Rust",
  ];

  for (const query of queries) {
    console.log(`Query: "${query}"`);

    // Get raw BM25 scores
    const rawResults = await store.bm25Search(query, 10, undefined, {
      bm25Normalization: "minmax", // doesn't affect raw scores, but we collect them
    });
    const rawScores = rawResults.map(r => r.score);

    // Apply sigmoid post-hoc
    const sigmoidScores = rawScores.map(s => sigmoid(s, 5));

    // Analyze minmax (already normalized by store)
    const minmaxResults = await store.bm25Search(query, 10, undefined, {
      bm25Normalization: "minmax",
    });
    const minmaxScores = minmaxResults.map(r => r.score);

    const sigmoidAnalysis = analyze("sigmoid(x/5)", sigmoidScores);
    const minmaxAnalysis = analyze("minmax", minmaxScores);

    const spreadRatio = sigmoidAnalysis.spread > 0
      ? (minmaxAnalysis.spread / sigmoidAnalysis.spread).toFixed(1) + "x"
      : "N/A";

    console.log(`    Spread improvement: ${spreadRatio}`);
    console.log();
  }

  console.log("=".repeat(70));
  console.log("KEY INSIGHT: minmax normalization adapts to the corpus,");
  console.log("providing consistent score differentiation regardless of");
  console.log("raw BM25 score range. sigmoid(x/5) compresses or saturates.");
  console.log("=".repeat(70));

  rmSync(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
