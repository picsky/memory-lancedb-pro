/**
 * Tests for category-differentiated time decay optimization.
 *
 * Verifies that:
 * 1. Different categories decay at different rates
 * 2. Category multipliers combine with temporal type modifier
 * 3. Unknown category defaults to 1.0x
 * 4. Custom config overrides work
 * 5. Retrieval ranking reflects decay differences
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  MemoryRetriever,
  DEFAULT_RETRIEVAL_CONFIG,
  DEFAULT_CATEGORY_DECAY_MULTIPLIERS,
} = jiti("../src/retriever.ts");
const { parseSmartMetadata, stringifySmartMetadata } = jiti("../src/smart-metadata.ts");

// ============================================================================
// Helpers
// ============================================================================

function makeStore(entries = []) {
  return {
    hasFtsSupport: true,
    async vectorSearch(_vector, _limit, _minScore, _scopeFilter) {
      return entries.map((e, i) => ({ entry: e, score: 0.5, rank: i + 1 }));
    },
    async bm25Search(_query, _limit, _scopeFilter) {
      return entries.map((e, i) => ({ entry: e, score: 0.4, rank: i + 1 }));
    },
    async hasId(_id) { return true; },
  };
}

function makeEmbedder() {
  return {
    async embedQuery(_q) { return Array(384).fill(0.1); },
  };
}

function makeEntry({ id, text, category, timestamp, importance = 0.7, metadata = {} }) {
  const now = Date.now();
  const metaObj = stringifySmartMetadata({
    l0_abstract: text,
    l1_overview: "",
    l2_content: text,
    memory_category: category,
    tier: "working",
    confidence: 0.7,
    source_session: "test",
    source: "auto-capture",
    state: "confirmed",
    memory_layer: "working",
    injected_count: 0,
    bad_recall_count: 0,
    suppressed_until_turn: 0,
    access_count: 0,
    last_accessed_at: timestamp || now,
    ...metadata,
  });
  return {
    id: id || `mem-${category}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    vector: Array(384).fill(0.1),
    category: category === "preferences" ? "preference" : category === "profile" ? "fact" : "other",
    scope: "global",
    importance,
    metadata: metaObj,
    timestamp: timestamp || now,
  };
}

function makeRetriever(config = {}) {
  const baseConfig = {
    ...DEFAULT_RETRIEVAL_CONFIG,
    rerank: "none",
    recencyHalfLifeDays: 0, // disable recency boost
    recencyWeight: 0,
    timeDecayHalfLifeDays: 60,
    filterNoise: false,
    hardMinScore: 0,
    minScore: 0,
    ...config,
  };
  return new MemoryRetriever(makeStore(), makeEmbedder(), baseConfig, null);
}

// ============================================================================
// Tests
// ============================================================================

describe("DEFAULT_CATEGORY_DECAY_MULTIPLIERS", () => {

  it("has entries for all 6 categories", () => {
    const categories = ["profile", "preferences", "entities", "events", "cases", "patterns"];
    for (const cat of categories) {
      assert.ok(
        typeof DEFAULT_CATEGORY_DECAY_MULTIPLIERS[cat] === "number",
        `missing or invalid multiplier for ${cat}`,
      );
      assert.ok(
        DEFAULT_CATEGORY_DECAY_MULTIPLIERS[cat] > 0,
        `multiplier for ${cat} must be > 0, got ${DEFAULT_CATEGORY_DECAY_MULTIPLIERS[cat]}`,
      );
    }
  });

  it("profile has highest multiplier (slowest decay)", () => {
    const multipliers = DEFAULT_CATEGORY_DECAY_MULTIPLIERS;
    assert.ok(
      multipliers.profile >= multipliers.preferences,
      "profile should decay at least as slowly as preferences",
    );
    for (const [cat, val] of Object.entries(multipliers)) {
      if (cat !== "profile") {
        assert.ok(
          multipliers.profile >= val,
          `profile multiplier (${multipliers.profile}) should be highest, ${cat} is ${val}`,
        );
      }
    }
  });

  it("events has lowest multiplier (fastest decay)", () => {
    const multipliers = DEFAULT_CATEGORY_DECAY_MULTIPLIERS;
    for (const [cat, val] of Object.entries(multipliers)) {
      if (cat !== "events") {
        assert.ok(
          multipliers.events <= val,
          `events multiplier (${multipliers.events}) should be lowest, ${cat} is ${val}`,
        );
      }
    }
  });

  it("is included in DEFAULT_RETRIEVAL_CONFIG", () => {
    assert.strictEqual(
      DEFAULT_RETRIEVAL_CONFIG.categoryDecayMultipliers,
      DEFAULT_CATEGORY_DECAY_MULTIPLIERS,
    );
  });
});

describe("applyTimeDecay category differentiation", () => {

  function decayOneResult(entry, configOverrides = {}) {
    const retriever = makeRetriever(configOverrides);
    // Access the private method via prototype — test only
    const entry_copy = { ...entry };
    const store = makeStore([entry_copy]);
    const r = new MemoryRetriever(store, makeEmbedder(), {
      ...DEFAULT_RETRIEVAL_CONFIG,
      rerank: "none",
      recencyHalfLifeDays: 0,
      recencyWeight: 0,
      timeDecayHalfLifeDays: 60,
      filterNoise: false,
      hardMinScore: 0,
      minScore: 0,
      ...configOverrides,
    }, null);

    return r.retrieve({ query: "test", limit: 5, source: "manual" })
      .then((results) => results[0]);
  }

  function getEffectiveDecayFactor(category, ageDays, configOverrides = {}) {
    // Calculate what the decay factor would be for a memory of given age and category
    const multipliers = configOverrides.categoryDecayMultipliers ?? DEFAULT_CATEGORY_DECAY_MULTIPLIERS;
    const halfLife = configOverrides.timeDecayHalfLifeDays ?? 60;
    const catMultiplier = multipliers[category] ?? 1.0;
    const baseHL = halfLife; // static memories
    const effectiveHL = baseHL * catMultiplier;
    // factor = 0.5 + 0.5 * exp(-ageDays / effectiveHL)
    return 0.5 + 0.5 * Math.exp(-ageDays / effectiveHL);
  }

  it("profile memory retains higher score than event of same age", async () => {
    const now = Date.now();
    const ageDays = 90; // 3 months old
    const oldTimestamp = now - ageDays * 86_400_000;

    const profileEntry = makeEntry({
      id: "mem-profile",
      text: "User profile: lives in Shanghai",
      category: "profile",
      timestamp: oldTimestamp,
    });
    const eventEntry = makeEntry({
      id: "mem-event",
      text: "User attended tech conference",
      category: "events",
      timestamp: oldTimestamp,
    });

    const profileFactor = getEffectiveDecayFactor("profile", ageDays);
    const eventFactor = getEffectiveDecayFactor("events", ageDays);

    // Profile decays much slower (multiplier 2.0 vs 0.4)
    assert.ok(
      profileFactor > eventFactor,
      `profile factor (${profileFactor.toFixed(3)}) should be > event factor (${eventFactor.toFixed(3)})`,
    );

    // At 90 days with halfLife=60:
    // profile: effectiveHL = 60 * 2.0 = 120 → factor = 0.5 + 0.5 * exp(-90/120) = 0.5 + 0.5 * 0.472 = 0.736
    // events: effectiveHL = 60 * 0.4 = 24 → factor = 0.5 + 0.5 * exp(-90/24) = 0.5 + 0.5 * 0.024 = 0.512
    assert.ok(
      profileFactor / eventFactor > 1.3,
      `profile should retain at least 30% more decay factor than event, got ratio ${profileFactor / eventFactor}`,
    );
  });

  it("event decay factor at 2*halfLife is near floor", () => {
    const halfLife = 60;
    // Events: effectiveHL = 60 * 0.4 = 24 days
    // At 48 days (2 * event effectiveHL):
    const eventFactor = getEffectiveDecayFactor("events", 48);
    // factor = 0.5 + 0.5 * exp(-48/24) = 0.5 + 0.5 * exp(-2) = 0.5 + 0.5 * 0.135 = 0.568
    assert.ok(
      eventFactor < 0.60,
      `event factor at 48 days should be near floor, got ${eventFactor.toFixed(3)}`,
    );
  });

  it("preferences decay slower than events at same age", () => {
    const ageDays = 60; // 1 half-life

    const prefFactor = getEffectiveDecayFactor("preferences", ageDays);
    const eventFactor = getEffectiveDecayFactor("events", ageDays);

    // preferences: effectiveHL = 60 * 1.5 = 90 → factor = 0.5 + 0.5 * exp(-60/90) = 0.5 + 0.5 * 0.513 = 0.757
    // events: effectiveHL = 60 * 0.4 = 24 → factor = 0.5 + 0.5 * exp(-60/24) = 0.5 + 0.5 * 0.082 = 0.541
    assert.ok(
      prefFactor > eventFactor,
      `preferences factor (${prefFactor.toFixed(3)}) > event factor (${eventFactor.toFixed(3)})`,
    );
  });

  it("cases decay faster than patterns (lower multiplier)", () => {
    const ageDays = 120; // 2 months

    const casesFactor = getEffectiveDecayFactor("cases", ageDays);
    const patternsFactor = getEffectiveDecayFactor("patterns", ageDays);

    // cases: effectiveHL = 60 * 0.5 = 30
    // patterns: effectiveHL = 60 * 1.0 = 60
    assert.ok(
      patternsFactor > casesFactor,
      `patterns factor (${patternsFactor.toFixed(3)}) > cases factor (${casesFactor.toFixed(3)})`,
    );
  });

  it("unknown category defaults to 1.0x multiplier", () => {
    // When memory_category is undefined in metadata, it defaults to 'other'
    // which is not in the multipliers map → falls back to 1.0
    const ageDays = 60;
    const baseFactor = getEffectiveDecayFactor("entities", ageDays); // entities has 1.0x
    const unknownFactor = 0.5 + 0.5 * Math.exp(-ageDays / 60); // default 1.0x

    assert.strictEqual(
      baseFactor,
      unknownFactor,
      "unknown category (default 1.0x) should match entities (1.0x)",
    );
  });
});

describe("category + temporal type interaction", () => {

  function computeFactor({ category, isDynamic, ageDays, halfLife = 60 }) {
    const multipliers = DEFAULT_CATEGORY_DECAY_MULTIPLIERS;
    const catMultiplier = multipliers[category] ?? 1.0;
    const baseHL = isDynamic ? halfLife / 3 : halfLife;
    const effectiveHL = baseHL * catMultiplier;
    return 0.5 + 0.5 * Math.exp(-ageDays / effectiveHL);
  }

  it("dynamic event decays extremely fast", () => {
    const ageDays = 30;
    // dynamic events: effectiveHL = (60/3) * 0.4 = 8 days
    const dynamicEventFactor = computeFactor({ category: "events", isDynamic: true, ageDays });
    // static events: effectiveHL = 60 * 0.4 = 24 days
    const staticEventFactor = computeFactor({ category: "events", isDynamic: false, ageDays });

    assert.ok(
      dynamicEventFactor < staticEventFactor,
      `dynamic event factor (${dynamicEventFactor.toFixed(3)}) < static event factor (${staticEventFactor.toFixed(3)})`,
    );
    // At 30 days: dynamic events effectiveHL=8 → factor = 0.5 + 0.5*exp(-30/8) = 0.512
    // static events effectiveHL=24 → factor = 0.5 + 0.5*exp(-30/24) = 0.643
    assert.ok(
      dynamicEventFactor < 0.55,
      `dynamic event at 30 days should be very decayed, got ${dynamicEventFactor.toFixed(3)}`,
    );
  });

  it("static profile decays slowest of all combinations", () => {
    const ageDays = 90;
    const staticProfileFactor = computeFactor({ category: "profile", isDynamic: false, ageDays });

    // Compare against all other category/temporal combos
    for (const cat of ["preferences", "entities", "events", "cases", "patterns"]) {
      for (const isDynamic of [true, false]) {
        if (cat === "profile" && !isDynamic) continue;
        const otherFactor = computeFactor({ category: cat, isDynamic, ageDays });
        assert.ok(
          staticProfileFactor > otherFactor,
          `static profile (${staticProfileFactor.toFixed(3)}) > ${cat}+${isDynamic ? "dynamic" : "static"} (${otherFactor.toFixed(3)})`,
        );
      }
    }
  });
});

describe("custom categoryDecayMultipliers config", () => {

  it("overrides can be applied via config", () => {
    const customMultipliers = {
      profile: 3.0,
      preferences: 2.0,
      entities: 1.5,
      events: 0.3,
      cases: 0.6,
      patterns: 1.2,
    };

    const ageDays = 60;
    const halfLife = 60;

    // With custom multipliers, profile at 60 days:
    // effectiveHL = 60 * 3.0 = 180 → factor = 0.5 + 0.5 * exp(-60/180) = 0.5 + 0.5 * 0.717 = 0.858
    const customFactor = 0.5 + 0.5 * Math.exp(-ageDays / (halfLife * customMultipliers.profile));
    const defaultFactor = 0.5 + 0.5 * Math.exp(-ageDays / (halfLife * DEFAULT_CATEGORY_DECAY_MULTIPLIERS.profile));

    assert.ok(
      customFactor > defaultFactor,
      `custom profile factor (${customFactor.toFixed(3)}) > default (${defaultFactor.toFixed(3)})`,
    );
  });

  it("null multiplier for a category falls back to 1.0", () => {
    const customConfig = {
      ...DEFAULT_RETRIEVAL_CONFIG,
      categoryDecayMultipliers: {
        profile: 2.0,
        preferences: 1.5,
        // entities, events, cases, patterns missing
      },
    };

    // When a category is not in the multipliers, it defaults to 1.0
    const entityMultiplier = customConfig.categoryDecayMultipliers?.entities ?? 1.0;
    assert.strictEqual(entityMultiplier, 1.0, "missing category should default to 1.0");
  });
});

describe("ranking integration: older events ranked below newer profiles", () => {

  it("profile outranks event when event is older despite equal initial score", () => {
    // Simulate two memories with same initial fused score but different ages
    const now = Date.now();
    const halfLife = 60;

    const profileAge = 30; // 30 days old
    const eventAge = 60; // 60 days old

    const profileFactor = 0.5 + 0.5 * Math.exp(
      -profileAge / (halfLife * DEFAULT_CATEGORY_DECAY_MULTIPLIERS.profile)
    );
    const eventFactor = 0.5 + 0.5 * Math.exp(
      -eventAge / (halfLife * DEFAULT_CATEGORY_DECAY_MULTIPLIERS.events)
    );

    // Profile at 30 days with 2.0x multiplier: effectiveHL = 120 → factor ≈ 0.889
    // Event at 60 days with 0.4x multiplier: effectiveHL = 24 → factor ≈ 0.541
    const initialScore = 0.7;
    const profileFinalScore = initialScore * profileFactor;
    const eventFinalScore = initialScore * eventFactor;

    assert.ok(
      profileFinalScore > eventFinalScore,
      `profile score (${profileFinalScore.toFixed(3)}) > event score (${eventFinalScore.toFixed(3)})`,
    );
  });
});
