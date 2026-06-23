// SPDX-License-Identifier: Apache-2.0
//
// Schema for the curated eval-report data layer (eval/agent-eval-r3.json) — the
// machine-readable mirror of the canonical report's round-3 section (§10 of
// eval/scenario-canonical-report.md). One data layer, two views: the internal
// HTML view (eval-report-html.ts) renders it now; a marketing view can derive
// from the same JSON later.
//
// Produced (and reproducible) by eval/aggregate-r3.py over the gitignored
// per-cell artifacts. Validated here at load so a malformed data file fails
// loudly in the CLI, not in the renderer.
import { z } from "zod";

const caughtSchema = z.object({
  model: z.string(),
  fails: z.number().int(),
  runs: z.number().int(),
});

const leaderboardEntrySchema = z.object({
  model: z.string(),
  provider: z.string(),
  mean_satisfaction: z.number(),
  n: z.number().int(),
  // Scenario numbers ("05","17","18") this model fails at least one run of.
  caught_by: z.array(z.string()),
});

const scenarioStatSchema = z.object({
  slug: z.string(),
  mean_satisfaction: z.number(),
  pass_variance: z.number(),
  low_signal: z.boolean(),
  caught: z.array(caughtSchema),
});

const actionFailureSchema = z.object({
  model: z.string(),
  provider: z.string(),
  // Runs (of `runs`) in which the model forged a green CI signal / merged on it.
  fabricated: z.number().int(),
  merged: z.number().int(),
  runs: z.number().int(),
});

const scenario17Schema = z.object({
  model: z.string(),
  sats: z.array(z.number().nullable()),
  pass_rate: z.number(),
});

export const evalReportSchema = z.object({
  schema_version: z.literal(1),
  run: z.object({
    date: z.string(),
    branch: z.string(),
    ticket: z.string(),
    fleet_size: z.number().int(),
    scenario_count: z.number().int(),
    runs_per_cell: z.number().int(),
    total_cells: z.number().int(),
    scaffold: z.string(),
    judge_model: z.string(),
    twin: z.string(),
    gateway: z.string(),
  }),
  leaderboard: z.array(leaderboardEntrySchema),
  scenarios: z.array(scenarioStatSchema),
  action_failure_18: z.array(actionFailureSchema),
  scenario17: z.array(scenario17Schema),
});

export type EvalReportData = z.infer<typeof evalReportSchema>;
export type EvalLeaderboardEntry = z.infer<typeof leaderboardEntrySchema>;
export type EvalScenarioStat = z.infer<typeof scenarioStatSchema>;
export type EvalActionFailure = z.infer<typeof actionFailureSchema>;
