// SPDX-License-Identifier: Apache-2.0
// FDRS-405 — pin the overhead-gate math. The orchestrator is process-driven
// and slow to exercise end-to-end; these tests cover the parts that matter
// (sample parsing, percentile picking, p99 delta) without a `pome run`.

import { describe, expect, it } from "vitest";
import {
  evaluateGate,
  median,
  p99Delta,
  p99NoiseFloor,
  parseSamples,
  percentile,
  summarize,
} from "../../scripts/overhead-stats.js";

describe("overhead-stats", () => {
  describe("parseSamples", () => {
    it("extracts OVERHEAD_BENCH_SAMPLE_MS values from agent stdout", () => {
      const stdout = [
        "OVERHEAD_BENCH_SAMPLE_MS=1.5",
        "noise line",
        "OVERHEAD_BENCH_SAMPLE_MS=2.75",
        "OVERHEAD_BENCH_DONE n=2 mode=direct",
      ].join("\n");
      expect(parseSamples(stdout)).toEqual([1.5, 2.75]);
    });

    it("ignores malformed sample lines", () => {
      const stdout = ["OVERHEAD_BENCH_SAMPLE_MS=", "OVERHEAD_BENCH_SAMPLE_MS=oops", "OVERHEAD_BENCH_SAMPLE_MS=3.14"].join("\n");
      expect(parseSamples(stdout)).toEqual([3.14]);
    });

    it("returns [] for stdout with no samples", () => {
      expect(parseSamples("hello\nworld\n")).toEqual([]);
    });
  });

  describe("percentile (nearest-rank)", () => {
    it("returns the matching element for canonical percentiles on 1..100", () => {
      const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
      // nearest-rank: ceil(p*n)-1 → p=0.5 → idx 49 → 50
      expect(percentile(sorted, 0.5)).toBe(50);
      expect(percentile(sorted, 0.95)).toBe(95);
      expect(percentile(sorted, 0.99)).toBe(99);
    });

    it("clamps p=0 to first and p=1 to last", () => {
      const sorted = [10, 20, 30];
      expect(percentile(sorted, 0)).toBe(10);
      expect(percentile(sorted, 1)).toBe(30);
    });

    it("returns NaN on empty input", () => {
      expect(Number.isNaN(percentile([], 0.5))).toBe(true);
    });
  });

  describe("summarize", () => {
    it("reports count, min, max, and percentile picks", () => {
      const stats = summarize([3, 1, 4, 1, 5, 9, 2, 6, 5, 3]);
      expect(stats.count).toBe(10);
      expect(stats.min).toBe(1);
      expect(stats.max).toBe(9);
      // sorted: 1,1,2,3,3,4,5,5,6,9; p50 idx 4 → 3; p99 idx 9 → 9
      expect(stats.p50).toBe(3);
      expect(stats.p99).toBe(9);
    });

    it("returns NaN-filled stats on empty input", () => {
      const stats = summarize([]);
      expect(stats.count).toBe(0);
      expect(Number.isNaN(stats.p99)).toBe(true);
    });
  });

  describe("p99Delta", () => {
    it("computes rank-correlated p99 delta between two distributions", () => {
      // withProxy is uniformly 2ms slower: per-rank delta is 2ms everywhere.
      const wo = Array.from({ length: 100 }, (_, i) => i * 0.1);
      const w = wo.map((x) => x + 2);
      expect(p99Delta(w, wo)).toBeCloseTo(2, 5);
    });

    it("returns 0 when distributions are identical", () => {
      const xs = Array.from({ length: 100 }, (_, i) => i);
      expect(p99Delta(xs, xs)).toBe(0);
    });

    it("can be negative when proxy is faster (degenerate case)", () => {
      const wo = Array.from({ length: 100 }, (_, i) => i + 5);
      const w = Array.from({ length: 100 }, (_, i) => i);
      expect(p99Delta(w, wo)).toBeLessThan(0);
    });

    it("returns NaN when either side is empty", () => {
      expect(Number.isNaN(p99Delta([], [1, 2, 3]))).toBe(true);
      expect(Number.isNaN(p99Delta([1, 2, 3], []))).toBe(true);
    });

    it("truncates to the shorter set's length", () => {
      // No throw, no NaN — math is well-defined on the truncated overlap.
      const long = Array.from({ length: 100 }, (_, i) => i);
      const short = Array.from({ length: 50 }, (_, i) => i + 1);
      expect(p99Delta(long, short)).toBeCloseTo(-1, 5);
    });
  });

  describe("median", () => {
    it("picks the nearest-rank p50", () => {
      expect(median([3, 1, 2])).toBe(2);
      expect(median([4, 1, 3, 2])).toBe(2); // nearest-rank: ceil(0.5*4)-1 → idx 1
    });

    it("returns NaN on empty input", () => {
      expect(Number.isNaN(median([]))).toBe(true);
    });
  });

  // F-728 fixtures. `quiet` mimics a healthy runner: tight distribution around
  // ~1ms. `noisy` mimics a shared runner with a loaded neighbor: same body,
  // but a few percent of samples stalled by the scheduler.
  const quietRun = (offsetMs = 0): number[] =>
    Array.from({ length: 1000 }, (_, i) => offsetMs + 0.8 + (i % 100) * 0.005);
  const noisyRun = (offsetMs = 0, stallEvery = 40, stallMs = 6): number[] =>
    Array.from({ length: 1000 }, (_, i) =>
      offsetMs + 0.8 + (i % 100) * 0.005 + (i % stallEvery === 0 ? stallMs + (i % 7) : 0),
    );

  describe("p99NoiseFloor", () => {
    it("is ~0 for baselines drawn from the same quiet distribution", () => {
      expect(p99NoiseFloor([quietRun(), quietRun(), quietRun()])).toBeCloseTo(0, 5);
    });

    it("grows when baselines disagree in the tail (noisy runner)", () => {
      const floor = p99NoiseFloor([quietRun(), noisyRun(), noisyRun(0, 30, 8)]);
      expect(floor).toBeGreaterThan(1);
    });

    it("returns NaN with fewer than two baselines", () => {
      expect(Number.isNaN(p99NoiseFloor([quietRun()]))).toBe(true);
      expect(Number.isNaN(p99NoiseFloor([]))).toBe(true);
    });
  });

  describe("evaluateGate", () => {
    it("passes a healthy runner with true ~1ms overhead and zero allowance", () => {
      const withRuns = [quietRun(1), quietRun(1), quietRun(1)];
      const withoutRuns = [quietRun(), quietRun(), quietRun()];
      const v = evaluateGate(withRuns, withoutRuns, 5);
      expect(v.pass).toBe(true);
      expect(v.medianDelta).toBeCloseTo(1, 5);
      expect(v.allowance).toBeCloseTo(0, 5);
    });

    it("survives one transiently noisy A/B pair via the median", () => {
      // Pair 2's capture run caught a burst of scheduler stalls; pairs 1 and 3
      // are clean. Old single-pair verdict on pair 2 alone would fail.
      const withRuns = [quietRun(1), noisyRun(1), quietRun(1)];
      const withoutRuns = [quietRun(), quietRun(), quietRun()];
      const v = evaluateGate(withRuns, withoutRuns, 5);
      expect(v.deltas[1]).toBeGreaterThan(5);
      expect(v.pass).toBe(true);
    });

    it("survives a persistently noisy runner via the A/A allowance", () => {
      // The PR #99 failure mode: noise the whole job, so EVERY pair's delta
      // hovers just over budget — but the no-capture baselines disagree with
      // each other by a similar amount, which is the tell that it's the
      // runner, not the recorder.
      const withRuns = [noisyRun(1, 40, 6), noisyRun(1, 35, 7), noisyRun(1, 45, 6)];
      const withoutRuns = [noisyRun(0, 38, 1), noisyRun(0, 50, 7), noisyRun(0, 33, 2)];
      const v = evaluateGate(withRuns, withoutRuns, 5);
      expect(v.allowance).toBeGreaterThan(0);
      expect(v.pass).toBe(true);
    });

    it("fails a real capture-path regression even on a noisy runner", () => {
      // 9ms of true added tail latency in every capture run. The baselines'
      // A/A spread (allowance) is capped at the budget, so 5+5=10 is the most
      // lenient possible verdict — and the regression + noise clears it.
      const withRuns = [noisyRun(9, 40, 6), noisyRun(9, 35, 7), noisyRun(9, 45, 6)];
      const withoutRuns = [noisyRun(0, 38, 1), noisyRun(0, 50, 7), noisyRun(0, 33, 2)];
      const v = evaluateGate(withRuns, withoutRuns, 5);
      expect(v.allowance).toBeLessThanOrEqual(5);
      expect(v.pass).toBe(false);
    });

    it("fails a uniform-shift regression on a quiet runner with no allowance help", () => {
      const withRuns = [quietRun(6), quietRun(6), quietRun(6)];
      const withoutRuns = [quietRun(), quietRun(), quietRun()];
      const v = evaluateGate(withRuns, withoutRuns, 5);
      expect(v.allowance).toBeCloseTo(0, 5);
      expect(v.pass).toBe(false);
    });

    it("caps the allowance at the budget", () => {
      const wild = (seed: number): number[] =>
        Array.from({ length: 1000 }, (_, i) => 1 + ((i * seed) % 50) * (i % 10 === 0 ? 20 : 0.01));
      const v = evaluateGate([wild(3), wild(5), wild(7)], [wild(11), wild(13), wild(17)], 5);
      expect(v.allowance).toBeLessThanOrEqual(5);
      expect(v.effectiveBudgetMs).toBeLessThanOrEqual(10);
    });

    it("does not pass on NaN medians", () => {
      const v = evaluateGate([[], [], []], [quietRun(), quietRun(), quietRun()], 5);
      expect(Number.isNaN(v.medianDelta)).toBe(true);
      expect(v.pass).toBe(false);
    });
  });
});
