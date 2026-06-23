// SPDX-License-Identifier: Apache-2.0
//
// matrix.json shape — zod schemas + inferred types.
//
// OUTCOME-LEVEL ONLY (spec §3). No explanation/failure-mode fields — that is
// v2, gated on the OTel trace work. v1 reads whatever trace exists (tokens /
// cost / latency / tool-calls / twin anomalies) but never depends on rich
// traces.
import { z } from "zod";

// ---- per-cell (one agent × one scenario, run N times) ----

// A single run of a cell. Fields are lifted from the per-run artifacts the
// existing `pome run` writes: meta.json (run_id / exit_code), score.json
// (satisfaction + criteria counters + judge metadata), and events.jsonl
// (LlmCallEvent / TwinHttpEvent rows for the resource + anomaly rollups).
export const cellRunSchema = z.object({
  run_index: z.number().int().min(0),
  run_id: z.string(), // run_<uuid> from meta.json
  run_dir: z.string(), // <cellDir>/<slug>/<run_id>
  passed: z.boolean(), // satisfaction >= passThreshold
  satisfaction: z.number().int().min(0).max(100),
  exit_code: z.number().int(), // 0 pass | 1 fail | 3 agent-error/timeout
  agent_errored: z.boolean(), // exit_code === 3 (timeout or non-zero agent)
  // outcome counters lifted from score.json
  criteria_passed: z.number().int().min(0),
  criteria_failed: z.number().int().min(0),
  criteria_skipped: z.number().int().min(0),
  // best-effort resource metrics (any may be null — keyless scripted cells
  // emit no LlmCallEvents, so tokens/cost/latency are honestly null)
  prompt_tokens: z.number().int().min(0).nullable(),
  completion_tokens: z.number().int().min(0).nullable(),
  cost_usd: z.number().nullable(),
  latency_ms: z.number().int().min(0).nullable(), // sum of LlmCallEvent latency
  tool_calls: z.number().int().min(0), // count of TwinHttpEvent the agent made
  twin_anomaly_count: z.number().int().min(0),
});
export type CellRun = z.infer<typeof cellRunSchema>;

export const cellResultSchema = z.object({
  cell_id: z.string(), // `${agent_id}::${scenario_slug}`
  agent_id: z.string(),
  scenario: z.string(), // slug
  scenario_path: z.string(),
  runs: z.array(cellRunSchema),
  // roll-ups across the cell's runs
  pass_rate: z.number().min(0).max(1), // passed runs / total runs
  flaky: z.boolean(), // 0 < pass_rate < 1
  mean_satisfaction: z.number().min(0).max(100),
  // mean confidence across [P] criteria across runs; null if no [P]/no judge
  mean_judge_confidence: z.number().min(0).max(1).nullable(),
  judge_model: z.string().nullable(),
  mean_cost_usd: z.number().nullable(),
  mean_latency_ms: z.number().nullable(),
});
export type CellResult = z.infer<typeof cellResultSchema>;

// ---- aggregates (the payoff, all outcome-level) ----

export const scenarioDiscriminationSchema = z.object({
  scenario: z.string(),
  fleet_pass_rate: z.number().min(0).max(1), // mean cell pass_rate across agents
  pass_variance: z.number().min(0), // variance of per-agent pass_rate
  low_signal: z.boolean(), // all-pass or all-fail across fleet
  agents_evaluated: z.number().int().min(1),
});
export type ScenarioDiscrimination = z.infer<
  typeof scenarioDiscriminationSchema
>;

export const measurementReliabilitySchema = z.object({
  total_cells: z.number().int().min(0),
  flaky_cells: z.number().int().min(0),
  flaky_rate: z.number().min(0).max(1),
  // judge agreement: stdev of mean_judge_confidence across [P]-bearing cells
  mean_judge_confidence: z.number().min(0).max(1).nullable(),
  judge_confidence_stdev: z.number().min(0).nullable(),
});
export type MeasurementReliability = z.infer<
  typeof measurementReliabilitySchema
>;

export const twinAnomalySchema = z.object({
  twin: z.string(),
  method: z.string(),
  path: z.string(), // template-normalized
  status: z.number().int(),
  fidelity: z.enum(["semantic", "unsupported"]),
  occurrences: z.number().int().min(1),
  sample_cell_id: z.string(),
});
export type TwinAnomaly = z.infer<typeof twinAnomalySchema>;

export const leaderboardEntrySchema = z.object({
  agent_id: z.string(),
  // Primary ranking key (the satisfaction gradient): mean of each cell's
  // mean_satisfaction across scenarios. Separates models that "got the hard
  // part right, missed one step" from those that whiffed entirely — the binary
  // pass-rate collapses both to the same bucket.
  mean_satisfaction: z.number().min(0).max(100),
  mean_pass_rate: z.number().min(0).max(1), // across all scenarios
  cells: z.number().int().min(0),
  flaky_cells: z.number().int().min(0),
  total_cost_usd: z.number().nullable(),
});
export type LeaderboardEntry = z.infer<typeof leaderboardEntrySchema>;

export const matrixAggregateSchema = z.object({
  scenario_discrimination: z.array(scenarioDiscriminationSchema),
  measurement_reliability: measurementReliabilitySchema,
  twin_anomaly_digest: z.array(twinAnomalySchema),
  leaderboard: z.array(leaderboardEntrySchema), // internal-only (B deferred)
});
export type MatrixAggregate = z.infer<typeof matrixAggregateSchema>;

// ---- top-level matrix.json ----

export const matrixConfigSchema = z.object({
  agents_file: z.string(),
  scenarios_glob: z.string(),
  runs: z.number().int().positive(),
  agent_ids: z.array(z.string()),
  scenario_slugs: z.array(z.string()),
});
export type MatrixConfig = z.infer<typeof matrixConfigSchema>;

export const matrixResultSchema = z.object({
  schema_version: z.literal(1),
  generated_at: z.string().datetime(),
  git_sha: z.string(), // from build-info.json / env
  config: matrixConfigSchema,
  cells: z.array(cellResultSchema),
  aggregate: matrixAggregateSchema,
});
export type MatrixResult = z.infer<typeof matrixResultSchema>;

// ---- planning shapes (pre-execution; not serialized into matrix.json) ----

// One resolved matrix cell to execute: a concrete (agent × scenario) pairing
// plus the resolved `--agent` command string and per-cell artifacts dir. The
// orchestrator (stage 2) runs `runs` copies of each.
export type MatrixCell = {
  cell_id: string;
  agent_id: string;
  scenario: string; // slug
  scenario_path: string;
  agent_command: string;
  cell_dir: string;
  runs: number;
  timeout?: number;
};
