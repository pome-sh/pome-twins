// SPDX-License-Identifier: Apache-2.0
import type { Criterion } from "../../scenario/scenarioSchema.js";
import type { RecorderEvent } from "../../types/shared.js";
import type { CriterionResult } from "../score.js";

export interface DeterministicEvaluator {
  twin: string;
  canEvaluate(criterion: Criterion, state: unknown): boolean;
  evaluate(
    criterion: Criterion,
    initialState: unknown,
    finalState: unknown,
    events: RecorderEvent[],
  ): CriterionResult;
}

export type DispatchInput = {
  twinId: string;
  criterion: Criterion;
  initialState: unknown;
  finalState: unknown;
  events: RecorderEvent[];
};

export type TwinPluginRegistry = {
  register(plugin: DeterministicEvaluator): void;
  dispatch(input: DispatchInput): CriterionResult;
};

export function createTwinPluginRegistry(): TwinPluginRegistry {
  const plugins = new Map<string, DeterministicEvaluator>();

  return {
    register(plugin) {
      plugins.set(plugin.twin, plugin);
    },
    dispatch({ twinId, criterion, initialState, finalState, events }) {
      const plugin = plugins.get(twinId);
      if (!plugin || !plugin.canEvaluate(criterion, finalState)) {
        return skippedResult(criterion, twinId);
      }
      return plugin.evaluate(criterion, initialState, finalState, events);
    },
  };
}

function skippedResult(criterion: Criterion, twinId: string): CriterionResult {
  return {
    criterion,
    passed: false,
    // FDRS-611: no matching deterministic predicate is a harness gap, not an
    // infra failure — `skipped`, never `errored`.
    outcome: "skipped",
    skipped: true,
    reason: `no twin-plugin predicate matched '${criterion.text}' for twin ${twinId}`,
  };
}
