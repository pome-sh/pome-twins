import { describe, expect, it } from "vitest";
import type { Criterion } from "../../../src/scenario/scenarioSchema.js";
import type { RecorderEvent } from "../../../src/types/shared.js";
import {
  createTwinPluginRegistry,
  type DeterministicEvaluator,
} from "../../../src/evaluator/twin-plugins/index.js";

const sampleCriterion: Criterion = { type: "D", text: "state.refunds.length === 1" };
const noEvents: RecorderEvent[] = [];

describe("evaluator/twin-plugins — dispatcher", () => {
  it("returns skipped (not thrown) when no plugin is registered for the twin", () => {
    const registry = createTwinPluginRegistry();

    const result = registry.dispatch({
      twinId: "postgres",
      criterion: sampleCriterion,
      initialState: undefined,
      finalState: undefined,
      events: noEvents,
    });

    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.reason).toBe(
      "no twin-plugin predicate matched 'state.refunds.length === 1' for twin postgres",
    );
  });

  it("returns skipped when the registered plugin's canEvaluate returns false", () => {
    const registry = createTwinPluginRegistry();
    const fakePlugin: DeterministicEvaluator = {
      twin: "github",
      canEvaluate: () => false,
      evaluate: () => {
        throw new Error("evaluate should not be called when canEvaluate is false");
      },
    };
    registry.register(fakePlugin);

    const result = registry.dispatch({
      twinId: "github",
      criterion: sampleCriterion,
      initialState: {},
      finalState: {},
      events: noEvents,
    });

    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("no twin-plugin predicate matched");
    expect(result.reason).toContain("github");
  });

  it("delegates to the plugin's evaluate when canEvaluate returns true", () => {
    const registry = createTwinPluginRegistry();
    const fakePlugin: DeterministicEvaluator = {
      twin: "stripe",
      canEvaluate: () => true,
      evaluate: (criterion) => ({
        criterion,
        passed: true,
        skipped: false,
        reason: "delegated",
      }),
    };
    registry.register(fakePlugin);

    const result = registry.dispatch({
      twinId: "stripe",
      criterion: sampleCriterion,
      initialState: {},
      finalState: {},
      events: noEvents,
    });

    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.reason).toBe("delegated");
  });

  it("does not throw when finalState is an unexpected shape and no plugin matches", () => {
    const registry = createTwinPluginRegistry();

    expect(() =>
      registry.dispatch({
        twinId: "unknown",
        criterion: sampleCriterion,
        initialState: undefined,
        finalState: { something: "weird" },
        events: noEvents,
      }),
    ).not.toThrow();
  });
});
