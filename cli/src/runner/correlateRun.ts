// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import {
  adapterSignalSchema,
  correlateAdapterRich,
  correlateHeuristic,
  type AdapterSignal,
} from "@pome-sh/correlator";
import type { RecorderEvent as CorrelatorRecorderEvent } from "@pome-sh/shared-types";
import type { Lane, RecorderEvent, Step } from "../types/shared.js";

/**
 * Wire the agent's adapter-signal stream into the OSS correlator.
 *
 * Adapter-rich path: when the signals file produced by the agent (via
 * `POME_ADAPTER_SIGNALS_PATH`) yields ≥1 valid signal, hand events + signals
 * to `correlateAdapterRich`. Heuristic path: otherwise fall through to
 * `correlateHeuristic(events)`. Both paths produce non-empty output for
 * non-empty event streams; empty events round-trip to empty arrays.
 *
 * Side effect (FDRS-360): for each event whose `request_id` appears in some
 * lane's `request_ids[]`, this function MUTATES `event.step_id` in place to
 * the owning lane's `step_id`. The dashboard's `<StateInspector>` filters
 * events by `e.step_id === selectedStep.id`, so without this back-fill the
 * state-mutation diff panel stays empty even when `state_delta` is populated.
 * Events with a request_id no lane claims are left unchanged.
 *
 * Robustness: a missing signals file, an empty file, malformed JSONL lines,
 * or signals that fail schema validation never crash the run — invalid lines
 * are dropped silently, and if no valid signals remain we fall back to the
 * heuristic path. The recorder event stream is the source of truth either
 * way.
 */
export async function correlateRun(
  signalsPath: string,
  events: RecorderEvent[]
): Promise<{ lanes: Lane[]; steps: Step[] }> {
  const signals = await readAdapterSignals(signalsPath);
  // Cast across the cli-local vs @pome-sh/shared-types `RecorderEvent`/`Lane`/
  // `Step` shapes — both are structurally identical zod-derived types but TS
  // treats them as distinct nominal-ish types. After the follow-up that drops
  // the local copy in src/types/shared.ts in favor of re-exporting from
  // @pome-sh/shared-types, these casts disappear.
  const correlatorEvents = events as unknown as CorrelatorRecorderEvent[];
  const output =
    signals.length > 0
      ? correlateAdapterRich(correlatorEvents, signals)
      : correlateHeuristic(correlatorEvents);
  const lanes = output.lanes as unknown as Lane[];
  const steps = output.steps as unknown as Step[];

  // FDRS-360: back-fill event.step_id. Build request_id → step_id map from
  // the lanes (each lane already carries its parent step_id), then walk events
  // once. O(L · max_lane_size + E).
  const requestIdToStepId = new Map<string, string>();
  for (const lane of lanes) {
    for (const requestId of lane.request_ids) {
      requestIdToStepId.set(requestId, lane.step_id);
    }
  }
  for (const event of events) {
    const stepId = requestIdToStepId.get(event.request_id);
    if (stepId !== undefined) {
      event.step_id = stepId;
    }
  }

  return { lanes, steps };
}

async function readAdapterSignals(path: string): Promise<AdapterSignal[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const signals: AdapterSignal[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const validated = adapterSignalSchema.safeParse(parsed);
    if (validated.success) signals.push(validated.data);
  }
  return signals;
}
