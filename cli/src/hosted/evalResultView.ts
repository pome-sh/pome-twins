// SPDX-License-Identifier: Apache-2.0
//
// Cloud-verdict DISPLAY model + pure label/render helpers (FDRS-656/657).
//
// The OSS CLI is CAPTURE-ONLY: it never computes a score, never runs a judge,
// and never correlates locally. Every helper here operates on a score object
// that ORIGINATES FROM THE CLOUD (a hosted `pome run` /finalize response, or a
// `pome eval` upload verdict — see `scoreFromFinalizeResponse`). Nothing in
// this module derives a verdict from twin state, events, or a judge call.
//
// This is the relocation of the former `src/evaluator/score.ts` + the
// verdict-rendering half of `src/cli/render.ts`. The local scoring engine
// (`scoreResults`, the deterministic matchers, the BYOK LLM judge) was deleted
// under FDRS-657; only the pure display model survives, moved out of the
// `evaluator/` tree so the `no-eval-in-oss` gate can assert that tree is gone.
//
// F-689/D16 — moved AGAIN from `src/score/view.ts` to here. `score/` (a
// module-name stem the repo-wide gate now denies outright) has to cease to
// exist, so this pure display model lives under `hosted/` with the rest of
// the cloud-facing surface it renders.

// Wire-side criterion, NOT the scenario-markdown one: cloud responses carry
// the unified "code"/"model" vocabulary (legacy "D"/"P" tolerated) while
// scenario files still parse [code]/[model] markers. This module renders CLOUD
// verdicts, so it takes the wide wire shape (FDRS-643 live-run finding).
import type { z } from "zod";
import type { criterionSchema } from "../types/shared.js";

type WireCriterion = z.infer<typeof criterionSchema>;

// FDRS-591 + FDRS-611 — unified per-criterion outcome model as reported by the
// cloud judge.
//
//   passed   — criterion evaluated and satisfied.
//   failed   — criterion evaluated and NOT satisfied.
//   skipped  — the cloud could not evaluate this criterion.
//   errored  — judge/infra failure while evaluating.
//
// `skipped` and `errored` are BOTH excluded from the satisfaction denominator
// (only `passed`/`failed` count) but are surfaced as explicit counts so a run
// that evaluated nothing renders as "un-evaluated", never as a hard 0%.
export type CriterionOutcome = "passed" | "failed" | "skipped" | "errored";

export type CriterionResult = {
  criterion: WireCriterion;
  // FDRS-591/611: explicit four-state outcome. ADDITIVE + OPTIONAL — when
  // absent (older cloud producers) it is derived from `passed`/`skipped` via
  // `outcomeOf`.
  outcome?: CriterionOutcome;
  passed: boolean;
  // Wire-compat: `skipped` stays a boolean and is TRUE for both `skipped` and
  // `errored` outcomes.
  skipped: boolean;
  reason: string;
  // [model]-only fields, populated by the cloud judge.
  confidence?: number;
  judge_model?: string;
  judge_tokens_in?: number;
  judge_tokens_out?: number;
  judge_has_usage?: boolean;
};

export type Score = {
  // passed / (passed + failed), rounded to 0-100. 0 when nothing was evaluated
  // — callers MUST consult `evaluated`/`can_pass` before reading this as a
  // verdict, since a 0 here means "un-evaluated", not "hard fail".
  satisfaction: number;
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  // = passed + failed. The satisfaction denominator.
  total_required: number;
  // false when total_required === 0 (nothing was evaluated). Renders as
  // "un-evaluated" instead of 0%.
  evaluated: boolean;
  // A5 inflation guard — a run may only PASS if every required criterion was
  // actually evaluated (passed or failed).
  can_pass: boolean;
  results: CriterionResult[];
  // Run-level [model] aggregates from the cloud judge. Null when absent.
  judge_model: string | null;
  judge_tokens_in: number | null;
  judge_tokens_out: number | null;
};

// Derive the four-state outcome from a cloud result. Prefers the explicit
// `outcome` field; falls back to the legacy passed/skipped booleans. PURE.
export function outcomeOf(result: CriterionResult): CriterionOutcome {
  if (result.outcome) return result.outcome;
  if (result.skipped) return "skipped";
  return result.passed ? "passed" : "failed";
}

export type ScoreStatus = "pass" | "fail" | "unevaluated";

// Single source of truth for "did this run pass?", applied to a CLOUD score.
// Encodes the A5 guard: a run is only a PASS when it was evaluated, every
// required criterion was evaluated (can_pass), AND satisfaction cleared the
// threshold. PURE — no computation of the score itself.
export function scoreStatus(score: Score, passThreshold: number): ScoreStatus {
  if (!score.evaluated || !score.can_pass) return "unevaluated";
  return score.satisfaction >= passThreshold ? "pass" : "fail";
}

export function scenarioPassed(score: Score, passThreshold: number): boolean {
  return scoreStatus(score, passThreshold) === "pass";
}

// FDRS-591/611 per-criterion marker: ✓ passed, ✗ failed, - skipped, ! errored.
export function markerFor(outcome: CriterionOutcome): string {
  switch (outcome) {
    case "passed":
      return "✓";
    case "failed":
      return "✗";
    case "errored":
      return "!";
    default:
      return "-";
  }
}

// Multi-twin (M3): the per-criterion bracket for terminal display —
// `[code]` / `[model]`, plus the `:<twin>` suffix when the criterion attributes
// to a specific twin (so a `[code:slack]`/`[model:github]` marker survives into the
// UNEVAL / criteria list). A bare (primary-twin) criterion renders `[code]`
// unchanged.
export function criterionMarkerLabel(criterion: WireCriterion): string {
  return criterion.twin ? `[${criterion.type}:${criterion.twin}]` : `[${criterion.type}]`;
}

// Multi-twin (M3): when the cloud could not evaluate a criterion for a
// twin-related reason (a twin-tagged criterion, or a `no_matching_predicate`
// skip), name the twin inline so the UNEVAL line explains WHICH twin's timeline
// came up empty. Returns "" when there's nothing twin-specific to add.
export function twinSkipSuffix(result: CriterionResult): string {
  const twin = result.criterion.twin;
  if (!twin) return "";
  const outcome = outcomeOf(result);
  const twinRelated =
    outcome === "skipped" ||
    outcome === "errored" ||
    /no_matching_predicate|no matching predicate/i.test(result.reason);
  return twinRelated ? ` (twin: ${twin})` : "";
}

export function scoreCountsSummary(score: Score): string {
  return `${score.passed ?? 0} passed, ${score.failed ?? 0} failed, ${score.skipped ?? 0} skipped, ${score.errored ?? 0} errored`;
}

export function runScoreLine(
  score: Score,
  passThreshold: number,
  unevaluatedNumericLabel: string,
): string {
  const status = scoreStatus(score, passThreshold);
  if (status === "unevaluated") {
    return `score: un-evaluated (cannot pass) — ${scoreCountsSummary(score)}; ${unevaluatedNumericLabel}: ${score.satisfaction}/100`;
  }
  return `score: ${score.satisfaction}/100`;
}
