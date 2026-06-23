// SPDX-License-Identifier: Apache-2.0
//
// Heuristic correlator (FDRS-325). Pure function, deterministic.
//
// Algorithm: see `../README.md` § Algorithm. The two rules:
//   1. Endpoint family change → new step.
//   2. Time gap > gapMs from previous event → new step.
// Lanes within a step group by (method, family). IDs are ordinal,
// zero-padded, prefixed with `h` to distinguish from adapter-rich IDs.

import type { Lane, RecorderEvent, Step } from "@pome-sh/shared-types";
import type { CorrelateOutput } from "./correlateAdapterRich.js";
import { endpointFamily } from "./endpoint-family.js";

export interface CorrelatorOptions {
  /** Min ts gap (ms) from previous event that forces a new step. Default 500. */
  gapMs?: number;
}

const DEFAULT_GAP_MS = 500;

export function correlateHeuristic(
  events: RecorderEvent[],
  options: CorrelatorOptions = {},
): CorrelateOutput {
  if (events.length === 0) return { lanes: [], steps: [] };

  const gapMs = options.gapMs ?? DEFAULT_GAP_MS;

  // Stable sort by ts. Equal-ts events preserve input order — recorder
  // buffers are append-order, and a lexical request_id tiebreak would
  // shuffle co-millisecond bursts (e.g. the bundled refund-retry trace
  // where the second refund POST and the verify-charge GET share a ts).
  const ordered = [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  // First pass: walk events and bucket them into step indices.
  const stepIndexByEvent: number[] = [];
  let currentStep = 0;
  let prevTs: number | null = null;
  let prevFamily: string | null = null;

  for (const ev of ordered) {
    const family = endpointFamily(ev.path);
    const ts = Date.parse(ev.ts);
    if (prevFamily === null) {
      // First event always starts step 0.
    } else if (family !== prevFamily || ts - (prevTs ?? ts) > gapMs) {
      currentStep += 1;
    }
    stepIndexByEvent.push(currentStep);
    prevFamily = family;
    prevTs = ts;
  }

  const stepCount = currentStep + 1;

  // Second pass: within each step, bucket events by (method, family) → lane.
  // Keep lane buckets ordered by first-appearance for deterministic output.
  type LaneBucket = {
    method: string;
    family: string;
    twin: string;
    request_ids: string[];
    laneIndex: number;
  };
  const lanesByStep: LaneBucket[][] = Array.from({ length: stepCount }, () => []);

  for (let i = 0; i < ordered.length; i += 1) {
    const ev = ordered[i]!;
    const stepIdx = stepIndexByEvent[i]!;
    const family = endpointFamily(ev.path);
    const bucketKey = `${ev.method} ${family}`;
    const buckets = lanesByStep[stepIdx]!;
    let bucket = buckets.find((b) => `${b.method} ${b.family}` === bucketKey);
    if (!bucket) {
      bucket = {
        method: ev.method,
        family,
        twin: ev.twin,
        request_ids: [],
        laneIndex: buckets.length,
      };
      buckets.push(bucket);
    }
    bucket.request_ids.push(ev.request_id);
  }

  // Third pass: emit Step[] + Lane[] in render order.
  const steps: Step[] = [];
  const lanes: Lane[] = [];
  for (let s = 0; s < stepCount; s += 1) {
    const stepId = `stp_h${pad2(s)}`;
    const buckets = lanesByStep[s]!;
    const requestIdSet = new Set(buckets.flatMap((b) => b.request_ids));
    const stepEvents = ordered.filter((ev) => requestIdSet.has(ev.request_id));
    const startedAt = stepEvents[0]!.ts;
    const endedAt = stepEvents[stepEvents.length - 1]!.ts;
    const laneIds: string[] = [];
    for (const bucket of buckets) {
      const laneId = `ln_h${pad2(s)}_${pad2(bucket.laneIndex)}`;
      laneIds.push(laneId);
      lanes.push({
        id: laneId,
        step_id: stepId,
        twin: bucket.twin,
        label: laneLabel(bucket.method, bucket.family, bucket.request_ids.length),
        request_ids: bucket.request_ids,
      });
    }
    steps.push({
      id: stepId,
      started_at: startedAt,
      ended_at: endedAt,
      label: null,
      lane_ids: laneIds,
    });
  }

  return { lanes, steps };
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function laneLabel(method: string, family: string, count: number): string {
  const noun = count === 1 ? "call" : "calls";
  return `${method} ${family} (${count} ${noun})`;
}
