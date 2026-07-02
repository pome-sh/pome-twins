// SPDX-License-Identifier: Apache-2.0
import type { Criterion } from "../../scenario/scenarioSchema.js";
import type { CriterionResult } from "../score.js";
import { resolveJudgeConfig } from "./config.js";
import { callJudge, JudgeHttpError } from "./client.js";
import { SYSTEM_PROMPT, buildUserPrompt, type PromptContext } from "./prompt.js";
import { parseJudgeResponse } from "./parser.js";
import { classifyJudgeError, formatErrorReason } from "./errors.js";

export type ProbabilisticContext = Omit<PromptContext, "criterion">;

export async function evaluateProbabilistic(
  criterion: Criterion,
  ctx: ProbabilisticContext,
): Promise<CriterionResult> {
  let cfg: ReturnType<typeof resolveJudgeConfig>;
  try {
    cfg = resolveJudgeConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      criterion,
      passed: false,
      outcome: "skipped",
      skipped: true,
      reason: message,
      confidence: 0,
      judge_has_usage: false,
    };
  }

  // Pre-call skips intentionally omit judge_tokens_in/out and judge_model.
  // Post-call error branches set them to 0 + cfg.model. score.ts's null-sum
  // logic depends on this asymmetry — completing these fields here would
  // silently break run-level token aggregation.
  if (!cfg) {
    return {
      criterion,
      passed: false,
      // FDRS-611: no judge configured is a harness gap, not an infra failure.
      outcome: "skipped",
      skipped: true,
      reason:
        "No LLM judge configured — set POME_LLM_API_KEY (with BASE_URL + MODEL), or OPENAI_API_KEY, or ANTHROPIC_API_KEY. Probabilistic criteria are skipped.",
      confidence: 0,
      judge_has_usage: false,
    };
  }

  const userPrompt = buildUserPrompt({ criterion, ...ctx });

  try {
    const call = await callJudge(cfg, SYSTEM_PROMPT, userPrompt);
    const judged = parseJudgeResponse(call.text);

    const passed = judged.status === "pass";
    const reason = judged.status === "partial" ? `PARTIAL: ${judged.explanation}` : judged.explanation;

    return {
      criterion,
      outcome: passed ? "passed" : "failed",
      passed,
      skipped: false,
      reason,
      confidence: judged.confidence,
      judge_model: cfg.model,
      judge_tokens_in: call.tokensIn,
      judge_tokens_out: call.tokensOut,
      judge_has_usage: call.hasUsage,
    };
  } catch (err) {
    if (err instanceof JudgeHttpError) {
      const reason = classifyJudgeError({ status: err.status, message: err.message });
      // FDRS-591 vs FDRS-611 split:
      //   errored — TRANSIENT infra failure the run could not control:
      //     rate_limited (429), upstream_5xx (5xx), provider_error.
      //   skipped — a SETUP / structural limit, like "no judge configured":
      //     auth_error (401/403 — bad/absent key) and context_too_large (the
      //     prompt structurally can't be judged by this model; author a [D]).
      // Either way `skipped` stays true so both are excluded from the
      // denominator and legacy cloud consumers are unaffected.
      const outcome: "skipped" | "errored" =
        reason === "auth_error" || reason === "context_too_large" ? "skipped" : "errored";
      return {
        criterion,
        passed: false,
        outcome,
        skipped: true,
        reason: formatErrorReason(reason, err.message),
        confidence: 0,
        judge_model: cfg.model,
        judge_tokens_in: 0,
        judge_tokens_out: 0,
        judge_has_usage: false,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      criterion,
      passed: false,
      // FDRS-591: an unexpected exception in the judge path is infra, not a
      // harness gap.
      outcome: "errored",
      skipped: true,
      reason: `judge call failed (unexpected): ${message}`,
      confidence: 0,
      judge_model: cfg.model,
      judge_tokens_in: 0,
      judge_tokens_out: 0,
      judge_has_usage: false,
    };
  }
}
