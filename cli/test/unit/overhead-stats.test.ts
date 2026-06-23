// SPDX-License-Identifier: Apache-2.0
// FDRS-405 — pin the overhead-gate math. The orchestrator is process-driven
// and slow to exercise end-to-end; these tests cover the parts that matter
// (sample parsing, percentile picking, p99 delta) without a `pome run`.

import { describe, expect, it } from "vitest";
import { p99Delta, parseSamples, percentile, summarize } from "../../scripts/overhead-stats.js";

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
});
