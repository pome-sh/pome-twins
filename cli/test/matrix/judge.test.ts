// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the matrix judge-env resolver (upgrade #1). Pure over an
// injected env — the routing decision is exercised without process.env or any
// network call.
import { describe, expect, it } from "vitest";
import {
  resolveJudgeEnv,
  GATEWAY_OPENAI_BASE_URL,
  OPENAI_BASE_URL,
} from "../../src/matrix/judge.js";

describe("resolveJudgeEnv", () => {
  it("returns no judge env when --judge-model is unset (preserves skip behavior)", () => {
    const r = resolveJudgeEnv(undefined, { AI_GATEWAY_API_KEY: "vck_x" });
    expect(r.env).toEqual({});
    expect(r.note).toMatch(/no --judge-model/);
  });

  it("routes the judge model through the Vercel AI Gateway when the key is present", () => {
    const r = resolveJudgeEnv("anthropic/claude-haiku-4-5", {
      AI_GATEWAY_API_KEY: "vck_secret",
    });
    expect(r.env).toEqual({
      POME_LLM_BASE_URL: GATEWAY_OPENAI_BASE_URL,
      POME_LLM_API_KEY: "vck_secret",
      POME_LLM_MODEL: "anthropic/claude-haiku-4-5",
    });
    expect(r.note).toContain("Vercel AI Gateway");
  });

  it("falls back to OpenAI direct when only OPENAI_API_KEY is set", () => {
    const r = resolveJudgeEnv("gpt-4o-mini", { OPENAI_API_KEY: "sk-test" });
    expect(r.env.POME_LLM_BASE_URL).toBe(OPENAI_BASE_URL);
    expect(r.env.POME_LLM_API_KEY).toBe("sk-test");
    expect(r.env.POME_LLM_MODEL).toBe("gpt-4o-mini");
  });

  it("prefers the gateway over a bare OPENAI_API_KEY", () => {
    const r = resolveJudgeEnv("openai/gpt-5", {
      AI_GATEWAY_API_KEY: "vck_x",
      OPENAI_API_KEY: "sk-test",
    });
    expect(r.env.POME_LLM_BASE_URL).toBe(GATEWAY_OPENAI_BASE_URL);
    expect(r.env.POME_LLM_API_KEY).toBe("vck_x");
  });

  it("respects a pre-set POME_LLM_BASE_URL and injects nothing (operator config wins)", () => {
    const r = resolveJudgeEnv("anything", {
      POME_LLM_BASE_URL: "http://localhost:11434/v1",
      POME_LLM_MODEL: "qwen2.5",
      AI_GATEWAY_API_KEY: "vck_x",
    });
    expect(r.env).toEqual({});
    expect(r.note).toMatch(/pre-set POME_LLM/);
  });

  it("returns no judge env (with an explanatory note) when nothing can route the model", () => {
    const r = resolveJudgeEnv("anthropic/claude-haiku-4-5", {});
    expect(r.env).toEqual({});
    expect(r.note).toMatch(/no AI_GATEWAY_API_KEY/);
  });

  it("treats a blank gateway key as absent", () => {
    const r = resolveJudgeEnv("m", { AI_GATEWAY_API_KEY: "   " });
    expect(r.env).toEqual({});
  });
});
