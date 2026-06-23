// SPDX-License-Identifier: Apache-2.0
//
// Pure-function merge of two M0-unified event streams into one ts-ordered
// stream. FDRS-412.
//
// `events` is the parsed contents of events.jsonl (twin HTTP + LlmCallEvent
// rows written by the capture-server and twin recorders). `signals` is the
// parsed contents of signals.jsonl (HookEvent / ToolUseEvent /
// ToolResultEvent / SubagentSpawnEvent rows written by adapter-claude-sdk
// per `POME_ADAPTER_SIGNALS_PATH`).
//
// The capture-server appends LlmCallEvent rows when each CONNECT tunnel
// closes, so events.jsonl is not guaranteed to be chronologically sorted at
// write time. The merge therefore re-sorts both streams together rather than
// blind-appending signals at the end. Stable sort: equal-ts rows preserve
// input order (events first, then signals).
//
// Returns a fresh array. Inputs are not mutated. No IO; deterministic in the
// inputs (matches the rest of `@pome-sh/correlator`'s purity contract).

import type { Event } from "@pome-sh/shared-types";

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function mergeSignalsIntoEvents(events: Event[], signals: Event[]): Event[] {
  const merged = events.concat(signals);
  merged.sort((a, b) => cmp(a.ts, b.ts));
  return merged;
}
