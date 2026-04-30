import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const {
  computeConfidenceUpdate,
  buildUpdatedMetadataWithConfidence,
  parseAccessMetadata,
  buildUpdatedMetadata,
} = jiti("../src/access-tracker.ts");

// ============================================================================
// computeConfidenceUpdate
// ============================================================================

describe("computeConfidenceUpdate", () => {
  const now = Date.now();
  const createdAt = now - 60 * 24 * 60 * 60 * 1000; // 60 days ago

  it("returns a value in [0.1, 1]", () => {
    const result = computeConfidenceUpdate(0.7, 0, 0, now, createdAt, now);
    assert.ok(result >= 0.1 && result <= 1, `confidence = ${result}`);
  });

  it("bad recall reduces confidence", () => {
    const clean = computeConfidenceUpdate(0.7, 0, 0, now, createdAt, now);
    const dirty = computeConfidenceUpdate(0.7, 3, 0, now, createdAt, now);
    assert.ok(dirty < clean, `clean=${clean}, dirty=${dirty}`);
  });

  it("confidence penalty scales with bad recall count", () => {
    const b0 = computeConfidenceUpdate(0.7, 0, 0, now, createdAt, now);
    const b1 = computeConfidenceUpdate(0.7, 1, 0, now, createdAt, now);
    const b3 = computeConfidenceUpdate(0.7, 3, 0, now, createdAt, now);
    const b10 = computeConfidenceUpdate(0.7, 10, 0, now, createdAt, now);
    assert.ok(b0 > b1 && b1 > b3 && b3 > b10, "penalty should scale monotonically");
  });

  it("confidence penalty is capped", () => {
    const result = computeConfidenceUpdate(0.7, 100, 0, now, createdAt, now);
    // Max penalty is 0.5, so with 0.7 start + small non-use decay, should be > 0.1
    assert.ok(result > 0.1, `confidence = ${result}`);
  });

  it("confirmed use provides a small boost", () => {
    const never = computeConfidenceUpdate(0.7, 0, 0, now, createdAt, now);
    const confirmed = computeConfidenceUpdate(0.7, 0, now, now, createdAt, now);
    assert.ok(confirmed > never, `never=${never}, confirmed=${confirmed}`);
  });

  it("long-term non-use causes slow decay", () => {
    const active = computeConfidenceUpdate(0.7, 0, now, now, createdAt, now);
    const inactive = computeConfidenceUpdate(
      0.7, 0, 0, now - 90 * 24 * 60 * 60 * 1000, createdAt, now,
    );
    assert.ok(inactive < active, `active=${active}, inactive=${inactive}`);
  });

  it("no decay for memories younger than 30 days", () => {
    const recentCreated = now - 10 * 24 * 60 * 60 * 1000; // 10 days ago
    const result = computeConfidenceUpdate(0.7, 0, 0, now, recentCreated, now);
    // Should be close to original minus any bad recall penalty (none here)
    assert.ok(result >= 0.65, `confidence = ${result}`);
  });

  it("never drops below minimum floor", () => {
    const result = computeConfidenceUpdate(0.1, 100, 0, now - 365 * 24 * 60 * 60 * 1000, now - 365 * 24 * 60 * 60 * 1000, now);
    assert.ok(result >= 0.1, `confidence = ${result}`);
  });

  it("never exceeds 1.0", () => {
    const result = computeConfidenceUpdate(1.0, 0, now, now, createdAt, now);
    assert.ok(result <= 1.0, `confidence = ${result}`);
  });

  it("handles non-finite input gracefully", () => {
    const result = computeConfidenceUpdate(NaN, 0, 0, now, createdAt, now);
    assert.ok(Number.isFinite(result) && result >= 0.1);
  });
});

// ============================================================================
// buildUpdatedMetadataWithConfidence
// ============================================================================

describe("buildUpdatedMetadataWithConfidence", () => {
  it("includes updated confidence in metadata", () => {
    const base = buildUpdatedMetadata(undefined, 1);
    const result = buildUpdatedMetadataWithConfidence(undefined, 1, { confirmed: true });
    const parsed = JSON.parse(result);
    assert.ok(typeof parsed.confidence === "number");
    assert.ok(parsed.confidence > 0 && parsed.confidence <= 1);
  });

  it("tracks confirmed use timestamp", () => {
    const now = Date.now();
    const result = buildUpdatedMetadataWithConfidence(undefined, 1, { confirmed: true }, now);
    const parsed = JSON.parse(result);
    assert.equal(parsed.last_confirmed_use_at, now);
  });

  it("increments bad_recall_count on contradiction", () => {
    const baseMeta = JSON.stringify({ bad_recall_count: 2 });
    const result = buildUpdatedMetadataWithConfidence(baseMeta, 1, { contradicted: true });
    const parsed = JSON.parse(result);
    assert.equal(parsed.bad_recall_count, 3);
  });

  it("preserves existing metadata fields", () => {
    const existing = JSON.stringify({
      l0_abstract: "test",
      tier: "working",
      access_count: 5,
      confidence: 0.8,
    });
    const result = buildUpdatedMetadataWithConfidence(existing, 1);
    const parsed = JSON.parse(result);
    assert.equal(parsed.l0_abstract, "test");
    assert.equal(parsed.tier, "working");
  });
});

// ============================================================================
// Existing functions still work (regression check)
// ============================================================================

describe("parseAccessMetadata / buildUpdatedMetadata (regression)", () => {
  it("parseAccessMetadata returns zeros for undefined", () => {
    const result = parseAccessMetadata(undefined);
    assert.equal(result.accessCount, 0);
    assert.equal(result.lastAccessedAt, 0);
  });

  it("buildUpdatedMetadata increments count", () => {
    const result = buildUpdatedMetadata(undefined, 3);
    const parsed = JSON.parse(result);
    assert.equal(parsed.accessCount, 3);
    assert.ok(typeof parsed.lastAccessedAt === "number");
  });

  it("buildUpdatedMetadata preserves existing fields", () => {
    const existing = JSON.stringify({ tier: "working", confidence: 0.8 });
    const result = buildUpdatedMetadata(existing, 1);
    const parsed = JSON.parse(result);
    assert.equal(parsed.tier, "working");
    assert.equal(parsed.confidence, 0.8);
    assert.equal(parsed.accessCount, 1);
  });
});
