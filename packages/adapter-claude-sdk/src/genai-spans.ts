// SPDX-License-Identifier: Apache-2.0
//
// withGenAiSpans — stream wrapper that turns the SDK message stream into
// `gen_ai` OTLP spans (see otel.ts for the why and the wire contract).
//
// One CLIENT span per assistant turn: every `assistant` message that carries
// `message.usage` is one LLM round-trip, so it becomes one span tagged with the
// model and that turn's input/output tokens. The span window is approximated
// from message timing — start = the moment we began awaiting this turn (the
// previous yielded message), end = now — which yields real p50/p95 latency
// samples for the rollup without needing per-call API timings the SDK doesn't
// surface per turn.
//
// On the terminal `result` message we `await flushPomeTelemetry()` BEFORE
// yielding it, so all spans are exported before the agent's loop ends and it
// calls process.exit() — pome's CLI reads the session trace blob immediately
// after the agent returns (the finalize-before-flush contract).

import { flushPomeTelemetry, recordGenAiSpan } from "./otel.js";

type WithType = { type?: string };

type AssistantLike = {
  type: "assistant";
  message?: { model?: unknown; usage?: unknown };
  error?: unknown;
};

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export async function* withGenAiSpans<T extends WithType>(
  source: AsyncIterable<T>,
): AsyncGenerator<T, void, unknown> {
  // Boundary marking the start of the current turn. Initialized when iteration
  // begins; advanced after every yielded message so each assistant span spans
  // only the gap since the previous message.
  let turnStartMs = Date.now();

  for await (const msg of source) {
    if (msg.type === "assistant") {
      const a = msg as AssistantLike & WithType;
      const usage = (a.message?.usage ?? {}) as Record<string, unknown>;
      const inputTokens = asNumber(usage.input_tokens);
      const outputTokens = asNumber(usage.output_tokens);
      // Only a turn that reported usage is a real, completed LLM round-trip.
      if (inputTokens != null || outputTokens != null) {
        recordGenAiSpan({
          model: typeof a.message?.model === "string" ? a.message.model : null,
          inputTokens,
          outputTokens,
          startTimeMs: turnStartMs,
          endTimeMs: Date.now(),
          isError: a.error != null,
        });
      }
    } else if (msg.type === "result") {
      // Drain the exporter before the final message escapes to the agent's
      // loop, which exits the process right after.
      await flushPomeTelemetry();
    }

    yield msg;
    turnStartMs = Date.now();
  }
}
