// SPDX-License-Identifier: Apache-2.0
//
// correlateAdapterRich — adapter-rich correlator path. Pure function: no IO,
// no clock reads, no random ids, fully deterministic in the inputs. See the
// package README for the high-level shape; the algorithm in plain prose:
//
//   1. Each step signal opens a half-open time bracket [signal.ts, next.ts).
//      The last step's bracket is open-ended.
//   2. Each tool_call signal is bound to the step whose bracket contains its
//      timestamp. (Tool_call signals outside any bracket are dropped — the
//      adapter shouldn't emit them, but if it does they're orphan.)
//   3. Each RecorderEvent is bound to a step using identity first, fallback
//      second:
//        a. If `event.tool_call_id` matches a tool_call signal we've indexed,
//           use that signal's step. Identity wins over the bracket — slow
//           twin / clock-skew events still land where the adapter says they
//           belong.
//        b. Otherwise, time-bracket the event itself. Used by tool_call_id-less
//           events (heuristic-style) and adapter signals' own tool_call_ids
//           that we never saw.
//        c. If neither matches → synthetic step `stp_uncorrelated`. Events
//           are never dropped.
//   4. Within each step, group events by `${twin}|${method}|${stripped path}`.
//      Each group becomes a Lane. Lanes within a step are ordered by their
//      first event's ts (then twin/pattern as tiebreaker via insertion order).
//   5. Step `started_at` is the originating signal's ts (or the earliest
//      uncorrelated event's ts); `ended_at` is the latest event's ts (so the
//      lane-timeline UI knows the visible width of the step).

import type { Lane, RecorderEvent, Step } from "@pome-sh/shared-types";
import { type AdapterSignal, UNCORRELATED_STEP_ID } from "./types.js";

export interface CorrelateOutput {
  lanes: Lane[];
  steps: Step[];
}

// ISO 8601 with `Z` suffix sorts chronologically under lexicographic compare;
// avoid Date construction (clock-free + faster).
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// Strip the `/s/<sid>/...` session prefix that twin runtimes prepend so that
// repeated calls to the same twin endpoint with different session ids fold
// into one lane label. Falls through unchanged when the prefix isn't present.
const SESSION_PREFIX = /^\/s\/[^/]+(\/.*)$/;
function stripSessionPrefix(path: string): string {
  const m = SESSION_PREFIX.exec(path);
  return m ? m[1]! : path;
}

interface StepBracket {
  step_id: string;
  started_at: string;
  ended_at: string | null; // null = open-ended (last step in stream)
}

function findBracketStep(brackets: StepBracket[], ts: string): string | null {
  for (const b of brackets) {
    if (cmp(ts, b.started_at) < 0) continue;
    if (b.ended_at !== null && cmp(ts, b.ended_at) >= 0) continue;
    return b.step_id;
  }
  return null;
}

export function correlateAdapterRich(
  events: RecorderEvent[],
  adapterSignals: AdapterSignal[],
): CorrelateOutput {
  const sortedSignals = [...adapterSignals].sort((a, b) => cmp(a.ts, b.ts));

  // Step brackets. Dedupe by step_id (first occurrence wins) so a malformed
  // duplicate signal doesn't shift bracket boundaries silently.
  const brackets: StepBracket[] = [];
  const seenStepIds = new Set<string>();
  for (const sig of sortedSignals) {
    if (sig.type !== "step") continue;
    if (seenStepIds.has(sig.step_id)) continue;
    seenStepIds.add(sig.step_id);
    brackets.push({ step_id: sig.step_id, started_at: sig.ts, ended_at: null });
  }
  for (let i = 0; i < brackets.length - 1; i++) {
    brackets[i]!.ended_at = brackets[i + 1]!.started_at;
  }

  // tool_call_id → step_id, by bracketing the signal's own ts.
  const toolCallToStep = new Map<string, string>();
  for (const sig of sortedSignals) {
    if (sig.type !== "tool_call") continue;
    if (toolCallToStep.has(sig.tool_call_id)) continue;
    const stepId = findBracketStep(brackets, sig.ts);
    if (stepId !== null) toolCallToStep.set(sig.tool_call_id, stepId);
  }

  // Bucket events by resolved step_id.
  const buckets = new Map<string, RecorderEvent[]>();
  const pushBucket = (stepId: string, e: RecorderEvent): void => {
    const list = buckets.get(stepId);
    if (list) list.push(e);
    else buckets.set(stepId, [e]);
  };
  for (const e of events) {
    let stepId: string | null = null;
    if (e.tool_call_id !== null && toolCallToStep.has(e.tool_call_id)) {
      stepId = toolCallToStep.get(e.tool_call_id)!;
    } else {
      stepId = findBracketStep(brackets, e.ts);
    }
    pushBucket(stepId ?? UNCORRELATED_STEP_ID, e);
  }

  // Emit steps in signal-emission order (only those with events), then the
  // synthetic uncorrelated step last if it has events.
  const orderedStepIds: string[] = [];
  for (const b of brackets) if (buckets.has(b.step_id)) orderedStepIds.push(b.step_id);
  if (buckets.has(UNCORRELATED_STEP_ID)) orderedStepIds.push(UNCORRELATED_STEP_ID);

  const steps: Step[] = [];
  const allLanes: Lane[] = [];

  for (const stepId of orderedStepIds) {
    const sortedEvents = [...buckets.get(stepId)!].sort((a, b) => cmp(a.ts, b.ts));

    // Group by (twin, method, stripped path). Insertion order = first-event-ts
    // order because we iterate already-sorted events.
    const laneMap = new Map<string, RecorderEvent[]>();
    const laneKeys: string[] = [];
    for (const e of sortedEvents) {
      const stripped = stripSessionPrefix(e.path);
      const key = `${e.twin}|${e.method}|${stripped}`;
      const list = laneMap.get(key);
      if (list) {
        list.push(e);
      } else {
        laneMap.set(key, [e]);
        laneKeys.push(key);
      }
    }

    const stepLanes: Lane[] = laneKeys.map((key, idx) => {
      const laneEvents = laneMap.get(key)!;
      const first = laneEvents[0]!;
      const stripped = stripSessionPrefix(first.path);
      const word = laneEvents.length === 1 ? "call" : "calls";
      return {
        id: `${stepId}__l${idx}`,
        step_id: stepId,
        twin: first.twin,
        label: `${first.method} ${stripped} (${laneEvents.length} ${word})`,
        request_ids: laneEvents.map((e) => e.request_id),
      };
    });

    const bracket = brackets.find((b) => b.step_id === stepId);
    const earliestEvent = sortedEvents[0]!.ts;
    const latestEvent = sortedEvents[sortedEvents.length - 1]!.ts;
    const started_at = bracket
      ? // Step started when the signal fired; if the bracket signal post-dates
        // the events bound to it via tool_call_id, fall back to the earliest
        // event so started_at <= ended_at always holds.
        cmp(bracket.started_at, earliestEvent) <= 0
        ? bracket.started_at
        : earliestEvent
      : earliestEvent;
    const ended_at = cmp(latestEvent, started_at) >= 0 ? latestEvent : started_at;

    steps.push({
      id: stepId,
      started_at,
      ended_at,
      label: null,
      lane_ids: stepLanes.map((l) => l.id),
    });
    allLanes.push(...stepLanes);
  }

  return { lanes: allLanes, steps };
}
