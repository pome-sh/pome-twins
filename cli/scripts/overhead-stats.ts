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

export function median(values: ReadonlyArray<number>): number {
  const sorted = [...values].sort((a, b) => a - b);
  return percentile(sorted, 0.5);
}

// F-728 — the runner's measured noise floor at the gate's own statistic: an
// A/A test. Pairwise p99Delta between baseline (no-capture) runs says how far
// apart two runs of the SAME distribution land on this runner right now, with
// zero true overhead in play. p99Delta is directional — tail stalls in the
// FIRST argument surface as positive deltas at p99, stalls in the second
// mostly don't — and only positive deltas ever fail the gate, so each pair
// contributes its worse direction (clamped at 0). Median over the pairs
// resists one bad baseline run. NaN when fewer than two baselines are
// supplied.
export function p99NoiseFloor(baselineRuns: ReadonlyArray<ReadonlyArray<number>>): number {
  const nulls: number[] = [];
  for (let i = 0; i < baselineRuns.length; i++) {
    for (let j = i + 1; j < baselineRuns.length; j++) {
      const forward = p99Delta(baselineRuns[i]!, baselineRuns[j]!);
      const reverse = p99Delta(baselineRuns[j]!, baselineRuns[i]!);
      if (!Number.isFinite(forward) || !Number.isFinite(reverse)) continue;
      nulls.push(Math.max(forward, reverse, 0));
    }
  }
  if (nulls.length === 0) return NaN;
  return median(nulls);
}

export interface GateVerdict {
  deltas: number[];
  medianDelta: number;
  noiseFloor: number;
  allowance: number;
  effectiveBudgetMs: number;
  pass: boolean;
}

// F-728 — the full gate verdict, pure so it's unit-testable. Per-pair p99
// deltas → median (one noisy A/B pair can't flip the verdict) → compared
// against budget + allowance, where allowance is the A/A noise floor from
// the baseline runs, capped at the budget itself. The cap bounds worst-case
// leniency at 2× budget: a pathologically noisy runner can't absorb an
// arbitrary regression. A real capture-path regression shifts every A/B
// delta but leaves the B/B null deltas untouched, so it cannot hide inside
// the allowance.
export function evaluateGate(
  withRuns: ReadonlyArray<ReadonlyArray<number>>,
  withoutRuns: ReadonlyArray<ReadonlyArray<number>>,
  budgetMs: number,
): GateVerdict {
  const pairs = Math.min(withRuns.length, withoutRuns.length);
  const deltas: number[] = [];
  for (let i = 0; i < pairs; i++) {
    deltas.push(p99Delta(withRuns[i]!, withoutRuns[i]!));
  }
  const medianDelta = median(deltas);
  const floor = withoutRuns.length >= 2 ? p99NoiseFloor(withoutRuns) : 0;
  const allowance = Number.isFinite(floor) ? Math.min(Math.max(floor, 0), budgetMs) : 0;
  const effectiveBudgetMs = budgetMs + allowance;
  return {
    deltas,
    medianDelta,
    noiseFloor: floor,
    allowance,
    effectiveBudgetMs,
    pass: Number.isFinite(medianDelta) && medianDelta <= effectiveBudgetMs,
  };
}
