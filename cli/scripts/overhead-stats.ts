// SPDX-License-Identifier: Apache-2.0
// FDRS-405 — helpers for the overhead-gate orchestrator. Extracted from
// `overhead-gate.ts` so the math is unit-testable without spawning processes.

export interface LatencyStats {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  count: number;
}

export function parseSamples(stdout: string): number[] {
  const samples: number[] = [];
  for (const line of stdout.split("\n")) {
    const idx = line.indexOf("OVERHEAD_BENCH_SAMPLE_MS=");
    if (idx === -1) continue;
    const tail = line.slice(idx + "OVERHEAD_BENCH_SAMPLE_MS=".length).trim();
    const value = Number.parseFloat(tail);
    if (Number.isFinite(value)) samples.push(value);
  }
  return samples;
}

// Nearest-rank percentile (`Math.ceil(p * n) - 1`). Stdlib-free; deliberately
// pinned to one definition so CI math is reproducible regardless of host.
export function percentile(sortedAsc: ReadonlyArray<number>, p: number): number {
  if (sortedAsc.length === 0) return NaN;
  if (p <= 0) return sortedAsc[0]!;
  if (p >= 1) return sortedAsc[sortedAsc.length - 1]!;
  const idx = Math.max(0, Math.min(sortedAsc.length - 1, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx]!;
}

export function summarize(samples: ReadonlyArray<number>): LatencyStats {
  if (samples.length === 0) {
    return { p50: NaN, p95: NaN, p99: NaN, min: NaN, max: NaN, count: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    count: sorted.length,
  };
}

// p99 of the per-rank delta between two equal-cardinality sample sets, both
// sorted ascending. This is NOT a paired comparison across runs — the two
// `pome run` invocations are independent and per-iteration timings can't be
// paired. Rank-correlated subtraction is the convention for proxy-overhead
// gates: it asks "at the same quantile of the with-proxy distribution, what
// is the marginal cost vs the baseline distribution?". If the two sets differ
// in length the shorter is truncated — never silently extrapolate.
export function p99Delta(
  withProxy: ReadonlyArray<number>,
  withoutProxy: ReadonlyArray<number>,
): number {
  if (withProxy.length === 0 || withoutProxy.length === 0) return NaN;
  const n = Math.min(withProxy.length, withoutProxy.length);
  const w = [...withProxy].sort((a, b) => a - b).slice(0, n);
  const wo = [...withoutProxy].sort((a, b) => a - b).slice(0, n);
  const deltas = w.map((v, i) => v - wo[i]!);
  deltas.sort((a, b) => a - b);
  return percentile(deltas, 0.99);
}
