// SPDX-License-Identifier: Apache-2.0
import type { Criterion } from "../scenario/scenarioSchema.js";

// FDRS-591 + FDRS-611 — unified per-criterion outcome model.
//
//   passed   — criterion evaluated and satisfied.
//   failed   — criterion evaluated and NOT satisfied (a real content miss).
//   skipped  — the harness could not evaluate this criterion deterministically
//              (FDRS-611): no twin-plugin predicate matched, or no LLM judge is
//              configured. This is a HARNESS gap, not an agent failure.
//   errored  — judge/infra failure while evaluating (FDRS-591): e.g. the LLM
//              judge returned 429/5xx, or an unexpected exception. Also a
//              harness/infra problem, not an agent failure.
//
// `skipped` and `errored` are BOTH excluded from the satisfaction denominator
// (only `passed`/`failed` count) but are surfaced as explicit counts so a run
// that evaluated nothing renders as "un-evaluated", never as a hard 0%.
export type CriterionOutcome = "passed" | "failed" | "skipped" | "errored";

export type CriterionResult = {
  criterion: Criterion;
  // FDRS-591/611: explicit four-state outcome. ADDITIVE + OPTIONAL — when
  // absent (older producers, cloud consumers pre-FDRS-618) it is derived from
  // `passed`/`skipped` via `outcomeOf`. New code should set it explicitly.
  outcome?: CriterionOutcome;
  passed: boolean;
  // Wire-compat: `skipped` stays a boolean and is TRUE for both `skipped` and
  // `errored` outcomes, so existing cloud consumers that read `skipped` to mean
  // "exclude from the denominator" keep working unchanged.
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
  // passed / (passed + failed), rounded to 0-100. 0 when nothing was evaluated
  // (denominator empty) — callers MUST consult `evaluated`/`can_pass` before
  // reading this as a verdict, since a 0 here means "un-evaluated", not "hard
  // fail". See `scoreStatus` / `scenarioPassed`.
  satisfaction: number;
  passed: number;
  failed: number;
  skipped: number;
  // FDRS-591 — judge/infra failures, counted separately from `skipped`.
  errored: number;
  // = passed + failed. The satisfaction denominator.
  total_required: number;
  // FDRS-611 — false when total_required === 0 (nothing was deterministically
  // evaluated). Renders as "un-evaluated" instead of 0%.
  evaluated: boolean;
  // A5 inflation guard — a scenario may only PASS if every required criterion
  // was actually evaluated (passed or failed). Any skipped/errored required
  // criterion flips this false, so "1 passed + 9 skipped = 100%" can never read
  // as a pass. See `scenarioPassed`.
  can_pass: boolean;
  results: CriterionResult[];
  // Run-level [P] aggregates. Null when no [P] criteria evaluated.
  judge_model: string | null;
  judge_tokens_in: number | null;
  judge_tokens_out: number | null;
};

// Derive the four-state outcome from a result. Prefers the explicit `outcome`
// field; falls back to the legacy passed/skipped booleans (a legacy `skipped`
// is treated as `skipped`, never `errored`, since old producers can't tell them
// apart).
export function outcomeOf(result: CriterionResult): CriterionOutcome {
  if (result.outcome) return result.outcome;
  if (result.skipped) return "skipped";
  return result.passed ? "passed" : "failed";
}

export function scoreResults(results: CriterionResult[]): Score {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let errored = 0;
  for (const result of results) {
    switch (outcomeOf(result)) {
      case "passed":
        passed += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "errored":
        errored += 1;
        break;
      default:
        skipped += 1;
    }
  }

  const totalRequired = passed + failed;
  const evaluated = totalRequired > 0;
  // A5: every required criterion must have been evaluated. All criteria are
  // required (the scenario schema has no "optional criterion" marker), so any
  // skipped/errored criterion means the run cannot be trusted to pass.
  const canPass = evaluated && skipped === 0 && errored === 0;

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

  // A1 CAVEAT (FDRS-618, Part 2): pome-cloud RESOLVES scores with its own judge
  // and IGNORES the CLI-computed satisfaction — `apps/control-plane/src/routes/
  // result.ts` overwrites it and `services/judge.ts` computes passed/total on
  // its own. The outcome semantics defined here (skipped/errored excluded from
  // the denominator; the A5 "cannot pass unless every required criterion was
  // evaluated" guard) MUST be adopted cloud-side under FDRS-618 for hosted runs
  // to match. Until then, local (`pome run`) and hosted verdicts can differ for
  // the same trace — specifically, cloud may still report a 0%/"pass" where
  // this model reports "un-evaluated".
  return {
    satisfaction: evaluated ? Math.round((passed / totalRequired) * 100) : 0,
    passed,
    failed,
    skipped,
    errored,
    total_required: totalRequired,
    evaluated,
    can_pass: canPass,
    results,
    judge_model,
    judge_tokens_in,
    judge_tokens_out,
  };
}

export type ScoreStatus = "pass" | "fail" | "unevaluated";

// Single source of truth for "did this scenario pass?". Encodes the A5 guard:
// a run is only a PASS when it was evaluated, every required criterion was
// evaluated (can_pass), AND satisfaction cleared the threshold. An
// all-skipped/all-errored run — or one where a required criterion was
// skipped/errored — is "unevaluated" (never a pass, never a hard fail).
export function scoreStatus(score: Score, passThreshold: number): ScoreStatus {
  if (!score.evaluated || !score.can_pass) return "unevaluated";
  return score.satisfaction >= passThreshold ? "pass" : "fail";
}

export function scenarioPassed(score: Score, passThreshold: number): boolean {
  return scoreStatus(score, passThreshold) === "pass";
}
