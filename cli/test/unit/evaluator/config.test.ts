import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveJudgeConfig } from "../../../src/evaluator/probabilistic/config.js";

const KEYS = [
  "POME_LLM_BASE_URL",
  "POME_LLM_API_KEY",
  "POME_LLM_MODEL",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("resolveJudgeConfig", () => {
  it("returns null when no env vars are set", () => {
    expect(resolveJudgeConfig()).toBeNull();
  });

  it("uses POME_LLM_* when fully configured", () => {
    process.env.POME_LLM_BASE_URL = "https://example.com/v1";
    process.env.POME_LLM_API_KEY = "sk-test";
    process.env.POME_LLM_MODEL = "test-model";
    const cfg = resolveJudgeConfig();
    expect(cfg).toEqual({
      baseUrl: "https://example.com/v1",
      apiKey: "sk-test",
      model: "test-model",
      source: "pome_llm",
    });
  });

  it("POME_LLM_* takes precedence over OPENAI_API_KEY", () => {
    process.env.POME_LLM_BASE_URL = "https://example.com/v1";
    process.env.POME_LLM_API_KEY = "sk-test";
    process.env.POME_LLM_MODEL = "test-model";
    process.env.OPENAI_API_KEY = "sk-oai";
    expect(resolveJudgeConfig()?.source).toBe("pome_llm");
  });

  it("throws if POME_LLM_BASE_URL is set without POME_LLM_API_KEY", () => {
    process.env.POME_LLM_BASE_URL = "https://example.com/v1";
    process.env.POME_LLM_MODEL = "test-model";
    expect(() => resolveJudgeConfig()).toThrowError(/POME_LLM_API_KEY/);
  });

  it("throws if POME_LLM_BASE_URL is set without POME_LLM_MODEL", () => {
    process.env.POME_LLM_BASE_URL = "https://example.com/v1";
    process.env.POME_LLM_API_KEY = "sk-test";
    expect(() => resolveJudgeConfig()).toThrowError(/POME_LLM_MODEL/);
  });

  it("falls back to OPENAI_API_KEY", () => {
    process.env.OPENAI_API_KEY = "sk-oai";
    const cfg = resolveJudgeConfig();
    expect(cfg).toEqual({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-oai",
      model: "gpt-4o-mini",
      source: "openai_env",
    });
  });

  it("OPENAI takes precedence over ANTHROPIC", () => {
    process.env.OPENAI_API_KEY = "sk-oai";
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    expect(resolveJudgeConfig()?.source).toBe("openai_env");
  });

  it("falls back to ANTHROPIC_API_KEY via OpenAI-compat endpoint", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    const cfg = resolveJudgeConfig();
    expect(cfg).toEqual({
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-ant",
      model: "claude-haiku-4-5",
      source: "anthropic_env",
    });
  });
});
