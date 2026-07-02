import { describe, expect, it } from "vitest";
import {
  scoreResults,
  scenarioPassed,
  scoreStatus,
  outcomeOf,
  type CriterionResult,
} from "../../../src/evaluator/score.js";

const dCrit = { type: "D" as const, text: "Issue has bug label" };
const pCrit = { type: "P" as const, text: "Label is contextually appropriate" };

describe("scoreResults", () => {
  it("returns null judge fields when no [P] results are present", () => {
    const results: CriterionResult[] = [
      { criterion: dCrit, passed: true, skipped: false, reason: "ok" },
    ];
    const score = scoreResults(results);
    expect(score.satisfaction).toBe(100);
    expect(score.judge_model).toBeNull();
    expect(score.judge_tokens_in).toBeNull();
    expect(score.judge_tokens_out).toBeNull();
  });

  it("aggregates judge_model + tokens across [P] results", () => {
    const results: CriterionResult[] = [
      { criterion: dCrit, passed: true, skipped: false, reason: "ok" },
      {
        criterion: pCrit,
        passed: true,
        skipped: false,
        reason: "judge: pass",
        confidence: 0.9,
        judge_model: "gpt-4o-mini",
        judge_tokens_in: 800,
        judge_tokens_out: 50,
        judge_has_usage: true,
      },
      {
        criterion: pCrit,
        passed: false,
        skipped: false,
        reason: "PARTIAL: incomplete",
        confidence: 0.6,
        judge_model: "gpt-4o-mini",
        judge_tokens_in: 700,
        judge_tokens_out: 40,
        judge_has_usage: true,
      },
    ];
    const score = scoreResults(results);
    expect(score.judge_model).toBe("gpt-4o-mini");
    expect(score.judge_tokens_in).toBe(1500);
    expect(score.judge_tokens_out).toBe(90);
  });

  it("returns null token sums if any [P] call lacked usage", () => {
    const results: CriterionResult[] = [
      {
        criterion: pCrit,
        passed: true,
        skipped: false,
        reason: "ok",
        confidence: 0.8,
        judge_model: "ollama-local",
        judge_tokens_in: 0,
        judge_tokens_out: 0,
        judge_has_usage: false,
      },
    ];
    const score = scoreResults(results);
    expect(score.judge_model).toBe("ollama-local");
    expect(score.judge_tokens_in).toBeNull();
    expect(score.judge_tokens_out).toBeNull();
  });

  it("counts skipped [P] calls in skipped, not failed", () => {
    const results: CriterionResult[] = [
      { criterion: dCrit, passed: true, skipped: false, reason: "ok" },
      {
        criterion: pCrit,
        passed: false,
        skipped: true,
        reason: "judge auth failed: 401",
        confidence: 0,
        judge_model: "gpt-4o-mini",
        judge_tokens_in: 0,
        judge_tokens_out: 0,
        judge_has_usage: false,
      },
    ];
    const score = scoreResults(results);
    expect(score.passed).toBe(1);
    expect(score.failed).toBe(0);
    expect(score.skipped).toBe(1);
    expect(score.satisfaction).toBe(100); // 1 of 1 required passed
    expect(score.can_pass).toBe(false);
    expect(scoreStatus(score, 100)).toBe("unevaluated");
  });
});

// FDRS-591/611 unified outcome model.
describe("scoreResults — outcome model (FDRS-591/611)", () => {
  const dCrit = { type: "D" as const, text: "criterion" };
  const passedR = (): CriterionResult => ({ criterion: dCrit, outcome: "passed", passed: true, skipped: false, reason: "" });
  const failedR = (): CriterionResult => ({ criterion: dCrit, outcome: "failed", passed: false, skipped: false, reason: "" });
  const skippedR = (): CriterionResult => ({ criterion: dCrit, outcome: "skipped", passed: false, skipped: true, reason: "" });
  const erroredR = (): CriterionResult => ({ criterion: dCrit, outcome: "errored", passed: false, skipped: true, reason: "" });

  it("counts errored separately from skipped and excludes both from the denominator", () => {
    const score = scoreResults([passedR(), failedR(), skippedR(), erroredR()]);
    expect(score.passed).toBe(1);
    expect(score.failed).toBe(1);
    expect(score.skipped).toBe(1);
    expect(score.errored).toBe(1);
    expect(score.total_required).toBe(2);
    expect(score.satisfaction).toBe(50); // 1 / (1 + 1)
  });

  it("an all-skipped run is un-evaluated (evaluated=false), never 0%", () => {
    const score = scoreResults([skippedR(), skippedR()]);
    expect(score.evaluated).toBe(false);
    expect(score.can_pass).toBe(false);
    expect(score.satisfaction).toBe(0); // numeric 0, but…
    expect(scoreStatus(score, 100)).toBe("unevaluated"); // …renders as un-evaluated
    expect(scenarioPassed(score, 100)).toBe(false);
  });

  it("an all-errored run is un-evaluated, never a hard fail", () => {
    const score = scoreResults([erroredR(), erroredR()]);
    expect(score.evaluated).toBe(false);
    expect(score.errored).toBe(2);
    expect(scoreStatus(score, 100)).toBe("unevaluated");
  });

  it("A5 guard: 1 passed + 9 skipped is 100% satisfaction but CANNOT pass", () => {
    const results = [passedR(), ...Array.from({ length: 9 }, skippedR)];
    const score = scoreResults(results);
    expect(score.satisfaction).toBe(100); // the false-confidence number
    expect(score.can_pass).toBe(false); // …but the A5 guard blocks the pass
    expect(scenarioPassed(score, 100)).toBe(false);
    expect(scoreStatus(score, 100)).toBe("unevaluated");
  });

  it("all-passed clears the guard and passes at threshold", () => {
    const score = scoreResults([passedR(), passedR()]);
    expect(score.can_pass).toBe(true);
    expect(score.evaluated).toBe(true);
    expect(scenarioPassed(score, 100)).toBe(true);
    expect(scoreStatus(score, 100)).toBe("pass");
  });

  it("a fully-evaluated run below threshold is a real FAIL (not un-evaluated)", () => {
    const score = scoreResults([passedR(), failedR()]);
    expect(score.can_pass).toBe(true);
    expect(scoreStatus(score, 100)).toBe("fail");
    expect(scenarioPassed(score, 100)).toBe(false);
  });

  it("outcomeOf derives from legacy passed/skipped when outcome is absent", () => {
    expect(outcomeOf({ criterion: dCrit, passed: true, skipped: false, reason: "" })).toBe("passed");
    expect(outcomeOf({ criterion: dCrit, passed: false, skipped: false, reason: "" })).toBe("failed");
    expect(outcomeOf({ criterion: dCrit, passed: false, skipped: true, reason: "" })).toBe("skipped");
  });
});
