// SPDX-License-Identifier: Apache-2.0
export type JudgeErrorReason =
  | "auth_error"
  | "rate_limited"
  | "upstream_5xx"
  | "context_too_large"
  | "provider_error";

export interface JudgeErrorInput {
  status: number;
  message: string;
}

export function classifyJudgeError(err: JudgeErrorInput): JudgeErrorReason {
  const message = err.message.toLowerCase();

  if (err.status === 401 || err.status === 403) return "auth_error";
  if (err.status === 429) return "rate_limited";

  if (err.status >= 500) {
    if (/\b429\b|resource exhausted|rate.?limit/.test(message)) return "rate_limited";
    return "upstream_5xx";
  }

  if (err.status === 400) {
    if (
      message.includes("too long") ||
      message.includes("context window") ||
      (message.includes("context length") && message.includes("tokens"))
    ) {
      return "context_too_large";
    }
  }

  return "provider_error";
}

export function formatErrorReason(reason: JudgeErrorReason, raw: string): string {
  switch (reason) {
    case "auth_error":
      return `judge auth failed (401/403): check your API key. Details: ${raw}`;
    case "rate_limited":
      return `judge rate limited: retry shortly. Details: ${raw}`;
    case "upstream_5xx":
      return `judge upstream 5xx: retry shortly. Details: ${raw}`;
    case "context_too_large":
      return `judge prompt too large for the model context window — consider [D] criteria for this scenario. Details: ${raw}`;
    case "provider_error":
      return `judge call failed: ${raw}`;
  }
}
