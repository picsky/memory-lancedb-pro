---
name: memory-pro
description: Help configure, install, or troubleshoot the memory-lancedb-pro plugin for OpenClaw. Use when the user asks to set up memory, configure the memory plugin, enable auto-capture/auto-recall, pick an embedding provider, or fix memory-related errors. Also triggered by /memory-pro.
metadata: { "openclaw": { "requires": { "config": ["plugins.entries.memory-lancedb-pro.enabled"] } } }
---

# memory-lancedb-pro Deployment & Configuration

When the user wants to set up, configure, or fix the memory-lancedb-pro plugin, follow this workflow.

## Step 1 — Assess Current State

Read the user's `openclaw.json` (or ask for it) and determine:

1. **Is the plugin installed?**
   - Check `plugins.slots.memory` — should be `"memory-lancedb-pro"`
   - Check `plugins.entries["memory-lancedb-pro"]` — should exist with `enabled: true`
   - If not installed, guide them to run: `openclaw plugins install memory-lancedb-pro@beta`

2. **What embedding provider are they using?**
   - Check `plugins.entries.memory-lancedb-pro.config.embedding.model`
   - If absent, ask them which provider they want (see Step 2)

3. **What's currently working vs broken?**
   - If the user reports an error, go to [Troubleshooting](#troubleshooting) first

## Step 2 — Provider Selection

Ask the user which embedding provider they want to use. Present these options:

| Provider | Model | API Cost | Base URL |
|---|---|---|---|
| **Jina** (recommended) | `jina-embeddings-v5-text-small` | ~$0.01/M tokens | `https://api.jina.ai/v1` |
| **OpenAI** | `text-embedding-3-small` | ~$0.02/M tokens | `https://api.openai.com/v1` |
| **SiliconFlow** | `BAAI/bge-m3` | Free tier available | `https://api.siliconflow.cn/v1` |
| **Ollama** (local) | `nomic-embed-text` | Free (local) | `http://localhost:11434/v1` |
| **Google Gemini** | `gemini-embedding-001` | Free tier available | `https://generativelanguage.googleapis.com/v1beta/openai/` |
| **NVIDIA NIM** | `nvidia/nv-embedqa-e5-v5` | Free tier available | `https://integrate.api.nvidia.com/v1` |

For each provider, you also need to know:
- **API key** (or env var name like `${JINA_API_KEY}`)
- **Dimensions** (auto-detected for known models, but specify for custom ones)

## Step 3 — Choose a Deployment Plan

Present the user with 4 deployment plans. Each plan is a complete config that works out of the box.

### Plan A: Full Power (Jina + OpenAI)

Best retrieval quality. Jina for embedding + Jina reranker + OpenAI for smart extraction.

```json
{
  "embedding": {
    "provider": "openai-compatible",
    "apiKey": "${JINA_API_KEY}",
    "model": "jina-embeddings-v5-text-small",
    "baseURL": "https://api.jina.ai/v1",
    "dimensions": 1024,
    "taskQuery": "retrieval.query",
    "taskPassage": "retrieval.passage",
    "normalized": true
  },
  "autoCapture": true,
  "autoRecall": true,
  "recallMode": "full",
  "smartExtraction": true,
  "llm": {
    "apiKey": "${OPENAI_API_KEY}",
    "model": "gpt-4o-mini",
    "baseURL": "https://api.openai.com/v1"
  },
  "extractMinMessages": 4,
  "extractMaxChars": 8000,
  "extractionThrottle": {
    "maxExtractionsPerHour": 10
  },
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
    "hardMinScore": 0.35
  },
  "sessionStrategy": "none"
}
```

**APIs needed**: Jina (embedding + reranker), OpenAI (LLM)

### Plan B: Budget (SiliconFlow reranker)

Free reranker tier. OpenAI embedding + SiliconFlow reranker + OpenAI LLM.

```json
{
  "embedding": {
    "provider": "openai-compatible",
    "apiKey": "${OPENAI_API_KEY}",
    "model": "text-embedding-3-small",
    "baseURL": "https://api.openai.com/v1",
    "dimensions": 1536
  },
  "autoCapture": true,
  "autoRecall": true,
  "smartExtraction": true,
  "llm": {
    "apiKey": "${OPENAI_API_KEY}",
    "model": "gpt-4o-mini",
    "baseURL": "https://api.openai.com/v1"
  },
  "extractMinMessages": 4,
  "extractMaxChars": 8000,
  "extractionThrottle": {
    "maxExtractionsPerHour": 10
  },
  "retrieval": {
    "mode": "hybrid",
    "rerank": "cross-encoder",
    "rerankApiKey": "${SILICONFLOW_API_KEY}",
    "rerankModel": "BAAI/bge-reranker-v2-m3",
    "rerankEndpoint": "https://api.siliconflow.cn/v1/rerank",
    "rerankProvider": "siliconflow",
    "candidatePoolSize": 20,
    "hardMinScore": 0.35
  },
  "sessionStrategy": "none"
}
```

**APIs needed**: OpenAI (embedding + LLM), SiliconFlow (reranker, free tier)

### Plan C: Simple (OpenAI only, no reranker)

One API key does everything. Good for getting started quickly.

```json
{
  "embedding": {
    "provider": "openai-compatible",
    "apiKey": "${OPENAI_API_KEY}",
    "model": "text-embedding-3-small",
    "baseURL": "https://api.openai.com/v1",
    "dimensions": 1536
  },
  "autoCapture": true,
  "autoRecall": true,
  "smartExtraction": true,
  "llm": {
    "apiKey": "${OPENAI_API_KEY}",
    "model": "gpt-4o-mini",
    "baseURL": "https://api.openai.com/v1"
  },
  "extractMinMessages": 4,
  "extractMaxChars": 8000,
  "extractionThrottle": {
    "maxExtractionsPerHour": 10
  },
  "retrieval": {
    "mode": "hybrid",
    "rerank": "lightweight",
    "hardMinScore": 0.35
  },
  "sessionStrategy": "none"
}
```

**APIs needed**: OpenAI only (embedding + reranker-lite + LLM all use same key)

### Plan D: Fully Local (Ollama, zero API cost)

Everything runs locally. Good for privacy, but slower and lower quality.

```json
{
  "embedding": {
    "provider": "openai-compatible",
    "apiKey": "ollama",
    "model": "nomic-embed-text",
    "baseURL": "http://localhost:11434/v1"
  },
  "autoCapture": true,
  "autoRecall": true,
  "smartExtraction": true,
  "llm": {
    "apiKey": "ollama",
    "model": "llama3.1",
    "baseURL": "http://localhost:11434/v1"
  },
  "extractMinMessages": 4,
  "extractMaxChars": 8000,
  "extractionThrottle": {
    "maxExtractionsPerHour": 10
  },
  "retrieval": {
    "mode": "hybrid",
    "rerank": "none",
    "hardMinScore": 0.3
  },
  "sessionStrategy": "none"
}
```

**APIs needed**: None (Ollama must be running locally on port 11434)

## Step 4 — Feature Selection

Ask the user which optional features they want to enable:

| Feature | Default | Recommendation |
|---|---|---|
| **autoRecall** | `false` | `true` — this is the main value prop |
| **smartExtraction** | `true` | Keep `true` if you have an LLM API key |
| **sessionMemory** | `none` | `none` for day one; enable later if needed |
| **memoryConsolidation** | `false` | Enable after you have 50+ memories |
| **memoryCompaction** | `false` | Enable after you have 100+ memories |
| **enableManagementTools** | `false` | Enable if you want `memory_stats`, `memory_list` tools |
| **mdMirror** | `false` | Enable if you want human-readable markdown copies |
| **admissionControl** | `false` | Enable if you want A-MAC gating on writes |
| **sessionCompression** | `false` | Enable if conversations are long and noisy |

## Step 5 — Generate Config

Apply these rules when generating the config:

### Critical Rules

1. **`embedding` is required** — the plugin will crash without it
2. **`autoRecall` defaults to `false`** — you MUST explicitly set it to `true` if the user wants auto-injection
3. **`smartExtraction` defaults to `true`** — requires `llm.apiKey` or falls back to `embedding.apiKey`
4. **`sessionMemory.enabled` is deprecated** — use `sessionStrategy` instead (`"none"`, `"systemSessionMemory"`, or `"memoryReflection"`)
5. **`additionalProperties: false`** — the schema rejects any unknown fields. Do NOT add fields that are not in the plugin's configSchema.
6. **API keys**: use `${ENV_VAR}` syntax for env vars. The parser resolves these at startup. If the env var is not set, the plugin will throw.
7. **`recallMode`**: recommend `"full"` for new users. `"summary"` is more compact. `"adaptive"` analyzes query intent.
8. **`extractMinMessages`**: default is 4. Don't set below 2 or extraction will fire on trivial exchanges.

### Config Structure

The config goes under `plugins.entries["memory-lancedb-pro"].config`:

```json
{
  "plugins": {
    "slots": { "memory": "memory-lancedb-pro" },
    "entries": {
      "memory-lancedb-pro": {
        "enabled": true,
        "config": { ... plan config from Step 3 ... }
      }
    }
  }
}
```

### Merging with Existing Config

If the user already has a partial config:
- **Do NOT overwrite** fields they've already set unless they explicitly ask
- **Only add/modify** the fields they're asking about
- Preserve their existing `scopes`, `dbPath`, and any custom settings

## Step 6 — Apply Changes

1. Read the user's `openclaw.json`
2. Merge the new plugin config
3. Write back the file
4. Validate: `openclaw config validate`
5. Restart: `openclaw gateway restart`

## Step 7 — Verify

Run these checks after restart:

```bash
openclaw plugins info memory-lancedb-pro
openclaw memory-pro stats
openclaw logs --follow --plain | grep "memory-lancedb-pro"
```

Expected output:
- `memory-lancedb-pro: smart extraction enabled`
- `memory-lancedb-pro: noise-prototype-bank: initialized with N built-in prototypes`
- Typed hooks: `agent_end`, `before_prompt_build (priority 10)`, `message_received`, `before_message_write`
- `Legacy before_agent_start: no`

## Troubleshooting

### Plugin crashes on startup

**Cause**: Missing `embedding` config or invalid `apiKey`.
**Fix**: Ensure `embedding` object exists with at least `apiKey` and `model` fields.

### Smart extraction returns zero memories

**Cause**: LLM API error, rate limit (429), or the conversation has no extractable content.
**Fix**:
- Check `llm.apiKey` is valid
- Lower `extractMinMessages` if conversations are short
- Check rate limits: `extractionThrottle.maxExtractionsPerHour` (default 10)

### Auto-recall not injecting memories

**Cause**: `autoRecall` defaults to `false`.
**Fix**: Set `"autoRecall": true` in config.

### Auto-recall times out

**Cause**: Embedding API is slow or unreachable.
**Fix**: Increase `"autoRecallTimeoutMs": 8000` (default 5000ms).

### "Cannot mix BigInt and other types"

**Cause**: LanceDB 0.26+ returns BigInt for some numeric columns.
**Fix**: Upgrade to memory-lancedb-pro >= 1.0.14 (already fixed in the plugin).

### Config validation fails

**Cause**: Unknown field in config (schema has `additionalProperties: false`).
**Fix**: Remove fields not in the plugin's configSchema. Common mistakes:
- `retrieval.queryExpansion` (not in schema, hardcoded to `true`)
- `sessionMemory.enabled` (deprecated, use `sessionStrategy`)
- Typo in field names (e.g., `autoRecal` instead of `autoRecall`)

### Memories not being captured

**Cause**: `autoCapture` is `false` or conversation too short.
**Fix**:
- Set `"autoCapture": true`
- Check `extractMinMessages` — if conversations have fewer messages, lower it
- Check `captureAssistant` — if you want assistant messages captured too, set to `true`

### jiti cache issues

**Cause**: Plugin code changed but old cached version is running.
**Fix**: `rm -rf /tmp/jiti/` then `openclaw gateway restart`

### Reranker errors

**Cause**: `rerankApiKey` not set or endpoint unreachable.
**Fix**:
- Set `"retrieval.rerankApiKey"` to a valid API key
- Check `"retrieval.rerankEndpoint"` is reachable
- If you don't want reranking, set `"retrieval.rerank": "lightweight"` or `"none"`

## Quick Reference: All Config Fields

### Top-level (plugin config)

| Field | Type | Default | Required |
|---|---|---|---|
| `embedding` | object | — | YES |
| `dbPath` | string | `~/.openclaw/memory/lancedb-pro` | no |
| `autoCapture` | boolean | `true` | no |
| `autoRecall` | boolean | `false` | no |
| `autoRecallMinLength` | int | 15 | no |
| `autoRecallMinRepeated` | int | 8 | no |
| `autoRecallTimeoutMs` | int | 5000 | no |
| `autoRecallMaxItems` | int | 3 | no |
| `autoRecallMaxChars` | int | 600 | no |
| `autoRecallPerItemMaxChars` | int | 180 | no |
| `autoRecallMaxQueryLength` | int | 2000 | no |
| `maxRecallPerTurn` | int | 10 | no |
| `recallMode` | enum | `"full"` | no |
| `autoRecallExcludeAgents` | string[] | `[]` | no |
| `autoRecallIncludeAgents` | string[] | `[]` | no |
| `captureAssistant` | boolean | `false` | no |
| `smartExtraction` | boolean | `true` | no |
| `extractMinMessages` | int | 4 | no |
| `extractMaxChars` | int | 8000 | no |
| `enableManagementTools` | boolean | `false` | no |
| `sessionStrategy` | enum | `"none"` | no |
| `retrieval` | object | see below | no |
| `llm` | object | see below | no |
| `scopes` | object | see below | no |
| `decay` | object | see below | no |
| `tier` | object | see below | no |
| `selfImprovement` | object | all `true` | no |
| `memoryReflection` | object | conditional | no |
| `admissionControl` | object | `"balanced"` preset | no |
| `memoryCompaction` | object | disabled | no |
| `memoryConsolidation` | object | disabled | no |
| `memorySweep` | object | active by default | no |
| `sessionCompression` | object | disabled | no |
| `extractionThrottle` | object | active by default | no |
| `mdMirror` | object | disabled | no |
| `workspaceBoundary` | object | disabled | no |

### embedding

| Field | Default | Notes |
|---|---|---|
| `provider` | `"openai-compatible"` | or `"azure-openai"` |
| `apiKey` | `${OPENAI_API_KEY}` | string or string[] for round-robin |
| `model` | `"text-embedding-3-small"` | |
| `baseURL` | `undefined` | omit for OpenAI default |
| `dimensions` | auto-detected | override for custom models |
| `taskQuery` | `undefined` | e.g. `"retrieval.query"` (Jina) |
| `taskPassage` | `undefined` | e.g. `"retrieval.passage"` (Jina) |
| `normalized` | `undefined` | for Jina v5 |
| `chunking` | `true` | auto-chunk long documents |

### retrieval

| Field | Default | Notes |
|---|---|---|
| `mode` | `"hybrid"` | or `"vector"` |
| `vectorWeight` | 0.7 | |
| `bm25Weight` | 0.3 | |
| `minScore` | 0.3 | |
| `rerank` | `"cross-encoder"` | `"cross-encoder"` / `"lightweight"` / `"none"` |
| `rerankApiKey` | `undefined` | required for cross-encoder |
| `rerankModel` | `"jina-reranker-v3"` | |
| `rerankEndpoint` | `https://api.jina.ai/v1/rerank` | |
| `rerankProvider` | `"jina"` | `jina` / `siliconflow` / `voyage` / `pinecone` / `dashscope` / `tei` |
| `rerankTimeoutMs` | 5000 | increase for local servers |
| `candidatePoolSize` | 20 | range 10-100 |
| `hardMinScore` | 0.35 | |
| `lengthNormAnchor` | 500 | 0 to disable |
| `recencyHalfLifeDays` | 14 | 0 to disable |
| `recencyWeight` | 0.1 | |
| `timeDecayHalfLifeDays` | 60 | 0 to disable |
| `reinforcementFactor` | 0.5 | 0 to disable |
| `maxHalfLifeMultiplier` | 3 | |
| `filterNoise` | `true` | |

### llm (for smart extraction)

| Field | Default | Notes |
|---|---|---|
| `auth` | `"api-key"` | or `"oauth"` |
| `apiKey` | falls back to `embedding.apiKey` | |
| `model` | `"openai/gpt-oss-120b"` | |
| `baseURL` | falls back to `embedding.baseURL` | |
| `oauthProvider` | `undefined` | for `auth: "oauth"` |
| `oauthPath` | `undefined` | for `auth: "oauth"` |
| `timeoutMs` | 30000 | |

### sessionStrategy values

| Value | Behavior |
|---|---|
| `"none"` | No session pipeline (recommended for day one) |
| `"systemSessionMemory"` | Save session summary on `/new` command |
| `"memoryReflection"` | LLM-powered reflection on recent conversations |
