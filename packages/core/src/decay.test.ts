import { describe, expect, it } from "vitest";
import { STALE_THRESHOLD, effectiveConfidence } from "./decay.js";

const DAY = 86_400_000;
const now = new Date("2026-01-31T00:00:00Z");
const daysAgo = (d: number): Date => new Date(now.getTime() - d * DAY);

const item = (over: Partial<Parameters<typeof effectiveConfidence>[0]> = {}) => ({
  baseConfidence: 1,
  decayRate: 0.1,
  retrievalCount: 0,
  lastVerifiedAt: now,
  ...over,
});

describe("effectiveConfidence", () => {
  it("returns baseConfidence at age 0", () => {
    expect(effectiveConfidence(item({ baseConfidence: 0.8 }), now)).toBe(0.8);
  });

  it("returns baseConfidence when lastVerifiedAt is in the future", () => {
    expect(effectiveConfidence(item({ baseConfidence: 0.7, lastVerifiedAt: daysAgo(-3) }), now)).toBe(0.7);
  });

  it("follows base * exp(-decayRate * ageDays) with no reinforcement", () => {
    const eff = effectiveConfidence(item({ lastVerifiedAt: daysAgo(10) }), now);
    expect(eff).toBeCloseTo(Math.exp(-1), 10);
  });

  it("scales with baseConfidence", () => {
    const eff = effectiveConfidence(item({ baseConfidence: 0.5, lastVerifiedAt: daysAgo(10) }), now);
    expect(eff).toBeCloseTo(0.5 * Math.exp(-1), 10);
  });

  it("divides the decay rate by 1 + ln(1 + retrievalCount)", () => {
    const eff = effectiveConfidence(item({ retrievalCount: 9, lastVerifiedAt: daysAgo(10) }), now);
    const lambdaEff = 0.1 / (1 + Math.log1p(9));
    expect(eff).toBeCloseTo(Math.exp(-lambdaEff * 10), 10);
  });

  it("decays slower the more an item has been retrieved", () => {
    const cold = effectiveConfidence(item({ retrievalCount: 0, lastVerifiedAt: daysAgo(30) }), now);
    const warm = effectiveConfidence(item({ retrievalCount: 10, lastVerifiedAt: daysAgo(30) }), now);
    const hot = effectiveConfidence(item({ retrievalCount: 1000, lastVerifiedAt: daysAgo(30) }), now);
    expect(warm).toBeGreaterThan(cold);
    expect(hot).toBeGreaterThan(warm);
    expect(hot).toBeLessThan(1);
  });

  it("treats a negative retrievalCount as zero", () => {
    const a = effectiveConfidence(item({ retrievalCount: -5, lastVerifiedAt: daysAgo(10) }), now);
    const b = effectiveConfidence(item({ retrievalCount: 0, lastVerifiedAt: daysAgo(10) }), now);
    expect(a).toBe(b);
  });

  it("is monotonically non-increasing with age", () => {
    let prev = Infinity;
    for (const d of [0, 1, 7, 30, 180, 365]) {
      const eff = effectiveConfidence(item({ lastVerifiedAt: daysAgo(d) }), now);
      expect(eff).toBeLessThanOrEqual(prev);
      prev = eff;
    }
  });
});

describe("STALE_THRESHOLD", () => {
  it("is 0.4", () => {
    expect(STALE_THRESHOLD).toBe(0.4);
  });

  it("is crossed by the default 0.02/day rate after ~46 days unretrieved", () => {
    // ln(0.4) / -0.02 ≈ 45.8 days
    const before = effectiveConfidence(item({ decayRate: 0.02, lastVerifiedAt: daysAgo(45) }), now);
    const after = effectiveConfidence(item({ decayRate: 0.02, lastVerifiedAt: daysAgo(46) }), now);
    expect(before).toBeGreaterThanOrEqual(STALE_THRESHOLD);
    expect(after).toBeLessThan(STALE_THRESHOLD);
  });
});
