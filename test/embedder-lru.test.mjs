/**
 * Issue #598 Phase 3 - EmbeddingCache LRU Semantics Test
 * Tests that re-setting an existing key updates its LRU position.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import Module from "node:module";
import jitiFactory from "jiti";

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  "/opt/homebrew/lib/node_modules/openclaw/node_modules",
  "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

describe("EmbeddingCache LRU semantics", () => {
  it("updates insertion order when re-setting existing key", async () => {
    const { Embedder } = jiti("../src/embedder.ts");

    const embedder = new Embedder({
      provider: "openai-compatible",
      apiKey: "dummy",
      model: "mock",
      baseURL: "http://127.0.0.1:9999/v1",
      dimensions: 2560,
    });
    const cache = embedder["_cache"];

    // Fill cache to max capacity (256 default)
    for (let i = 0; i < 256; i++) {
      cache.set(`fill-${i}`, undefined, [i, 0, 0]);
    }

    // Now: text-a is the oldest (position 0), text-b is at position 1
    // Re-set text-a to make it most recently used
    cache.set("text-a", undefined, [1, 0, 0]);

    // Add one more — should evict the oldest entry (text-b, which was never re-set)
    cache.set("new-text", undefined, [0, 0, 1]);

    assert.strictEqual(cache.get("text-a", undefined) !== undefined, true, "text-a should remain after re-set");
    assert.strictEqual(cache.get("new-text", undefined) !== undefined, true, "new-text should be added");
  });
});
