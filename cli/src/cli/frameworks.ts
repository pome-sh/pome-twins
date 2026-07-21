// SPDX-License-Identifier: Apache-2.0
//
// Client-side did-you-mean for the manifest's open-enum `agent.framework`
// (F-804 / F-819). An unknown framework is NEVER a validation error — the
// manifest schema keeps it a free string. We only surface a friendly warning
// with the nearest known value so a typo like "langraph" is caught locally
// before it reaches the dashboard badge.

/** Known agent frameworks. Open enum by design — this list drives the warning
 *  suggestion only, never a hard rejection. */
export const KNOWN_FRAMEWORKS = [
  "langgraph",
  "claude-agent-sdk",
  "openai-agents",
  "crewai",
  "autogen",
  "llamaindex",
  "google-adk",
  "mastra",
  "pydantic-ai",
  "semantic-kernel",
] as const;

const MAX_SUGGEST_DISTANCE = 2;

export interface FrameworkSuggestion {
  known: boolean;
  /** Present only when unknown AND a known framework is within edit distance. */
  suggestion?: string;
}

/** Classify a framework value. Known → `{ known: true }`. Unknown → `{ known:
 *  false }`, with `suggestion` set to the nearest known value within edit
 *  distance 2 (else omitted). Comparison is case-insensitive. */
export function suggestFramework(input: string): FrameworkSuggestion {
  const value = input.trim().toLowerCase();
  if ((KNOWN_FRAMEWORKS as readonly string[]).includes(value)) {
    return { known: true };
  }
  let best: string | undefined;
  let bestDistance = MAX_SUGGEST_DISTANCE + 1;
  for (const known of KNOWN_FRAMEWORKS) {
    const distance = levenshtein(value, known);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = known;
    }
  }
  if (best !== undefined && bestDistance <= MAX_SUGGEST_DISTANCE) {
    return { known: false, suggestion: best };
  }
  return { known: false };
}

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const prev = new Array<number>(cols);
  const curr = new Array<number>(cols);
  for (let j = 0; j < cols; j += 1) prev[j] = j;
  for (let i = 1; i < rows; i += 1) {
    curr[0] = i;
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j < cols; j += 1) prev[j] = curr[j]!;
  }
  return prev[cols - 1]!;
}
