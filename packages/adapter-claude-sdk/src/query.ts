// SPDX-License-Identifier: Apache-2.0
import {
  query as sdkQuery,
  type HookCallbackMatcher,
  type HookEvent,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { buildPomeHooks } from "./hooks.js";
import { withGenAiSpans } from "./genai-spans.js";
import { withToolEvents } from "./wrapQuery.js";

type QueryParams = Parameters<typeof sdkQuery>[0];
type HooksConfig = Partial<Record<HookEvent, HookCallbackMatcher[]>>;

/**
 * Drop-in replacement for `@anthropic-ai/claude-agent-sdk`'s `query()`. The
 * returned async iterator yields every SDK message verbatim while attaching
 * pome's read-only `HookEvent` emitter to every SDK hook event (FDRS-407)
 * and emitting `ToolUseEvent` / `ToolResultEvent` rows for each tool_use /
 * tool_result content block observed in the message stream (FDRS-408).
 * User-supplied hooks in `params.options.hooks` are preserved — pome's
 * matchers are prepended per event so they fire alongside user callbacks.
 *
 * v0: returns an AsyncGenerator, not the full `Query` interface — control
 * methods (`interrupt`, `setPermissionMode`, …) are not re-exposed yet. Use
 * the underlying SDK directly if you need them.
 */
export function query(params: QueryParams): AsyncGenerator<SDKMessage, void, unknown> {
  // withGenAiSpans (outermost) reads each assistant turn's token usage and
  // emits gen_ai OTLP spans for the dashboard's Agent telemetry panel; it
  // flushes the exporter on the terminal `result` message. Inert when no OTLP
  // endpoint is configured.
  return withGenAiSpans<SDKMessage>(withToolEvents<SDKMessage>(sdkQuery(withPomeHooks(params))));
}

function withPomeHooks(params: QueryParams): QueryParams {
  const pomeHooks = buildPomeHooks();
  const userHooks = (params.options?.hooks ?? {}) as HooksConfig;
  const merged: HooksConfig = {};
  for (const key of Object.keys(pomeHooks) as HookEvent[]) {
    merged[key] = [...(pomeHooks[key] ?? []), ...(userHooks[key] ?? [])];
  }
  for (const key of Object.keys(userHooks) as HookEvent[]) {
    if (!merged[key]) merged[key] = [...(userHooks[key] ?? [])];
  }
  return {
    ...params,
    options: { ...(params.options ?? {}), hooks: merged },
  };
}
