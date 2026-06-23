// SPDX-License-Identifier: Apache-2.0
import type { JudgeConfig } from "./config.js";

const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 1024;
const ANTHROPIC_VERSION = "2023-06-01";

export class JudgeHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "JudgeHttpError";
    this.status = status;
  }
}

export interface JudgeCallResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  hasUsage: boolean;
}

function buildHeaders(cfg: JudgeConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (cfg.source === "anthropic_env") {
    headers["x-api-key"] = cfg.apiKey;
    headers["anthropic-version"] = ANTHROPIC_VERSION;
  } else {
    headers.authorization = `Bearer ${cfg.apiKey}`;
  }
  return headers;
}

export async function callJudge(
  cfg: JudgeConfig,
  systemPrompt: string,
  userPrompt: string,
  options: { maxTokens?: number } = {},
): Promise<JudgeCallResult> {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const body = JSON.stringify({
    model: cfg.model,
    temperature: 0,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: buildHeaders(cfg),
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    const isAbort = err instanceof Error && err.name === "AbortError";
    const message = isAbort
      ? `judge request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
      : err instanceof Error
        ? err.message
        : String(err);
    throw new JudgeHttpError(0, isAbort ? message : `network error: ${message}`);
  }
  clearTimeout(timeout);

  let rawText: string;
  try {
    rawText = await response.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new JudgeHttpError(0, `failed to read response body: ${message}`);
  }
  if (!response.ok) {
    throw new JudgeHttpError(response.status, rawText.slice(0, 500));
  }

  let parsed: {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new JudgeHttpError(0, `non-JSON response from LLM: ${rawText.slice(0, 200)}`);
  }

  const text = parsed.choices?.[0]?.message?.content ?? "";
  const usage = parsed.usage;
  const hasUsage =
    typeof usage?.prompt_tokens === "number" && typeof usage?.completion_tokens === "number";

  return {
    text,
    tokensIn: hasUsage ? (usage!.prompt_tokens ?? 0) : 0,
    tokensOut: hasUsage ? (usage!.completion_tokens ?? 0) : 0,
    hasUsage,
  };
}
