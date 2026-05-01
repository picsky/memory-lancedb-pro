<div align="center">

# 🧠 memory-lancedb-pro · 🦞OpenClaw Plugin

**AI Memory Assistant for [OpenClaw](https://github.com/openclaw/openclaw) Agents**

*Give your AI agent a brain that actually remembers — across sessions, across agents, across time.*

A LanceDB-backed OpenClaw memory plugin that stores preferences, decisions, and project context, then auto-recalls them in future sessions.

[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue)](https://github.com/openclaw/openclaw)
[![OpenClaw 2026.3+](https://img.shields.io/badge/OpenClaw-2026.3%2B-brightgreen)](https://github.com/openclaw/openclaw)
[![npm version](https://img.shields.io/npm/v/memory-lancedb-pro)](https://www.npmjs.com/package/memory-lancedb-pro)
[![LanceDB](https://img.shields.io/badge/LanceDB-Vectorstore-orange)](https://lancedb.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
<h2>⚡ <a href="https://github.com/CortexReach/memory-lancedb-pro/releases/tag/v1.1.1">v1.1.1 — Enhanced Memory with Consolidation, Compaction, Admission Control & Adaptive Recall</a></h2>

<p>
 ✅ Fully adapted for OpenClaw 2026.3+ new plugin architecture<br>
 🔄 Uses <code>before_prompt_build</code> hooks (replacing deprecated <code>before_agent_start</code>)<br>
 🩺 Run <code>openclaw doctor --fix</code> after upgrading
</p>


[English](README.md) | [简体中文](README_CN.md)

</div>

---

## Why memory-lancedb-pro?

Most AI agents have amnesia. They forget everything the moment you start a new chat.

**memory-lancedb-pro** is a production-grade long-term memory plugin for OpenClaw that turns your agent into an **AI Memory Assistant** — it automatically captures what matters, lets noise naturally fade, and retrieves the right memory at the right time. No manual tagging, no configuration headaches.

### Your AI Memory Assistant in Action

**Without memory — every session starts from zero:**

> **You:** "Use tabs for indentation, always add error handling."
> *(next session)*
> **You:** "I already told you — tabs, not spaces!" 😤
> *(next session)*
> **You:** "...seriously, tabs. And error handling. Again."

**With memory-lancedb-pro — your agent learns and remembers:**

> **You:** "Use tabs for indentation, always add error handling."
> *(next session — agent auto-recalls your preferences)*
> **Agent:** *(silently applies tabs + error handling)* ✅
> **You:** "Why did we pick PostgreSQL over MongoDB last month?"
> **Agent:** "Based on our discussion on Feb 12, the main reasons were..." ✅

That's the difference an **AI Memory Assistant** makes — it learns your style, recalls past decisions, and delivers personalized responses without you repeating yourself.

### What else can it do?

| | What you get |
|---|---|
| **Auto-Capture** | Your agent learns from every conversation — no manual `memory_store` needed. Rate-limited to prevent excessive API calls. |
| **Smart Extraction** | LLM-powered 6-category classification: profiles, preferences, entities, events, cases, patterns. Optional admission control gating. |
| **Intelligent Forgetting** | Weibull decay model — important memories stay, noise naturally fades away. 5-layer noise defense. |
| **Hybrid Retrieval** | Vector + BM25 full-text search, fused with cross-encoder reranking |
| **Context Injection** | Relevant memories automatically surface before each reply |
| **Multi-Scope Isolation** | Per-agent, per-user, per-project memory boundaries |
| **Any Provider** | OpenAI, Jina, Gemini, Ollama, or any OpenAI-compatible API |
| **Full Toolkit** | CLI, backup, migration, upgrade, export/import — production-ready |

---

## Quick Start

> **CPU Requirement:** Your CPU must support **AVX/AVX2** instructions (Intel Sandy Bridge 2011+ / AMD Bulldozer 2011+). LanceDB's native vector engine requires these — on unsupported CPUs the plugin will crash with `SIGILL` (Illegal Instruction). Check with: `grep -o 'avx[^ ]*' /proc/cpuinfo | head -1` (no output = not supported). See [#419](https://github.com/CortexReach/memory-lancedb-pro/issues/419) for details.

### Option A: One-Click Install Script (Recommended)

The community-maintained **[setup script](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup)** handles install, upgrade, and repair in one command:

```bash
curl -fsSL https://raw.githubusercontent.com/CortexReach/toolbox/main/memory-lancedb-pro-setup/setup-memory.sh -o setup-memory.sh
bash setup-memory.sh
```

> See [Ecosystem](#ecosystem) below for the full list of scenarios the script covers and other community tools.

### Option B: Manual Install

**Via OpenClaw CLI (recommended):**
```bash
openclaw plugins install memory-lancedb-pro@beta
```

**Or via npm:**
```bash
npm i memory-lancedb-pro@beta
```
> If using npm, you will also need to add the plugin's install directory as an **absolute** path in `plugins.load.paths` in your `openclaw.json`. This is the most common setup issue.

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "slots": { "memory": "memory-lancedb-pro" },
    "entries": {
      "memory-lancedb-pro": {
        "enabled": true,
        "config": {
          "embedding": {
            "provider": "openai-compatible",
            "apiKey": "${OPENAI_API_KEY}",
            "model": "text-embedding-3-small"
          },
          "autoCapture": true,
          "autoRecall": true,
          "smartExtraction": true,
          "extractMinMessages": 4,
          "extractMaxChars": 8000,
          "sessionStrategy": "none"
        }
      }
    }
  }
}
```

**Why these defaults?**
- `autoCapture` + `smartExtraction` → your agent learns from every conversation automatically
- `autoRecall` → relevant memories are injected before each reply
- `extractMinMessages: 4` → extraction triggers after a meaningful conversation window
- `sessionStrategy: "none"` → avoids polluting retrieval with session summaries on day one

---

## ⚠️ Dual-Memory Architecture (Important)

When `memory-lancedb-pro` is active, your system has **two independent memory layers** that do **not** auto-sync:

| Memory Layer | Storage | What it's for | Recallable? |
|---|---|---|---|
| **Plugin Memory** | LanceDB (vector store) | Semantic recall via `memory_recall` / auto-recall | ✅ Yes |
| **Markdown Memory** | `MEMORY.md`, `memory/YYYY-MM-DD.md` | Startup context, human-readable journal | ❌ Not auto-recalled |

**Key principle:**
> A fact written into `memory/YYYY-MM-DD.md` is visible in startup context, but `memory_recall` **will not find it** unless it was also written via `memory_store` (or auto-captured by the plugin).

**What this means for you:**
- Need semantic recall? → Use `memory_store` or let auto-capture do it
- `memory/YYYY-MM-DD.md` → treat as a **daily journal / log**, not a recall source
- `MEMORY.md` → curated human-readable reference, not a recall source
- Plugin memory → **primary recall source** for `memory_recall` and auto-recall

Validate & restart:

```bash
openclaw config validate
openclaw gateway restart
openclaw logs --follow --plain | grep "memory-lancedb-pro"
```

You should see:
- `memory-lancedb-pro: smart extraction enabled`
- `memory-lancedb-pro@...: plugin registered`

Done! Your agent now has long-term memory.

<details>
<summary><strong>More installation paths (existing users, upgrades)</strong></summary>

**Already using OpenClaw?**

1. Add the plugin with an **absolute** `plugins.load.paths` entry
2. Bind the memory slot: `plugins.slots.memory = "memory-lancedb-pro"`
3. Verify: `openclaw plugins info memory-lancedb-pro && openclaw memory-pro stats`

**Upgrading from pre-v1.1.0?**

```bash
# 1) Backup
openclaw memory-pro export --scope global --output memories-backup.json
# 2) Dry run
openclaw memory-pro upgrade --dry-run
# 3) Run upgrade
openclaw memory-pro upgrade
# 4) Verify
openclaw memory-pro stats
```

See `CHANGELOG-v1.1.0.md` for behavior changes and upgrade rationale.

</details>

<details>
<summary><strong>Telegram Bot Quick Import (click to expand)</strong></summary>

If you are using OpenClaw's Telegram integration, the easiest way is to send an import command directly to the main Bot instead of manually editing config.

Send this message:

```text
Help me connect this memory plugin with the most user-friendly configuration: https://github.com/CortexReach/memory-lancedb-pro

Requirements:
1. Set it as the only active memory plugin
2. Use Jina for embedding
3. Use Jina for reranker
4. Use gpt-4o-mini for the smart-extraction LLM
5. Enable autoCapture, autoRecall, smartExtraction
6. extractMinMessages=4
7. sessionStrategy=none
8. captureAssistant=false
9. retrieval mode=hybrid, vectorWeight=0.7, bm25Weight=0.3
10. rerank=cross-encoder, candidatePoolSize=12, minScore=0.6, hardMinScore=0.62
11. Generate the final openclaw.json config directly, not just an explanation
```

</details>

---

## Ecosystem

memory-lancedb-pro is the core plugin. The community has built tools around it to make setup and daily use even smoother:

### Setup Script — One-Click Install, Upgrade & Repair

> **[CortexReach/toolbox/memory-lancedb-pro-setup](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup)**

Not just a simple installer — the script intelligently handles a wide range of real-world scenarios:

| Your situation | What the script does |
|---|---|
| Never installed | Fresh download → install deps → pick config → write to openclaw.json → restart |
| Installed via `git clone`, stuck on old commit | Auto `git fetch` + `checkout` to latest → reinstall deps → verify |
| Config has invalid fields | Auto-detect via schema filter, remove unsupported fields |
| Installed via `npm` | Skips git update, reminds you to run `npm update` yourself |
| `openclaw` CLI broken due to invalid config | Fallback: read workspace path directly from `openclaw.json` file |
| `extensions/` instead of `plugins/` | Auto-detect plugin location from config or filesystem |
| Already up to date | Run health checks only, no changes |

```bash
bash setup-memory.sh                    # Install or upgrade
bash setup-memory.sh --dry-run          # Preview only
bash setup-memory.sh --beta             # Include pre-release versions
bash setup-memory.sh --uninstall        # Revert config and remove plugin
```

Built-in provider presets: **Jina / DashScope / SiliconFlow / OpenAI / Ollama**, or bring your own OpenAI-compatible API. For full usage (including `--ref`, `--selfcheck-only`, and more), see the [setup script README](https://github.com/CortexReach/toolbox/tree/main/memory-lancedb-pro-setup).

### Claude Code / OpenClaw Skill — AI-Guided Configuration

> **[CortexReach/memory-lancedb-pro-skill](https://github.com/CortexReach/memory-lancedb-pro-skill)**

Install this skill and your AI agent (Claude Code or OpenClaw) gains deep knowledge of every feature in memory-lancedb-pro. Just say **"help me enable the best config"** and get:

- **Guided 7-step configuration workflow** with 4 deployment plans:
  - Full Power (Jina + OpenAI) / Budget (free SiliconFlow reranker) / Simple (OpenAI only) / Fully Local (Ollama, zero API cost)
- **All 9 MCP tools** used correctly: `memory_recall`, `memory_store`, `memory_forget`, `memory_update`, `memory_stats`, `memory_list`, `memory_promote`, `memory_archive`, `memory_compact`, `memory_debug`, `memory_explain_rank` *(full toolset requires `enableManagementTools: true` — the default Quick Start config exposes the 4 core tools)*
- **Common pitfall avoidance**: workspace plugin enablement, `autoRecall` default-false, jiti cache, env vars, scope isolation, and more

**Install for Claude Code:**
```bash
git clone https://github.com/CortexReach/memory-lancedb-pro-skill.git ~/.claude/skills/memory-lancedb-pro
```

**Install for OpenClaw:**
```bash
git clone https://github.com/CortexReach/memory-lancedb-pro-skill.git ~/.openclaw/workspace/skills/memory-lancedb-pro-skill
```

---

## Video Tutorial

> Full walkthrough: installation, configuration, and hybrid retrieval internals.

[![YouTube Video](https://img.shields.io/badge/YouTube-Watch%20Now-red?style=for-the-badge&logo=youtube)](https://youtu.be/MtukF1C8epQ)
**https://youtu.be/MtukF1C8epQ**

[![Bilibili Video](https://img.shields.io/badge/Bilibili-Watch%20Now-00A1D6?style=for-the-badge&logo=bilibili&logoColor=white)](https://www.bilibili.com/video/BV1zUf2BGEgn/)
**https://www.bilibili.com/video/BV1zUf2BGEgn/**

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   index.ts (Entry Point)                │
│  Plugin Registration · Config Parsing · Lifecycle Hooks  │
│  · Background Pipeline · Rate Limiting · Dedup Guard    │
└────────┬──────────┬──────────┬──────────┬───────────────┘
         │          │          │          │
    ┌────▼───┐ ┌────▼───┐ ┌───▼────┐ ┌──▼──────────┐
    │ store  │ │embedder│ │retriever│ │   scopes    │
    │ .ts    │ │ .ts    │ │ .ts    │ │    .ts      │
    └────────┘ └────────┘ └────────┘ └─────────────┘
         │                     │              │
    ┌────▼───┐           ┌─────▼──────────┐   │
    │migrate │           │noise-filter.ts │   │
    │ .ts    │           │noise-          │   │
    └────────┘           │prototypes.ts   │   │
                         │adaptive-       │   │
                         │retrieval.ts    │   │
                         └────────────────┘   │
    ┌─────────────┐   ┌──────────┐   ┌───────▼────────┐
    │  tools.ts   │   │  cli.ts  │   │background-     │
    │ (Agent API) │   │ (CLI)    │   │scheduler.ts    │
    └─────────────┘   └──────────┘   └────────────────┘
    ┌──────────────────┐  ┌──────────────────────┐
    │access-tracker.ts │  │memory-consolidation. │
    │(Dynamic confid.) │  │ts (6-dim scoring)     │
    └──────────────────┘  └──────────────────────┘
    ┌──────────────────┐  ┌──────────────────────┐
    │smart-            │  │admission-            │
    │extractor.ts      │  │controller.ts         │
    └──────────────────┘  └──────────────────────┘
    ┌──────────────────┐  ┌──────────────────────┐
    │session-          │  │auto-capture-         │
    │compression.ts    │  │cleanup.ts            │
    └──────────────────┘  └──────────────────────┘
```

> For a deep-dive into the full architecture, see [docs/memory_architecture_analysis.md](docs/memory_architecture_analysis.md).

<details>
<summary><strong>File Reference (click to expand)</strong></summary>

| File | Purpose |
| --- | --- |
| `index.ts` | Plugin entry point. Registers with OpenClaw Plugin API, parses config, mounts lifecycle hooks via `api.on()` and command hooks via `api.registerHook()` |
| `openclaw.plugin.json` | Plugin metadata + full JSON Schema config declaration |
| `cli.ts` | CLI commands: `memory-pro list/search/stats/delete/delete-bulk/export/import/reembed/upgrade/migrate` |
| `src/store.ts` | LanceDB storage layer. Table creation / FTS indexing / Vector search / BM25 search / CRUD |
| `src/embedder.ts` | Embedding abstraction. Compatible with any OpenAI-compatible API provider |
| `src/retriever.ts` | Hybrid retrieval engine. Vector + BM25 → Hybrid Fusion → Rerank → Lifecycle Decay → Filter |
| `src/scopes.ts` | Multi-scope access control |
| `src/tools.ts` | Agent tool definitions: `memory_recall`, `memory_store`, `memory_forget`, `memory_update` + management tools |
| `src/noise-filter.ts` | Filters out agent refusals, meta-questions, greetings, and low-quality content |
| `src/adaptive-retrieval.ts` | Determines whether a query needs memory retrieval |
| `src/migrate.ts` | Migration from built-in `memory-lancedb` to Pro |
| `src/smart-extractor.ts` | LLM-powered 6-category extraction with L0/L1/L2 layered storage, two-stage dedup, noise filtering, and rate limiting |
| `src/decay-engine.ts` | Weibull stretched-exponential decay model |
| `src/tier-manager.ts` | Three-tier promotion/demotion: Peripheral ↔ Working ↔ Core |
| `src/memory-consolidation.ts` | 6-dimension consolidation scoring engine: access patterns, confirmations, contradictions |
| `src/background-scheduler.ts` | 3-tier background pipeline: Sweep → Consolidate → Compact |
| `src/access-tracker.ts` | Dynamic confidence updates: confirmed use boosts, contradictions penalize, long-term non-use decays |
| `src/admission-controller.ts` | A-MAC-style admission gating on the write path: utility, novelty, recency, type priors |
| `src/noise-prototypes.ts` | Embedding-based noise prototype bank with cosine similarity matching |
| `src/auto-capture-cleanup.ts` | Input text cleaning: strips envelopes, metadata, runtime wrappers, message IDs |
| `src/session-compression.ts` | Scores and compresses conversation texts before extraction |

</details>

---

## Core Features

### Hybrid Retrieval

```
Query → embedQuery() ─┐
                       ├─→ Hybrid Fusion → Rerank → Lifecycle Decay Boost → Length Norm → Filter
Query → BM25 FTS ─────┘
```

- **Vector Search** — semantic similarity via LanceDB ANN (cosine distance)
- **BM25 Full-Text Search** — exact keyword matching via LanceDB FTS index
- **Hybrid Fusion** — vector score as base, BM25 hits receive a weighted boost (not standard RRF — tuned for real-world recall quality)
- **Configurable Weights** — `vectorWeight`, `bm25Weight`, `minScore`

### Cross-Encoder Reranking

- Built-in adapters for **Jina**, **SiliconFlow**, **Voyage AI**, and **Pinecone**
- Compatible with any Jina-compatible endpoint (e.g., Hugging Face TEI, DashScope)
- Hybrid scoring: 60% cross-encoder + 40% original fused score
- Graceful degradation: falls back to cosine similarity on API failure

### Multi-Stage Scoring Pipeline

| Stage | Effect |
| --- | --- |
| **Hybrid Fusion** | Combines semantic and exact-match recall |
| **Cross-Encoder Rerank** | Promotes semantically precise hits |
| **Lifecycle Decay Boost** | Weibull freshness + access frequency + importance × confidence |
| **Length Normalization** | Prevents long entries from dominating (anchor: 500 chars) |
| **Hard Min Score** | Removes irrelevant results (default: 0.35) |
| **MMR Diversity** | Cosine similarity > 0.85 → demoted |

### Smart Memory Extraction (v1.1.0)

- **LLM-Powered 6-Category Extraction**: profile, preferences, entities, events, cases, patterns
- **L0/L1/L2 Layered Storage**: L0 (one-sentence index) → L1 (structured summary) → L2 (full narrative)
- **Two-Stage Dedup**: vector similarity pre-filter (≥0.7) → LLM semantic decision (CREATE/MERGE/SKIP/SUPERSEDE/SUPPORT/CONTEXTUALIZE/CONTRADICT)
- **Category-Aware Merge**: `profile` always merges, `events`/`cases` are append-only
- **Rate Limiting**: 10 extractions/hour global + 5-min per-session cooldown (configurable)
- **Admission Control** (optional): A-MAC-style gating scores candidates on utility, novelty, recency, confidence, and type priors before persistence
- **Noise Filtering**: 5-layer defense-in-depth — input cleaning, embedding pre-check, LLM extraction, regex fallback, embedding-based NoisePrototypeBank
- **Session Compression** (optional): scores conversation texts before extraction, prioritizing corrections, decisions, and tool calls

### Memory Lifecycle Management (v1.1.0)

- **Weibull Decay Engine**: composite score = recency + frequency + intrinsic value
- **Three-Tier Promotion**: `Peripheral ↔ Working ↔ Core` with configurable thresholds
- **Access Reinforcement**: frequently recalled memories decay slower (spaced-repetition style)
- **Importance-Modulated Half-Life**: important memories decay slower

### Multi-Scope Isolation

- Built-in scopes: `global`, `agent:<id>`, `custom:<name>`, `project:<id>`, `user:<id>`
- Agent-level access control via `scopes.agentAccess`
- Default: each agent accesses `global` + its own `agent:<id>` scope

### Auto-Capture & Auto-Recall

- **Auto-Capture** (`agent_end`): extracts profile/preferences/entities/events/cases/patterns from conversations, deduplicates, stores up to 3 per turn
- **Auto-Recall** (`before_prompt_build`): injects `<relevant-memories>` context (up to 3 entries, configurable via `autoRecallMaxItems`)
- **Recall Modes** (`recallMode`): `full` (L2 content), `summary` (L0 abstracts only), `adaptive` (intent-based routing), `off`

> **Note (v1.1.0-beta.9+):** Auto-recall now uses the `before_prompt_build` hook instead of the deprecated `before_agent_start`. See [Hook Adaptation](#hook-adaptation-openclaw-20263) below for details.

### Noise Filtering & Adaptive Retrieval

- **5-layer defense-in-depth**: L1 input cleaning → L2 embedding pre-check → L3 LLM extraction → L4 regex fallback → L5 embedding-based NoisePrototypeBank
- Filters low-quality content: agent refusals, meta-questions, greetings, platform/operational noise
- Platform noise handling: strips `System:` lines, message IDs, model-switch events at input; regex + prototype matching at extraction
- Skips retrieval for greetings, slash commands, simple confirmations, emoji
- Forces retrieval for memory keywords ("remember", "previously", "last time")
- CJK-aware thresholds (Chinese: 6 chars vs English: 15 chars)

### Memory Consolidation Scoring Engine (New)

When the LLM's one-time `importance` score doesn't match actual usage patterns, the 6-dimension consolidation model provides more accurate value judgment:

| Dimension | Weight | Description |
|---|---|---|
| access_recency | 0.25 | Was it recalled recently? (14-day half-life) |
| access_frequency | 0.20 | Cumulative recall count (log-saturated) |
| injection_use | 0.20 | Times injected into context |
| confirmation | 0.15 | Signals of being confirmed useful |
| bad_recall | 0.15 | Penalty for being contradicted/useless |
| tier_stability | 0.05 | Stability in current tier |

**Output actions**:
- `score >= 0.75` → promote to core tier
- `score <= 0.15` + age >= 30 days → mark for archive
- `bad_recall_count >= 5` → auto-suppress (configurable via `memoryConsolidation.suppressThreshold`)

### Dynamic Confidence Updates (New)

Every recall outcome adjusts the memory's `confidence` value in real time:
- Confirmed useful → confidence += delta
- Contradicted → confidence -= delta
- Long-term non-use → slow decay (starts after 30 days, 0.001/day)
- Floor: 0.1, Cap: 1.0

### 3-Tier Background Processing Pipeline (New)

| Phase | Trigger | Action |
|---|---|---|
| **Sweep** | Every gateway_start | Compute decay scores, mark stale entries, compute health, auto-recover archived memories |
| **Consolidate** | 24h cooldown | 6-dimension consolidation scoring + tier migration |
| **Compact** | 24h cooldown | LSH clustering + similarity merging + progressive summarization |

### Memory Health & Auto-Recovery (New)

- health = core_active_ratio * 0.4 + avg_confidence * 0.3 + recall_success_rate * 0.3
- When health < threshold, auto-recovers high-confidence (>=0.6) entries from archived state

---

<details>
<summary><strong>Compared to Built-in <code>memory-lancedb</code> (click to expand)</strong></summary>

| Feature | Built-in `memory-lancedb` | **memory-lancedb-pro** |
| --- | :---: | :---: |
| Vector search | Yes | Yes |
| BM25 full-text search | - | Yes |
| Hybrid fusion (Vector + BM25) | - | Yes |
| Cross-encoder rerank (multi-provider) | - | Yes |
| Recency boost & time decay | - | Yes |
| Length normalization | - | Yes |
| MMR diversity | - | Yes |
| Multi-scope isolation | - | Yes |
| Noise filtering | - | Yes |
| Adaptive retrieval | - | Yes |
| Management CLI | - | Yes |
| Session memory | - | Yes |
| Task-aware embeddings | - | Yes |
| **LLM Smart Extraction (6-category)** | - | Yes (v1.1.0) |
| **Weibull Decay + Tier Promotion** | - | Yes (v1.1.0) |
| **6-Dimension Consolidation Scoring** | - | Yes (enhanced) |
| **Dynamic Confidence Updates** | - | Yes (enhanced) |
| **3-Tier Background Pipeline** | - | Yes (enhanced) |
| **Memory Health & Auto-Recovery** | - | Yes (enhanced) |
| Any OpenAI-compatible embedding | Limited | Yes |

</details>

---

## Configuration

<details>
<summary><strong>Full Configuration Example</strong></summary>

```json
{
  "embedding": {
    "apiKey": "${JINA_API_KEY}",
    "model": "jina-embeddings-v5-text-small",
    "baseURL": "https://api.jina.ai/v1",
    "dimensions": 1024,
    "taskQuery": "retrieval.query",
    "taskPassage": "retrieval.passage",
    "normalized": true
  },
  "dbPath": "~/.openclaw/memory/lancedb-pro",
  "autoCapture": true,
  "autoRecall": true,
  "recallMode": "full",
  "retrieval": {
    "mode": "hybrid",
    "vectorWeight": 0.7,
    "bm25Weight": 0.3,
    "minScore": 0.3,
    "rerank": "cross-encoder",
    "rerankApiKey": "${JINA_API_KEY}",
    "rerankModel": "jina-reranker-v3",
    "rerankEndpoint": "https://api.jina.ai/v1/rerank",
    "rerankProvider": "jina",
    "candidatePoolSize": 20,
    "recencyHalfLifeDays": 14,
    "recencyWeight": 0.1,
    "filterNoise": true,
    "lengthNormAnchor": 500,
    "hardMinScore": 0.35,
    "timeDecayHalfLifeDays": 60,
    "reinforcementFactor": 0.5,
    "maxHalfLifeMultiplier": 3
  },
  "enableManagementTools": false,
  "scopes": {
    "default": "global",
    "definitions": {
      "global": { "description": "Shared knowledge" },
      "agent:discord-bot": { "description": "Discord bot private" }
    },
    "agentAccess": {
      "discord-bot": ["global", "agent:discord-bot"]
    }
  },
  "sessionStrategy": "none",
  "smartExtraction": true,
  "llm": {
    "apiKey": "${OPENAI_API_KEY}",
    "model": "gpt-4o-mini",
    "baseURL": "https://api.openai.com/v1"
  },
  "extractMinMessages": 4,
  "extractMaxChars": 8000,
  "extractionThrottle": {
    "maxExtractionsPerHour": 10,
    "sessionCooldownMs": 300000
  },
  "memoryConsolidation": { "enabled": false },
  "memoryCompaction": { "enabled": false },
  "memorySweep": { "healthThreshold": 0.3 },
  "mdMirror": { "enabled": false }
}
```

</details>

<details>
<summary><strong>Embedding Providers</strong></summary>

Works with **any OpenAI-compatible embedding API**:

| Provider | Model | Base URL | Dimensions |
| --- | --- | --- | --- |
| **Jina** (recommended) | `jina-embeddings-v5-text-small` | `https://api.jina.ai/v1` | 1024 |
| **OpenAI** | `text-embedding-3-small` | `https://api.openai.com/v1` | 1536 |
| **Voyage** | `voyage-4-lite` / `voyage-4` | `https://api.voyageai.com/v1` | 1024 / 1024 |
| **Google Gemini** | `gemini-embedding-001` | `https://generativelanguage.googleapis.com/v1beta/openai/` | 3072 |
| **NVIDIA NIM** | `nvidia/nv-embedqa-e5-v5` | `https://integrate.api.nvidia.com/v1` | 1024 |
| **Ollama** (local) | `nomic-embed-text` | `http://localhost:11434/v1` | provider-specific |

</details>

<details>
<summary><strong>Rerank Providers</strong></summary>

Cross-encoder reranking supports multiple providers via `rerankProvider`:

| Provider | `rerankProvider` | Example Model |
| --- | --- | --- |
| **Jina** (default) | `jina` | `jina-reranker-v3` |
| **SiliconFlow** (free tier available) | `siliconflow` | `BAAI/bge-reranker-v2-m3` |
| **Voyage AI** | `voyage` | `rerank-2.5` |
| **Pinecone** | `pinecone` | `bge-reranker-v2-m3` |
| **DashScope** | `dashscope` | `gte-rerank-v2` |
| **HuggingFace TEI** | `tei` | Any TEI-deployed reranker |

> Any Jina-compatible endpoint also works — set `rerankProvider: "jina"` and point `rerankEndpoint` to your service.

</details>

<details>
<summary><strong>Smart Extraction (LLM) — v1.1.0</strong></summary>

When `smartExtraction` is enabled (default: `true`), the plugin uses an LLM to intelligently extract and classify memories instead of regex-based triggers.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `smartExtraction` | boolean | `true` | Enable/disable LLM-powered 6-category extraction |
| `llm.auth` | string | `api-key` | `api-key` uses `llm.apiKey` / `embedding.apiKey`; `oauth` uses a plugin-scoped OAuth token file by default |
| `llm.apiKey` | string | *(falls back to `embedding.apiKey`)* | API key for the LLM provider |
| `llm.model` | string | `openai/gpt-oss-120b` | LLM model name |
| `llm.baseURL` | string | *(falls back to `embedding.baseURL`)* | LLM API endpoint |
| `llm.oauthProvider` | string | `openai-codex` | OAuth provider id used when `llm.auth` is `oauth` |
| `llm.oauthPath` | string | `~/.openclaw/.memory-lancedb-pro/oauth.json` | OAuth token file used when `llm.auth` is `oauth` |
| `llm.timeoutMs` | number | `30000` | LLM request timeout in milliseconds |
| `extractMinMessages` | number | `4` | Minimum messages before extraction triggers |
| `extractMaxChars` | number | `8000` | Maximum characters sent to the LLM |
| `sessionStrategy` | string | `none` | `memoryReflection` / `systemSessionMemory` / `none` |
| `extractionThrottle.maxExtractionsPerHour` | number | `10` | Global rate limit for auto-capture extractions |
| `extractionThrottle.sessionCooldownMs` | number | `300000` | Per-session cooldown (5 min) between extractions |
| `extractionThrottle.skipLowValue` | boolean | `false` | Skip extraction for conversations with estimated value < 0.2 |


OAuth `llm` config (use existing Codex / ChatGPT login cache for LLM calls):
```json
{
  "llm": {
    "auth": "oauth",
    "oauthProvider": "openai-codex",
    "model": "gpt-5.4",
    "oauthPath": "${HOME}/.openclaw/.memory-lancedb-pro/oauth.json",
    "timeoutMs": 30000
  }
}
```

Notes for `llm.auth: "oauth"`:

- `llm.oauthProvider` is currently `openai-codex`.
- OAuth tokens default to `~/.openclaw/.memory-lancedb-pro/oauth.json`.
- You can set `llm.oauthPath` if you want to store that file somewhere else.
- `auth login` snapshots the previous api-key `llm` config next to the OAuth file, and `auth logout` restores that snapshot when available.
- Switching from `api-key` to `oauth` does not automatically carry over `llm.baseURL`. Set it manually in OAuth mode only when you intentionally want a custom ChatGPT/Codex-compatible backend.

</details>

<details>
<summary><strong>Lifecycle Configuration (Decay + Tier)</strong></summary>

| Field | Default | Description |
|-------|---------|-------------|
| `decay.recencyHalfLifeDays` | `30` | Base half-life for Weibull recency decay |
| `decay.frequencyWeight` | `0.3` | Weight of access frequency in composite score |
| `decay.intrinsicWeight` | `0.3` | Weight of `importance × confidence` |
| `decay.betaCore` | `0.8` | Weibull beta for `core` memories |
| `decay.betaWorking` | `1.0` | Weibull beta for `working` memories |
| `decay.betaPeripheral` | `1.3` | Weibull beta for `peripheral` memories |
| `tier.coreAccessThreshold` | `10` | Min recall count before promoting to `core` |
| `tier.peripheralAgeDays` | `60` | Age threshold for demoting stale memories |

</details>

<details>
<summary><strong>Admission Control (A-MAC)</strong></summary>

Scores extraction candidates before persistence using utility, novelty, recency, confidence, and type priors.

| Field | Default | Description |
|-------|---------|-------------|
| `admissionControl.enabled` | `false` | Enable admission gating on the write path |
| `admissionControl.preset` | `balanced` | `balanced` / `conservative` / `high-recall` |
| `admissionControl.rejectThreshold` | `0.45` | Candidates below this score are rejected |
| `admissionControl.admitThreshold` | `0.6` | Candidates above this labeled as "likely add" |
| `admissionControl.utilityMode` | `standalone` | `standalone` adds separate LLM utility scoring; `off` disables it |
| `admissionControl.noveltyCandidatePoolSize` | `8` | Nearby memories compared for novelty scoring |

</details>

<details>
<summary><strong>Memory Compaction (LSH Clustering)</strong></summary>

Progressive summarization: periodically merge semantically similar old memories into refined entries.

| Field | Default | Description |
|-------|---------|-------------|
| `memoryCompaction.enabled` | `false` | Enable automatic compaction at gateway startup |
| `memoryCompaction.minAgeDays` | `7` | Only compact memories at least this many days old |
| `memoryCompaction.similarityThreshold` | `0.88` | Cosine similarity threshold for clustering |
| `memoryCompaction.cooldownHours` | `24` | Minimum hours between automatic compaction runs |
| `memoryCompaction.maxMemoriesToScan` | `200` | Maximum memories to scan per compaction run |

> Also available on-demand via the `memory_compact` tool (requires `enableManagementTools: true`).

</details>

<details>
<summary><strong>Memory Sweep & Health</strong></summary>

Lightweight background sweep: compute memory health, detect stale entries, auto-recover archived memories.

| Field | Default | Description |
|-------|---------|-------------|
| `memorySweep.maxMemoriesPerSweep` | `200` | Maximum memories to evaluate per sweep |
| `memorySweep.staleThreshold` | `0.2` | Decay score below which a memory is considered stale |
| `memorySweep.healthThreshold` | `0.3` | Health threshold — below this triggers auto-recovery |

</details>

<details>
<summary><strong>Session Compression</strong></summary>

Scores and compresses conversation texts before extraction, prioritizing high-signal content.

| Field | Default | Description |
|-------|---------|-------------|
| `sessionCompression.enabled` | `false` | Enable session compression before extraction |
| `sessionCompression.minScoreToKeep` | `0.3` | Minimum text score threshold to keep |

</details>

<details>
<summary><strong>USER.md Boundary Control</strong></summary>

Route agent-prompt-owned facts to USER.md only, keeping LanceDB free of duplicate knowledge.

| Field | Default | Description |
|-------|---------|-------------|
| `workspaceBoundary.userMdExclusive.enabled` | `false` | Skip storing USER.md-owned facts in LanceDB |
| `workspaceBoundary.userMdExclusive.routeProfile` | `true` | Treat extracted profile memories as USER.md-only |
| `workspaceBoundary.userMdExclusive.routeCanonicalName` | `true` | Treat canonical name facts as USER.md-only |
| `workspaceBoundary.userMdExclusive.routeCanonicalAddressing` | `true` | Treat canonical addressing facts as USER.md-only |
| `workspaceBoundary.userMdExclusive.filterRecall` | `true` | Filter USER.md-exclusive facts from plugin recall |

</details>

<details>
<summary><strong>Markdown Mirror</strong></summary>

Dual-write memories to human-readable Markdown alongside LanceDB storage.

| Field | Default | Description |
|-------|---------|-------------|
| `mdMirror.enabled` | `false` | Enable dual-write to Markdown files |
| `mdMirror.dir` | *(fallback)* | Fallback directory when agent workspace mapping is unavailable |

</details>

<details>
<summary><strong>Access Reinforcement</strong></summary>

Frequently recalled memories decay more slowly (spaced-repetition style).

Config keys (under `retrieval`):
- `reinforcementFactor` (0-2, default: `0.5`) — set `0` to disable
- `maxHalfLifeMultiplier` (1-10, default: `3`) — hard cap on effective half-life

</details>

---

## Agent Tools (MCP)

When `enableManagementTools: true`, the plugin exposes these tools to the agent:

| Tool | Description |
|------|-------------|
| `memory_recall` | Search and retrieve relevant memories (core tool) |
| `memory_store` | Store a new memory entry (core tool) |
| `memory_forget` | Delete a memory by ID (core tool) |
| `memory_update` | Update an existing memory (core tool) |
| `memory_stats` | Show memory statistics with tier/category breakdown |
| `memory_list` | List memories with filtering by scope/category/tier |
| `memory_promote` | Manually promote a memory to a higher tier |
| `memory_archive` | Manually archive a memory |
| `memory_compact` | Trigger LSH clustering + similarity merging |
| `memory_debug` | Debug retrieval for a query (show scoring pipeline) |
| `memory_explain_rank` | Explain why a specific memory ranked where it did |

> The default Quick Start config exposes only the 4 core tools. Enable full toolset with `enableManagementTools: true`.

---

## CLI Commands

```bash
openclaw memory-pro version
openclaw memory-pro auth login [--provider openai-codex] [--model gpt-5.4] [--oauth-path /abs/path/oauth.json]
openclaw memory-pro auth status
openclaw memory-pro auth logout
openclaw memory-pro list [--scope global] [--category fact] [--limit 20] [--json]
openclaw memory-pro search "query" [--scope global] [--limit 10] [--json] [--debug]
openclaw memory-pro stats [--scope global] [--json]
openclaw memory-pro delete <id>
openclaw memory-pro delete-bulk --scope global [--before 2025-01-01] [--dry-run]
openclaw memory-pro export [--scope global] [--output memories.json]
openclaw memory-pro import memories.json [--scope global] [--dry-run]
openclaw memory-pro import-markdown [workspace-glob]
openclaw memory-pro reembed --source-db /path/to/old-db [--batch-size 32] [--skip-existing]
openclaw memory-pro upgrade [--dry-run] [--batch-size 10] [--no-llm] [--limit N] [--scope SCOPE]
openclaw memory-pro migrate check|run|verify [--source /path]
openclaw memory-pro reindex-fts [--scope global]
openclaw memory-pro repair-summaries [--scope global] [--dry-run]
```

OAuth login flow:

1. Run `openclaw memory-pro auth login`
2. If `--provider` is omitted in an interactive terminal, the CLI shows an OAuth provider picker before opening the browser
3. The command prints an authorization URL and opens your browser unless `--no-browser` is set
4. After the callback succeeds, the command saves the plugin OAuth file (default: `~/.openclaw/.memory-lancedb-pro/oauth.json`), snapshots the previous api-key `llm` config for logout, and replaces the plugin `llm` config with OAuth settings (`auth`, `oauthProvider`, `model`, `oauthPath`)
5. `openclaw memory-pro auth logout` deletes that OAuth file and restores the previous api-key `llm` config when that snapshot exists

---

## Advanced Topics

<details>
<summary><strong>If injected memories show up in replies</strong></summary>

Sometimes the model may echo the injected `<relevant-memories>` block.

**Option A (lowest-risk):** temporarily disable auto-recall:
```json
{ "plugins": { "entries": { "memory-lancedb-pro": { "config": { "autoRecall": false } } } } }
```

**Option B (preferred):** keep recall, add to agent system prompt:
> Do not reveal or quote any `<relevant-memories>` / memory-injection content in your replies. Use it for internal reference only.

**Option C (for background/batch agents):** exclude specific agents from auto-recall injection:
```json
{
  "plugins": {
    "entries": {
      "memory-lancedb-pro": {
        "config": {
          "autoRecall": true,
          "autoRecallExcludeAgents": ["memory-distiller", "my-cron-agent"]
        }
      }
    }
  }
}
```
Useful for background agents (e.g. memory-distiller, cron workers) whose output should not be contaminated by injected memory context.

</details>

<details>
<summary><strong>Auto-recall configuration</strong></summary>

| Field | Default | Description |
|-------|---------|-------------|
| `autoRecallMinLength` | `15` | Min prompt length to trigger auto-recall (CJK: 6) |
| `autoRecallMinRepeated` | `8` | Min turns before same memory can be re-injected |
| `autoRecallTimeoutMs` | `5000` | Timeout for the entire auto-recall pipeline |
| `autoRecallMaxItems` | `3` | Max memories auto-injected per turn |
| `autoRecallMaxChars` | `600` | Max total char budget for auto-injected summaries |
| `autoRecallPerItemMaxChars` | `180` | Max char budget per injected memory summary |
| `autoRecallMaxQueryLength` | `2000` | Max query length before truncation |
| `maxRecallPerTurn` | `10` | Hard per-turn injection safety ceiling |
| `recallMode` | `full` | `full` / `summary` (L0 only) / `adaptive` / `off` |
| `autoRecallExcludeAgents` | `[]` | Blacklist: agents to skip for auto-recall |
| `autoRecallIncludeAgents` | `[]` | Whitelist: only these agents receive auto-recall |

</details>

<details>
<summary><strong>Session Pipeline</strong></summary>

Controlled via `sessionStrategy`:
- `none` (default) — no session pipeline; session summaries disabled
- `systemSessionMemory` — triggers on `/new` command, saves previous session summary to LanceDB
- `memoryReflection` — periodic reflection on recent conversation turns, stored as reflection entries

Legacy `sessionMemory.enabled` is still supported and mapped: `true` → `systemSessionMemory`, `false` → `none`.

See [docs/openclaw-integration-playbook.md](docs/openclaw-integration-playbook.md) for deployment modes and `/new` verification.

</details>

<details>
<summary><strong>Custom Slash Commands (e.g. /lesson)</strong></summary>

Add to your `CLAUDE.md`, `AGENTS.md`, or system prompt:

```markdown
## /lesson command
When the user sends `/lesson <content>`:
1. Use memory_store to save as category=fact (raw knowledge)
2. Use memory_store to save as category=decision (actionable takeaway)
3. Confirm what was saved

## /remember command
When the user sends `/remember <content>`:
1. Use memory_store to save with appropriate category and importance
2. Confirm with the stored memory ID
```

</details>

<details>
<summary><strong>Iron Rules for AI Agents</strong></summary>

> Copy the block below into your `AGENTS.md` so your agent enforces these rules automatically.

```markdown
## Rule 1 — Dual-layer memory storage
Every pitfall/lesson learned → IMMEDIATELY store TWO memories:
- Technical layer: Pitfall: [symptom]. Cause: [root cause]. Fix: [solution]. Prevention: [how to avoid]
  (category: fact, importance >= 0.8)
- Principle layer: Decision principle ([tag]): [behavioral rule]. Trigger: [when]. Action: [what to do]
  (category: decision, importance >= 0.85)

## Rule 2 — LanceDB hygiene
Entries must be short and atomic (< 500 chars). No raw conversation summaries or duplicates.

## Rule 3 — Recall before retry
On ANY tool failure, ALWAYS memory_recall with relevant keywords BEFORE retrying.

## Rule 4 — Confirm target codebase
Confirm you are editing memory-lancedb-pro vs built-in memory-lancedb before changes.

## Rule 5 — Clear jiti cache after plugin code changes
After modifying .ts files under plugins/, MUST run rm -rf /tmp/jiti/ BEFORE openclaw gateway restart.
```

</details>

<details>
<summary><strong>Database Schema</strong></summary>

LanceDB table `memories`:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string (UUID) | Primary key |
| `text` | string | Memory text (FTS indexed) |
| `vector` | float[] | Embedding vector |
| `category` | string | Storage category: `preference` / `fact` / `decision` / `entity` / `reflection` / `other` |
| `scope` | string | Scope identifier (e.g., `global`, `agent:main`) |
| `importance` | float | Importance score 0-1 |
| `timestamp` | int64 | Creation timestamp (ms) |
| `metadata` | string (JSON) | Extended metadata |

Common `metadata` keys in v1.1.0: `l0_abstract`, `l1_overview`, `l2_content`, `memory_category`, `tier`, `access_count`, `confidence`, `last_accessed_at`

> **Note on categories:** The top-level `category` field uses 6 storage categories. The 6-category semantic labels from Smart Extraction (`profile` / `preferences` / `entities` / `events` / `cases` / `patterns`) are stored in `metadata.memory_category`.

</details>

<details>
<summary><strong>Troubleshooting</strong></summary>

### "Cannot mix BigInt and other types" (LanceDB / Apache Arrow)

On LanceDB 0.26+, some numeric columns may be returned as `BigInt`. Upgrade to **memory-lancedb-pro >= 1.0.14** — this plugin now coerces values using `Number(...)` before arithmetic.

</details>

---

## Hook Adaptation (OpenClaw 2026.3+)

Starting with v1.1.0-beta.9, the plugin's lifecycle hooks have been updated for compatibility with the refactored OpenClaw plugin system.

### What changed

| Hook | Before | After | Why |
|------|--------|-------|-----|
| Auto-recall | `before_agent_start` | `before_prompt_build` (priority 10) | `before_agent_start` is deprecated; `before_prompt_build` is the recommended hook for prompt mutation |
| Reflection invariants | `before_agent_start` | `before_prompt_build` (priority 12) | Same reason as above |
| Reflection derived focus | `before_prompt_build` | `before_prompt_build` (priority 15) | Unchanged event, added explicit priority |
| All other lifecycle hooks | unchanged | unchanged | `agent_end`, `after_tool_call`, `session_end`, `message_received`, `before_message_write` |

### Hook API distinction

OpenClaw exposes two hook registration methods. They write to **different registries**:

| Method | Registry | Dispatch | Use for |
|--------|----------|----------|---------|
| `api.on(event, handler, opts)` | `registry.typedHooks` | Dispatched by the lifecycle hook runner | Lifecycle events: `before_prompt_build`, `agent_end`, `after_tool_call`, `session_end`, `message_received`, `before_message_write` |
| `api.registerHook(event, handler, opts)` | `registry.hooks` | Dispatched by the internal hook system | Command/bootstrap events: `command:new`, `command:reset`, `agent:bootstrap` |

Using the wrong method causes hooks to register silently without firing. This plugin uses `api.on()` for all lifecycle hooks and `api.registerHook()` for command hooks.

### Verifying hooks after install

```bash
openclaw plugins info memory-lancedb-pro
```

You should see:

```
Legacy before_agent_start: no

Typed hooks:
  agent_end
  before_message_write
  before_prompt_build (priority 10)
  message_received

Custom hooks:
  memory-lancedb-pro-session-memory: command:new
```

If `Legacy before_agent_start: yes` appears, you are running an older version of the plugin.

### Migration from older versions

If you are upgrading from v1.1.0-beta.8 or earlier:

1. Replace the plugin files (copy or `openclaw plugins install`)
2. Clear the jiti cache: `rm -rf /tmp/jiti/`
3. Restart the gateway: `openclaw gateway restart`
4. Verify: `openclaw plugins info memory-lancedb-pro` should show `Legacy before_agent_start: no`

No config changes or data migration required. All existing memories, scopes, and settings are preserved.

### OpenClaw version requirements

- **Minimum:** OpenClaw 2026.3.22
- **Recommended:** OpenClaw latest (2026.3.23+)

This version uses `before_prompt_build` hooks (replacing the deprecated `before_agent_start`), which requires OpenClaw 2026.3.22 or later. Running `openclaw doctor --fix` after upgrading will automatically migrate plugin config (e.g. `minimax-portal-auth` → `minimax`, Brave search as a standalone plugin).

To upgrade OpenClaw:

```bash
npm update -g openclaw
openclaw --version    # verify >= 2026.3.22
openclaw doctor --fix # resolve any stale config after upgrade
```

---

## Documentation

| Document | Description |
| --- | --- |
| [OpenClaw Integration Playbook](docs/openclaw-integration-playbook.md) | Deployment modes, verification, regression matrix |
| [Memory Architecture Analysis](docs/memory_architecture_analysis.md) | Full architecture deep-dive |
| [CHANGELOG v1.1.0](docs/CHANGELOG-v1.1.0.md) | v1.1.0 behavior changes and upgrade rationale |
| [Long-Context Chunking](docs/long-context-chunking.md) | Chunking strategy for long documents |

---

## Enhanced: Smart Memory v1.1.0+

> Status: Beta — available via `npm i memory-lancedb-pro@beta`. Stable users on `latest` are not affected.

| Feature | Description |
|---------|-------------|
| **Smart Extraction** | LLM-powered 6-category extraction with L0/L1/L2 metadata. Falls back to regex when disabled. Rate-limited: 10/hour global + 5-min per-session cooldown. |
| **Admission Control** | A-MAC-style gating on the write path. Scores candidates on utility, novelty, recency, confidence, and type priors before persistence. |
| **Lifecycle Scoring** | Weibull decay integrated into retrieval — high-frequency and high-importance memories rank higher. |
| **Tier Management** | Three-tier system (Core → Working → Peripheral) with automatic promotion/demotion. |
| **6-Dimension Consolidation** | Combines access patterns, confirmed use, contradiction penalties — compensating for LLM one-time importance scoring gaps. |
| **Dynamic Confidence** | Real-time confidence adjustment per recall outcome: confirmed use boosts, contradictions penalize, long-term non-use decays. |
| **3-Tier Background Pipeline** | Sweep (every start) → Consolidate (24h) → Compact (24h), fully automated background processing. |
| **Memory Health Monitor** | Composite health metric; auto-recovers high-value archived memories when health drops below threshold. |
| **Adaptive Recall** | `recallMode: "adaptive"` analyzes query intent to auto-select category and recall depth. |
| **Session Compression** | Scores conversation texts before extraction, prioritizing corrections, decisions, and tool calls. |
| **USER.md Boundary** | Route profile/canonical facts to USER.md only, keeping LanceDB free of agent-prompt-owned knowledge. |
| **Markdown Mirror** | Dual-write memories to human-readable Markdown alongside LanceDB storage. |
| **Advanced Debugging** | `memory_debug`, `memory_explain_rank` tools for retrieval diagnostics and rank explanation. |
| **OAuth LLM Access** | `llm.auth: "oauth"` mode reuses existing ChatGPT/Codex login cache for extraction — no extra API key needed. |
| **Metadata Repair** | `memory-pro repair-summaries` CLI command fixes L0/L1/L2 summaries inconsistent with text. |

**Benchmark results**: When importance (LLM one-time score) doesn't correlate with actual usage, consolidation scoring achieves 100% precision@K (baseline: 0%), eliminates 46pp of noise, with 98%+ tier classification accuracy.

Feedback: [GitHub Issues](https://github.com/CortexReach/memory-lancedb-pro/issues) · Revert: `npm i memory-lancedb-pro@latest`

---

## Dependencies

| Package | Purpose |
| --- | --- |
| `@lancedb/lancedb` ≥0.26.2 | Vector database (ANN + FTS) |
| `openai` ≥6.21.0 | OpenAI-compatible Embedding API client |
| `@sinclair/typebox` 0.34.48 | JSON Schema type definitions |

---

## Contributors

<p>
<a href="https://github.com/win4r"><img src="https://avatars.githubusercontent.com/u/42172631?v=4" width="48" height="48" alt="@win4r" /></a>
<a href="https://github.com/kctony"><img src="https://avatars.githubusercontent.com/u/1731141?v=4" width="48" height="48" alt="@kctony" /></a>
<a href="https://github.com/Akatsuki-Ryu"><img src="https://avatars.githubusercontent.com/u/8062209?v=4" width="48" height="48" alt="@Akatsuki-Ryu" /></a>
<a href="https://github.com/JasonSuz"><img src="https://avatars.githubusercontent.com/u/612256?v=4" width="48" height="48" alt="@JasonSuz" /></a>
<a href="https://github.com/Minidoracat"><img src="https://avatars.githubusercontent.com/u/11269639?v=4" width="48" height="48" alt="@Minidoracat" /></a>
<a href="https://github.com/furedericca-lab"><img src="https://avatars.githubusercontent.com/u/263020793?v=4" width="48" height="48" alt="@furedericca-lab" /></a>
<a href="https://github.com/joe2643"><img src="https://avatars.githubusercontent.com/u/19421931?v=4" width="48" height="48" alt="@joe2643" /></a>
<a href="https://github.com/AliceLJY"><img src="https://avatars.githubusercontent.com/u/136287420?v=4" width="48" height="48" alt="@AliceLJY" /></a>
<a href="https://github.com/chenjiyong"><img src="https://avatars.githubusercontent.com/u/8199522?v=4" width="48" height="48" alt="@chenjiyong" /></a>
</p>

Full list: [Contributors](https://github.com/CortexReach/memory-lancedb-pro/graphs/contributors)

## Star History

<a href="https://star-history.com/#CortexReach/memory-lancedb-pro&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=CortexReach/memory-lancedb-pro&type=Date&theme=dark&transparent=true" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=CortexReach/memory-lancedb-pro&type=Date&transparent=true" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=CortexReach/memory-lancedb-pro&type=Date&transparent=true" />
  </picture>
</a>

## License

MIT

---

## My WeChat QR Code

<img src="https://github.com/win4r/AISuperDomain/assets/42172631/7568cf78-c8ba-4182-aa96-d524d903f2bc" width="214.8" height="291">
