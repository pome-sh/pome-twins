// SPDX-License-Identifier: Apache-2.0
export type JudgeConfigSource = "pome_llm" | "openai_env" | "anthropic_env";

export interface JudgeConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  source: JudgeConfigSource;
}

/**
 * Resolves the LLM judge config from env. Priority:
 *   1. POME_LLM_BASE_URL + POME_LLM_API_KEY + POME_LLM_MODEL (all required if any set)
 *   2. OPENAI_API_KEY → OpenAI proper, model gpt-4o-mini
 *   3. ANTHROPIC_API_KEY → Anthropic OpenAI-compat endpoint, model claude-haiku-4-5
 *   4. None → null (caller should skip [P] criteria with friendly warning)
 *
 * Returns null when no judge is configured. Throws if POME_LLM_BASE_URL is set
 * but the companion API_KEY or MODEL env vars are missing — explicit user
 * intent should not be silently downgraded.
 */
export function resolveJudgeConfig(): JudgeConfig | null {
  const baseUrl = process.env.POME_LLM_BASE_URL;
  const apiKey = process.env.POME_LLM_API_KEY;
  const model = process.env.POME_LLM_MODEL;

  if (baseUrl) {
    if (!apiKey) {
      throw new Error(
        "POME_LLM_BASE_URL is set but POME_LLM_API_KEY is missing — set both or unset all three to fall back to OPENAI_API_KEY/ANTHROPIC_API_KEY.",
      );
    }
    if (!model) {
      throw new Error(
        "POME_LLM_BASE_URL is set but POME_LLM_MODEL is missing — set both or unset all three to fall back to OPENAI_API_KEY/ANTHROPIC_API_KEY.",
      );
    }
    return { baseUrl, apiKey, model, source: "pome_llm" };
  }

  const oai = process.env.OPENAI_API_KEY;
  if (oai) {
    return {
      baseUrl: "https://api.openai.com/v1",
      apiKey: oai,
      model: "gpt-4o-mini",
      source: "openai_env",
    };
  }

  const ant = process.env.ANTHROPIC_API_KEY;
  if (ant) {
    return {
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: ant,
      model: "claude-haiku-4-5",
      source: "anthropic_env",
    };
  }

  return null;
}
