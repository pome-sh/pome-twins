// SPDX-License-Identifier: Apache-2.0
import type { Criterion } from "../scenario/scenarioSchema.js";

export type CriterionResult = {
  criterion: Criterion;
  passed: boolean;
  skipped: boolean;
  reason: string;
  // [P]-only fields. Undefined for [D] results.
  confidence?: number;
  judge_model?: string;
  judge_tokens_in?: number;
  judge_tokens_out?: number;
  // True if the LLM endpoint reported `usage` for this call. False when the
  // provider omitted it (e.g., Ollama). Used to decide run-level null sums.
  judge_has_usage?: boolean;
};

export type Score = {
  satisfaction: number;
  passed: number;
  failed: number;
  skipped: number;
  total_required: number;
  results: CriterionResult[];
  // Run-level [P] aggregates. Null when no [P] criteria evaluated.
  judge_model: string | null;
  judge_tokens_in: number | null;
  judge_tokens_out: number | null;
};

export function scoreResults(results: CriterionResult[]): Score {
  const required = results.filter((result) => !result.skipped);
  const passed = required.filter((result) => result.passed).length;
  const failed = required.length - passed;

  const probabilistic = results.filter((r) => r.criterion.type === "P");

  const judge_model =
    probabilistic.find((r) => r.judge_model)?.judge_model ?? null;

  // If any [P] call (even one) lacked usage, run-level tokens are null.
  // If all [P] criteria were skipped before any call (no judge configured),
  // run-level tokens are null too — there's nothing to sum.
  const evaluated_p = probabilistic.filter((r) => !r.skipped);
  const all_have_usage =
    evaluated_p.length > 0 && evaluated_p.every((r) => r.judge_has_usage === true);

  const judge_tokens_in = all_have_usage
    ? probabilistic.reduce((sum, r) => sum + (r.judge_tokens_in ?? 0), 0)
    : null;
  const judge_tokens_out = all_have_usage
    ? probabilistic.reduce((sum, r) => sum + (r.judge_tokens_out ?? 0), 0)
    : null;

  return {
    satisfaction: required.length ? Math.round((passed / required.length) * 100) : 0,
    passed,
    failed,
    skipped: results.length - required.length,
    total_required: required.length,
    results,
    judge_model,
    judge_tokens_in,
    judge_tokens_out,
  };
}
