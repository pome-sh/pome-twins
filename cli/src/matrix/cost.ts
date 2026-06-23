// SPDX-License-Identifier: Apache-2.0
//
// Best-effort resource rollups over a cell run's events.jsonl.
//
// COST (plan decision — two-tier, nullable):
//   Tier 1: sum LlmCallEvent.cost_usd when the capture-server populated it.
//   Tier 2: a static pricing table (eval/pricing.json) applied to summed
//           prompt/completion tokens.
//   Else:   null (keyless scripted cells emit no LlmCallEvents — honest null,
//           never a fabricated 0).
//
// Judge tokens/cost are tracked separately in score.json (judge_tokens_in/out)
// and NEVER folded into agent cost here.
import type { Event, LlmCallEvent, TwinHttpEvent } from "../types/shared.js";

// { "<model>": { input_per_mtok, output_per_mtok } } — USD per million tokens.
export type PricingTable = Record<
  string,
  { input_per_mtok: number; output_per_mtok: number }
>;

// Resource metrics distilled from one run's events. Every field that depends on
// LlmCallEvent rows is nullable so scripted/keyless cells are honest.
export type RunResourceMetrics = {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number | null; // sum of LlmCallEvent latency
  tool_calls: number; // count of TwinHttpEvent rows the agent made
};

function isLlmCall(e: Event): e is LlmCallEvent {
  return e.kind === "LlmCallEvent";
}

function isTwinHttp(e: Event): e is TwinHttpEvent {
  return e.kind === "TwinHttpEvent";
}

// Sum a nullable numeric field across rows. Returns null when there are no rows
// to sum (so "no LLM calls" stays null, not 0); a present-but-null field on an
// existing row contributes 0 to the sum (treats a missing usage number as 0
// for that one call rather than nulling the whole cell).
function sumNullable(
  rows: LlmCallEvent[],
  pick: (e: LlmCallEvent) => number | null,
): number | null {
  if (rows.length === 0) return null;
  let sum = 0;
  for (const r of rows) sum += pick(r) ?? 0;
  return sum;
}

// Tier-2 fallback: price summed tokens against the static table. Null when the
// model is absent from the table or there are no tokens to price.
function priceFromTable(
  model: string | null,
  promptTokens: number | null,
  completionTokens: number | null,
  pricing: PricingTable,
): number | null {
  if (!model) return null;
  const row = pricing[model];
  if (!row) return null;
  if (promptTokens === null && completionTokens === null) return null;
  const inputCost = ((promptTokens ?? 0) / 1_000_000) * row.input_per_mtok;
  const outputCost = ((completionTokens ?? 0) / 1_000_000) * row.output_per_mtok;
  return inputCost + outputCost;
}

// Compute the per-run resource rollup. `pricing` may be empty ({}) — then only
// tier-1 (LlmCallEvent.cost_usd) can yield a non-null cost.
export function runResourceMetrics(
  events: Event[],
  pricing: PricingTable,
): RunResourceMetrics {
  const llm = events.filter(isLlmCall);
  const twin = events.filter(isTwinHttp);

  const prompt_tokens = sumNullable(llm, (e) => e.prompt_tokens);
  const completion_tokens = sumNullable(llm, (e) => e.completion_tokens);
  const latency_ms = sumNullable(llm, (e) => e.latency_ms);

  // Tier 1: do any LlmCallEvents carry a cost_usd? Sum them if so.
  const haveAnyCost = llm.some((e) => e.cost_usd !== null && e.cost_usd !== undefined);
  let cost_usd: number | null = null;
  if (haveAnyCost) {
    cost_usd = sumNullable(llm, (e) => e.cost_usd);
  } else {
    // Tier 2: price summed tokens off the static table. Models in a cell can
    // vary in theory, so price per-model then sum; an unpriced model nulls
    // only its own contribution but still lets known models count.
    cost_usd = costFromPricing(llm, prompt_tokens, completion_tokens, pricing);
  }

  return {
    prompt_tokens,
    completion_tokens,
    cost_usd,
    latency_ms,
    tool_calls: twin.length,
  };
}

// Tier-2 cost when no LlmCallEvent carried cost_usd. If every call shares the
// same model we price the cell-level token sums; otherwise we price each call's
// own tokens against its own model and sum, so a heterogeneous cell still
// yields the best available estimate (null only if NO call's model is priced).
function costFromPricing(
  llm: LlmCallEvent[],
  promptTokens: number | null,
  completionTokens: number | null,
  pricing: PricingTable,
): number | null {
  if (llm.length === 0) return null;
  const models = new Set(llm.map((e) => e.model));
  if (models.size === 1) {
    const [only] = [...models];
    return priceFromTable(only, promptTokens, completionTokens, pricing);
  }
  let total = 0;
  let anyPriced = false;
  for (const call of llm) {
    const c = priceFromTable(
      call.model,
      call.prompt_tokens,
      call.completion_tokens,
      pricing,
    );
    if (c !== null) {
      total += c;
      anyPriced = true;
    }
  }
  return anyPriced ? total : null;
}

// Mean of a nullable series, ignoring nulls. Null when every entry is null (so
// a column of all-null cells stays null in the rollup, not 0).
export function meanIgnoringNull(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0) / present.length;
}
