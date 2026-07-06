// SPDX-License-Identifier: Apache-2.0
// FDRS-636 — pure terminal rendering for `pome run -n k` trial groups,
// matching the design-of-record (CLI moments.dc.html moment 04):
//
//   -n sets how many isolated trials to run · the agent command comes from pome.config.json
//   provisioning 5 isolated github twins … ready
//   spawning agent <cmd> · from pome.config.json …
//   trial 1  ✓  100      14.3s
//   trial 3  ✗  58       15.9s  <failing criteria summary>
//   trial 5  ⚠  errored         <reason> — excluded
//   ─────
//   2 of 4 passed · 1 errored, excluded from the fraction
//   <failing-criterion phrase> failed in 2 of 4 — start there
//   full trace, per-criterion diffs, and the trial spread:
//   → <reliability page url>
//
// Trial verdicts are NUMERIC SCORES (not words — that vocabulary belongs to
// `pome demo`); errored rows show no duration and are excluded from the
// fraction's denominator.

import { describe, expect, it } from "vitest";
import {
  flagHintLine,
  groupExitCode,
  groupSummaryLines,
  mostCommonFailedCriterion,
  provisioningLine,
  shortReason,
  spawningAgentLine,
  trialRowLine,
  type TrialRow,
} from "../../../src/runner/groupRender.js";

const completed = (
  score: number,
  passed: boolean,
  seconds: number,
  note?: string,
): TrialRow => ({ kind: "completed", score, passed, seconds, note });
const errored = (reason: string): TrialRow => ({ kind: "errored", reason });

describe("group header lines (moment 04)", () => {
  it("renders the -n hint naming where the agent command came from", () => {
    expect(flagHintLine("pome.config.json")).toBe(
      "-n sets how many isolated trials to run · the agent command comes from pome.config.json",
    );
    expect(flagHintLine("--agent")).toBe(
      "-n sets how many isolated trials to run · the agent command comes from --agent",
    );
  });

  it("renders the provisioning line for k twins", () => {
    expect(provisioningLine(5, ["github"])).toBe(
      "provisioning 5 isolated github twins … ready",
    );
  });

  // FDRS-663 — the quota bound is named honestly, never silently absorbed.
  it("names the plan-concurrency bound when the quota bounded the upfront mint", () => {
    expect(provisioningLine(5, ["github"], 3)).toBe(
      "provisioning 3 isolated github twins … ready (plan concurrency 3 — 5 trials reuse slots as they finish)",
    );
    // Bound == k means quota never pushed back: the classic line.
    expect(provisioningLine(5, ["github"], 5)).toBe(
      "provisioning 5 isolated github twins … ready",
    );
  });

  it("renders the spawning-agent line with the command and its source", () => {
    expect(
      spawningAgentLine("npx tsx examples/agents/triage-agent.ts", "pome.config.json"),
    ).toBe(
      "spawning agent npx tsx examples/agents/triage-agent.ts · from pome.config.json …",
    );
  });
});

describe("trialRowLine (numeric scores, moment 04 column shape)", () => {
  it("renders a passing trial with score and duration", () => {
    expect(trialRowLine(1, completed(100, true, 14.3))).toBe(
      "trial 1  ✓  100      14.3s",
    );
    expect(trialRowLine(2, completed(96, true, 12.1))).toBe(
      "trial 2  ✓  96       12.1s",
    );
  });

  it("renders a failing trial with the failing criteria summary", () => {
    expect(
      trialRowLine(3, completed(58, false, 15.9, "assignee never set · severity under-rated")),
    ).toBe("trial 3  ✗  58       15.9s  assignee never set · severity under-rated");
  });

  it("renders a failing trial without a note when the cloud sent no criteria results", () => {
    expect(trialRowLine(4, completed(74, false, 13.5))).toBe(
      "trial 4  ✗  74       13.5s",
    );
  });

  it("renders an errored trial with no duration, reason, and the excluded marker", () => {
    expect(trialRowLine(5, errored("twin provision timeout"))).toBe(
      "trial 5  ⚠  errored         twin provision timeout — excluded",
    );
  });
});

describe("groupSummaryLines (errored trials excluded from the fraction)", () => {
  const url = "https://app.pome.sh/runs/task/01-bug-happy-path";

  it("renders the moment-04 summary: fraction over completed trials only", () => {
    const rows = [
      completed(100, true, 14.3),
      completed(96, true, 12.1),
      completed(58, false, 15.9, "n"),
      completed(74, false, 13.5, "n"),
      errored("twin provision timeout"),
    ];
    expect(
      groupSummaryLines({
        rows,
        failingCriterionPhrase: "severity check",
        failingCriterionCount: 2,
        reliabilityUrl: url,
      }),
    ).toEqual([
      "─────",
      "2 of 4 passed · 1 errored, excluded from the fraction",
      "severity check failed in 2 of 4 — start there",
      "",
      "full trace, per-criterion diffs, and the trial spread:",
      `→ ${url}`,
    ]);
  });

  it("omits the errored clause and start-there line when not applicable", () => {
    const rows = [completed(100, true, 3), completed(100, true, 4)];
    expect(groupSummaryLines({ rows, reliabilityUrl: url })).toEqual([
      "─────",
      "2 of 2 passed",
      "",
      "full trace, per-criterion diffs, and the trial spread:",
      `→ ${url}`,
    ]);
  });

  it("says so honestly when no trial completed, and prints no dashboard link", () => {
    const rows = [errored("agent timed out"), errored("agent timed out")];
    expect(groupSummaryLines({ rows, reliabilityUrl: url })).toEqual([
      "─────",
      "no trials completed · 2 errored, excluded from the fraction",
    ]);
  });
});

describe("groupExitCode ([DECISION]: 0 iff ≥1 completed AND all completed passed)", () => {
  it("0 when every completed trial passed (errored rows don't block)", () => {
    expect(groupExitCode([completed(100, true, 1), errored("x")])).toBe(0);
    expect(groupExitCode([completed(100, true, 1), completed(96, true, 2)])).toBe(0);
  });

  it("1 when any completed trial failed", () => {
    expect(groupExitCode([completed(100, true, 1), completed(58, false, 2)])).toBe(1);
  });

  it("2 when no trial completed at all", () => {
    expect(groupExitCode([errored("a"), errored("b")])).toBe(2);
    expect(groupExitCode([])).toBe(2);
  });
});

describe("failure aggregation helpers", () => {
  it("mostCommonFailedCriterion picks the modal criterion text", () => {
    const got = mostCommonFailedCriterion([
      "Severity is set correctly",
      "Assignee is set",
      "Severity is set correctly",
    ]);
    expect(got?.count).toBe(2);
    expect(got?.phrase).toContain("severity is set correctly");
  });

  it("mostCommonFailedCriterion returns null with no failures", () => {
    expect(mostCommonFailedCriterion([])).toBeNull();
  });

  it("shortReason flattens whitespace and truncates long reasons", () => {
    expect(shortReason("boom\n  twice")).toBe("boom twice");
    expect(shortReason("x".repeat(100))).toBe(`${"x".repeat(69)}…`);
  });
});
