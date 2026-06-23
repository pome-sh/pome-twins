// SPDX-License-Identifier: Apache-2.0
//
// Pome hook handlers — one read-only `HookEvent` emitter per SDK hook event.
//
// FDRS-407: hooks are uniform metadata writers. They observe; never mutate
// the event the SDK passes them. ToolUseEvent / ToolResultEvent payloads are
// emitted from the message-stream wrapper (FDRS-408), not from PreToolUse /
// PostToolUse hooks — this keeps `HookEvent` thin (audit trail) and lets the
// payload-bearing rows carry full inputs/outputs.
//
// Hook coverage: every entry in `HOOK_EVENTS` from
// `@anthropic-ai/claude-agent-sdk`. Adding a new hook category in a future
// SDK version is auto-covered; the iteration is over the SDK constant, not a
// hardcoded list.

import {
  HOOK_EVENTS,
  type HookCallbackMatcher,
  type HookEvent,
  type HookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { newEventId, writeHookEvent } from "./signals.js";

function readToolName(input: HookInput): string | null {
  const obj = input as Record<string, unknown>;
  const v = obj["tool_name"];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function readToolUseId(input: HookInput): string | null {
  const obj = input as Record<string, unknown>;
  const v = obj["tool_use_id"];
  return typeof v === "string" && v.length > 0 ? v : null;
}

// Build the `hooks` config to merge into the SDK's query `options`. Every
// known hook event gets a single matcher whose only callback is the pome
// emitter; the SDK applies all matchers (pome + user-supplied) for an event,
// so wiring this in is non-destructive.
export function buildPomeHooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const out: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  for (const event of HOOK_EVENTS) {
    out[event] = [
      {
        hooks: [
          async (input, toolUseID) => {
            // `parent_id`: prefer the SDK's explicit `toolUseID` callback
            // arg, then `input.tool_use_id` (carried on tool-scoped hook
            // payloads like PostToolUseFailure / PermissionDenied / etc.),
            // else null. Per the M0 schema, `null` marks the root of a
            // parent chain (e.g. SessionStart, top-level Setup) and is
            // valid — the downstream correlator (FDRS-412) does ts-ordered
            // insertion without requiring parent links on every row.
            const parent_id = toolUseID ?? readToolUseId(input) ?? null;
            writeHookEvent({
              ts: new Date().toISOString(),
              event_id: newEventId(),
              parent_id,
              kind: "HookEvent",
              hook_name: event,
              tool_name: readToolName(input),
            });
            // Read-only hook: always continue.
            return { continue: true };
          },
        ],
      },
    ];
  }
  return out;
}
