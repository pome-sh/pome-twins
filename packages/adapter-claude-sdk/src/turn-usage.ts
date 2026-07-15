// SPDX-License-Identifier: Apache-2.0
//
// withTurnUsage (F-766) — stream wrapper that emits one `LlmTurnEvent` per
// assistant turn into the signals JSONL (see signals.ts for the single-writer
// contract). It is the JSONL source-of-truth counterpart to the OTLP
// `withGenAiSpans` lane (genai-spans.ts): both use the SAME turn detection —
// every `assistant` message carrying `message.usage` is one LLM round-trip —
// but this lane also captures the cache-read / cache-creation token counts and
// `finish_reasons` that the OTLP side-lane drops, and it never reaches the
// OTLP exporter, so the two lanes stay independent (the OTLP lane is untouched).
//
// The span window is approximated from message timing exactly as genai-spans.ts
// does — start = the moment we began awaiting this turn (the previous yielded
// message), end = now — so `latency_ms` is an estimate and every M1 row is
// stamped `latency_ms_estimated: true` (the SDK surfaces no per-call API
// timing). `turn_index` is 0-based per `query()` stream. `parent_id` and
// `session_id` are null in M1.
//
// No signals path configured (standalone dev, or any run outside the pome CLI
// runner): `writeLlmTurnEvent` is a static noop, so this wrapper just passes
// messages through.

import { newEventId, writeLlmTurnEvent } from "./signals.js";

type WithType = { type?: string };

type AssistantLike = {
  type: "assistant";
  message?: { model?: unknown; usage?: unknown; stop_reason?: unknown };
};

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export async function* withTurnUsage<T extends WithType>(
  source: AsyncIterable<T>,
): AsyncGenerator<T, void, unknown> {
  // Boundary marking the start of the current turn. Initialized when iteration
  // begins; advanced after every yielded message so each turn's latency spans
  // only the gap since the previous message (matches genai-spans.ts).
  let turnStartMs = Date.now();
  // 0-based counter, per this query() stream. Advances only for turns that
  // actually reported usage (a usage-less assistant message is not a turn).
  let turnIndex = 0;

  for await (const msg of source) {
    if (msg.type === "assistant") {
      const a = msg as AssistantLike & WithType;
      const usage = (a.message?.usage ?? {}) as Record<string, unknown>;
      const inputTokens = asNumber(usage.input_tokens);
      const outputTokens = asNumber(usage.output_tokens);
      // Only a turn that reported usage is a real, completed LLM round-trip.
      if (inputTokens != null || outputTokens != null) {
        const stopReason = asString(a.message?.stop_reason);
        writeLlmTurnEvent({
          ts: new Date().toISOString(),
          event_id: newEventId(),
          parent_id: null,
          kind: "LlmTurnEvent",
          turn_index: turnIndex,
          model: asString(a.message?.model),
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_input_tokens: asNumber(usage.cache_read_input_tokens),
          cache_creation_input_tokens: asNumber(usage.cache_creation_input_tokens),
          finish_reasons: stopReason != null ? [stopReason] : null,
          latency_ms: Math.max(0, Date.now() - turnStartMs),
          latency_ms_estimated: true,
          session_id: null,
        });
        turnIndex += 1;
      }
    }

    yield msg;
    turnStartMs = Date.now();
  }
}
