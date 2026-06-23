import { describe, expect, it } from "vitest";
import { scoreResults, type CriterionResult } from "../../../src/evaluator/score.js";

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
  });
});
