// SPDX-License-Identifier: Apache-2.0
//
// `@pome-sh/correlator` — pure functions that turn recorder events (+ optional
// adapter signals) into the `{ lanes, steps }` shape rendered by the dashboard.
// See README for the two paths (adapter-rich, heuristic) and the constraints.

export { correlateAdapterRich } from "./correlateAdapterRich.js";
export type { CorrelateOutput } from "./correlateAdapterRich.js";
export { correlateHeuristic } from "./heuristic.js";
export type { CorrelatorOptions } from "./heuristic.js";
export { mergeSignalsIntoEvents } from "./mergeSignalsIntoEvents.js";
export {
  adapterSignalSchema,
  stepSignalSchema,
  toolCallSignalSchema,
  UNCORRELATED_STEP_ID,
} from "./types.js";
export type { AdapterSignal, StepSignal, ToolCallSignal } from "./types.js";
