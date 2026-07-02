// SPDX-License-Identifier: Apache-2.0
//
// Outcome-level aggregation (spec §3): fold CellResult[] into the MatrixAggregate
// payoff — scenario discrimination, measurement reliability, twin-anomaly digest,
// and the (internal) agent leaderboard.
//
// This module is PURE over its CellResult[] input — no IO, no clock, no spawn —
// so the aggregation math (discrimination variance, flakiness rate) is unit-
// testable with synthetic cells and the report stage stays a thin renderer.
import { meanIgnoringNull } from "./cost.js";
import type { AnomalyHit } from "./anomalies.js";
import { digestAnomalies } from "./anomalies.js";
import type {
  CellResult,
  LeaderboardEntry,
  MatrixAggregate,
  MeasurementReliability,
  ScenarioDiscrimination,
} from "./types.js";

// Population variance of a numeric series. Empty → 0 (a single agent or no data
// has no spread). Used for per-scenario pass-rate spread across the fleet.
export function variance(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sq = values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0);
  return sq / values.length;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Sample standard deviation (n-1). Null when fewer than 2 present values — a
// single measurement has no dispersion to report. Used for judge-confidence
// agreement across [P]-bearing cells.
export function stdevSample(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const sq = values.reduce((acc, v) => acc + (v - m) * (v - m), 0);
  return Math.sqrt(sq / (values.length - 1));
}

// --- scenario discrimination ---------------------------------------------
// For each scenario, how much does the fleet's pass-rate spread? A scenario
// where every agent passes (or every agent fails) is LOW SIGNAL — it does not
// discriminate between agents, so it earns its keep only as a smoke test.
export function scenarioDiscrimination(
  cells: CellResult[],
): ScenarioDiscrimination[] {
  const byScenario = new Map<string, CellResult[]>();
  for (const c of cells) {
    const list = byScenario.get(c.scenario) ?? [];
    list.push(c);
    byScenario.set(c.scenario, list);
  }

  const out: ScenarioDiscrimination[] = [];
  for (const [scenario, group] of byScenario) {
    const passRates = group.map((c) => c.pass_rate);
    const fleetPassRate = mean(passRates);
    const passVariance = variance(passRates);
    // Low signal = the whole fleet lands on the same side: all cells fully
    // pass, or all cells fully fail. A mid-range-but-uniform scenario (every
    // agent at 0.5) is NOT low-signal — it still discriminates run-to-run.
    const allPass = group.every((c) => c.pass_rate === 1);
    const allFail = group.every((c) => c.pass_rate === 0);
    out.push({
      scenario,
      fleet_pass_rate: fleetPassRate,
      pass_variance: passVariance,
      low_signal: allPass || allFail,
      agents_evaluated: group.length,
    });
  }
  // Stable order: most-discriminating (highest variance) first, then by name.
  return out.sort(
    (a, b) =>
      b.pass_variance - a.pass_variance || a.scenario.localeCompare(b.scenario),
  );
}

// --- measurement reliability ---------------------------------------------
// Is the harness itself trustworthy? Flaky cells (0 < pass_rate < 1) say the
// scenario or the agent is nondeterministic; judge-confidence stdev across
// [P]-bearing cells says how much the LLM judge wobbles.
export function measurementReliability(
  cells: CellResult[],
): MeasurementReliability {
  const total = cells.length;
  const flaky = cells.filter((c) => c.flaky).length;
  const confidences = cells
    .map((c) => c.mean_judge_confidence)
    .filter((v): v is number => v !== null);
  return {
    total_cells: total,
    flaky_cells: flaky,
    flaky_rate: total === 0 ? 0 : flaky / total,
    mean_judge_confidence:
      confidences.length === 0 ? null : mean(confidences),
    judge_confidence_stdev: stdevSample(confidences),
  };
}

// A cell run "passed" iff the agent did not error AND its satisfaction cleared
// the pass threshold. Pure so both the cell reader and the unit test share one
// definition. Decoupling pass from the child's 0/1 exit lets the matrix apply a
// `--pass-threshold` override without re-plumbing `pome run` (an agent-error
// exit 3 still fails regardless of threshold — there is no score to credit).
export function cellPassed(
  satisfaction: number,
  agentErrored: boolean,
  passThreshold: number,
  // A5 inflation guard (FDRS-611): a run where a required criterion was
  // skipped/errored ("un-evaluated") can never pass, regardless of its
  // headline satisfaction. Defaults true so legacy score.json (no `can_pass`
  // field) keeps its old behavior.
  canPass = true,
): boolean {
  if (agentErrored) return false;
  if (!canPass) return false;
  return satisfaction >= passThreshold;
}

// --- agent leaderboard (internal-only; ranking surface B deferred) -------
export function leaderboard(cells: CellResult[]): LeaderboardEntry[] {
  const byAgent = new Map<string, CellResult[]>();
  for (const c of cells) {
    const list = byAgent.get(c.agent_id) ?? [];
    list.push(c);
    byAgent.set(c.agent_id, list);
  }

  const out: LeaderboardEntry[] = [];
  for (const [agentId, group] of byAgent) {
    const meanSatisfaction = mean(group.map((c) => c.mean_satisfaction));
    const meanPassRate = mean(group.map((c) => c.pass_rate));
    const flakyCells = group.filter((c) => c.flaky).length;
    const costs = group.map((c) => c.mean_cost_usd);
    const anyCost = costs.some((c) => c !== null);
    const totalCost = anyCost
      ? costs.reduce<number>((sum, c) => sum + (c ?? 0), 0)
      : null;
    out.push({
      agent_id: agentId,
      mean_satisfaction: meanSatisfaction,
      mean_pass_rate: meanPassRate,
      cells: group.length,
      flaky_cells: flakyCells,
      total_cost_usd: totalCost,
    });
  }
  // Best agent first: lead with the satisfaction gradient (finest separation),
  // then binary pass-rate, then fewest flaky cells, then id.
  return out.sort(
    (a, b) =>
      b.mean_satisfaction - a.mean_satisfaction ||
      b.mean_pass_rate - a.mean_pass_rate ||
      a.flaky_cells - b.flaky_cells ||
      a.agent_id.localeCompare(b.agent_id),
  );
}

// Fold everything into the MatrixAggregate. `anomalyHits` come from the cell
// reader (one flattened list across the whole matrix); kept as a separate
// argument because they are derived from raw events, not from CellResult.
export function aggregateMatrix(
  cells: CellResult[],
  anomalyHits: AnomalyHit[],
): MatrixAggregate {
  return {
    scenario_discrimination: scenarioDiscrimination(cells),
    measurement_reliability: measurementReliability(cells),
    twin_anomaly_digest: digestAnomalies(anomalyHits),
    leaderboard: leaderboard(cells),
  };
}

// Roll a cell's per-run records up into the CellResult summary fields. Pure —
// the cell reader builds CellRun[] from disk, this folds them. Exported so the
// unit test can build CellResults without touching the filesystem.
export function summarizeCell(input: {
  cellId: string;
  agentId: string;
  scenario: string;
  scenarioPath: string;
  runs: Array<{
    passed: boolean;
    satisfaction: number;
    cost_usd: number | null;
    latency_ms: number | null;
    judge_confidence: number | null; // mean [P] confidence for this run, or null
    judge_model: string | null;
  }>;
}): CellResult {
  const { runs } = input;
  const total = runs.length;
  const passed = runs.filter((r) => r.passed).length;
  const passRate = total === 0 ? 0 : passed / total;
  const meanSatisfaction = mean(runs.map((r) => r.satisfaction));
  const meanConfidence = meanIgnoringNull(runs.map((r) => r.judge_confidence));
  const judgeModel = runs.find((r) => r.judge_model !== null)?.judge_model ?? null;
  const meanCost = meanIgnoringNull(runs.map((r) => r.cost_usd));
  const meanLatency = meanIgnoringNull(runs.map((r) => r.latency_ms));

  return {
    cell_id: input.cellId,
    agent_id: input.agentId,
    scenario: input.scenario,
    scenario_path: input.scenarioPath,
    runs: [], // filled in by the cell reader; summarizeCell only computes rollups
    pass_rate: passRate,
    flaky: passRate > 0 && passRate < 1,
    mean_satisfaction: meanSatisfaction,
    mean_judge_confidence: meanConfidence,
    judge_model: judgeModel,
    mean_cost_usd: meanCost,
    mean_latency_ms: meanLatency,
  };
}
