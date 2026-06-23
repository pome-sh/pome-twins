// SPDX-License-Identifier: Apache-2.0
//
// The barrel re-export identity is load-bearing: consumers import from
// `@pome-sh/shared-types`, not from the leaf files. If a re-export drifts
// (e.g. someone copies a schema into index.ts instead of re-exporting),
// these tests fail. Zod schemas must be referentially identical across the
// barrel and the leaf — otherwise discriminated unions and `instanceof`
// checks downstream silently break.

import { describe, expect, it } from "vitest";
import * as barrel from "../src/index.js";
import * as recorderEvents from "../src/recorder-events.js";
import * as run from "../src/run.js";

describe("index.ts barrel re-exports from recorder-events.ts", () => {
  it("re-exports recorderEventSchema (same identity)", () => {
    expect(barrel.recorderEventSchema).toBe(recorderEvents.recorderEventSchema);
  });
  it("re-exports recorderFidelitySchema", () => {
    expect(barrel.recorderFidelitySchema).toBe(
      recorderEvents.recorderFidelitySchema
    );
  });
  it("re-exports twinIdSchema", () => {
    expect(barrel.twinIdSchema).toBe(recorderEvents.twinIdSchema);
  });
  it("re-exports stateDeltaSchema", () => {
    expect(barrel.stateDeltaSchema).toBe(recorderEvents.stateDeltaSchema);
  });
});

describe("index.ts barrel re-exports from run.ts", () => {
  it("re-exports runSchema (same identity)", () => {
    expect(barrel.runSchema).toBe(run.runSchema);
  });
  it("re-exports laneSchema", () => {
    expect(barrel.laneSchema).toBe(run.laneSchema);
  });
  it("re-exports stepSchema", () => {
    expect(barrel.stepSchema).toBe(run.stepSchema);
  });
  it("re-exports criterionResultSchema", () => {
    expect(barrel.criterionResultSchema).toBe(run.criterionResultSchema);
  });
  it("re-exports deterministicCriterionResultSchema", () => {
    expect(barrel.deterministicCriterionResultSchema).toBe(
      run.deterministicCriterionResultSchema
    );
  });
  it("re-exports probabilisticCriterionResultSchema", () => {
    expect(barrel.probabilisticCriterionResultSchema).toBe(
      run.probabilisticCriterionResultSchema
    );
  });
  it("re-exports criterionSchema (moved into run.ts)", () => {
    expect(barrel.criterionSchema).toBe(run.criterionSchema);
  });
  it("re-exports judgeModelSchema (moved into run.ts)", () => {
    expect(barrel.judgeModelSchema).toBe(run.judgeModelSchema);
  });
});
