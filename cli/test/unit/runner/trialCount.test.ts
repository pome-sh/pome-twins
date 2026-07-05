// SPDX-License-Identifier: Apache-2.0
// FDRS-636 — `pome run -n k` trial-count resolution.
//
// [DECISION 2026-07-05]: -n is an integer 1..20 on the hosted run path;
// the default comes from the scenario config's `runs` field (which
// scenarioConfigSchema already parses, defaulting 1, but nothing consumed
// until now); both are capped at 20.

import { describe, expect, it } from "vitest";
import { HostedUsageError } from "../../../src/hosted/errors.js";
import {
  MAX_TRIALS,
  effectiveTrialCount,
  parseTrialsFlag,
} from "../../../src/runner/trialCount.js";

describe("parseTrialsFlag (FDRS-636)", () => {
  it("accepts integers 1..20", () => {
    expect(parseTrialsFlag("1")).toBe(1);
    expect(parseTrialsFlag("5")).toBe(5);
    expect(parseTrialsFlag("20")).toBe(20);
  });

  it("rejects 0, negatives, and >20 as usage errors (documented exit 5)", () => {
    expect(() => parseTrialsFlag("0")).toThrow(HostedUsageError);
    expect(() => parseTrialsFlag("-3")).toThrow(HostedUsageError);
    expect(() => parseTrialsFlag("21")).toThrow(HostedUsageError);
  });

  it("rejects non-integers and trailing garbage", () => {
    expect(() => parseTrialsFlag("abc")).toThrow(HostedUsageError);
    expect(() => parseTrialsFlag("2.5")).toThrow(HostedUsageError);
    expect(() => parseTrialsFlag("5x")).toThrow(HostedUsageError);
    expect(() => parseTrialsFlag("")).toThrow(HostedUsageError);
  });

  it("names the expected range in the error message", () => {
    expect(() => parseTrialsFlag("999")).toThrow(/1-20/);
  });
});

describe("effectiveTrialCount (FDRS-636)", () => {
  it("-n overrides the scenario config's runs field", () => {
    expect(effectiveTrialCount(5, 2)).toBe(5);
    expect(effectiveTrialCount(1, 7)).toBe(1);
  });

  it("defaults to config runs when no flag is given", () => {
    expect(effectiveTrialCount(undefined, 1)).toBe(1);
    expect(effectiveTrialCount(undefined, 3)).toBe(3);
  });

  it("caps the config default at 20", () => {
    expect(effectiveTrialCount(undefined, 50)).toBe(MAX_TRIALS);
    expect(effectiveTrialCount(undefined, 20)).toBe(20);
  });

  it("MAX_TRIALS is the locked cap of 20", () => {
    expect(MAX_TRIALS).toBe(20);
  });
});
