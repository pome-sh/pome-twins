// SPDX-License-Identifier: Apache-2.0
// FDRS-643 — verdict rendering per the design of record (CLI moments
// moment 01): words not scores, errored rows show no duration, the summary
// fraction excludes errored trials from its denominator.
import { describe, expect, it } from "vitest";
import {
  criterionPhrase,
  reassuranceBox,
  summaryLines,
  trialLine,
  trialsHeaderLine,
  twinReadyLine,
} from "../../../src/demo/render.js";
import { capacityLabel } from "../../../src/demo/capacity.js";

describe("reassurance box", () => {
  it("keeps the copy of record verbatim and names all three surfaces honestly", () => {
    const box = reassuranceBox().join("\n");
    expect(box).toContain("pome demo · running locally");
    // [DECISION] #5 — verbatim.
    expect(box).toContain("No signup. No API keys.");
    expect(box).toContain("Your repo and your data are never touched.");
    // The honest line: local twin, anonymous gateway, cloud evaluation.
    expect(box).toMatch(/twin runs on your machine/i);
    expect(box).toMatch(/anonymous demo gateway/i);
    expect(box).toMatch(/evaluated in pome cloud/i);
    // The reconciled copy must NOT resurrect the pre-decision claims.
    expect(box).not.toMatch(/runs entirely on your machine/i);
    expect(box).not.toMatch(/zero real API calls/i);
  });

  it("draws a closed border", () => {
    const lines = reassuranceBox();
    expect(lines[0]).toMatch(/^┌─+┐$/);
    expect(lines[lines.length - 1]).toMatch(/^└─+┘$/);
    for (const middle of lines.slice(1, -1)) {
      expect(middle.startsWith("│")).toBe(true);
      expect(middle.endsWith("│")).toBe(true);
    }
  });
});

describe("progress lines", () => {
  it("renders the twin + trials header lines per design", () => {
    expect(twinReadyLine(1.234)).toBe("spinning up github twin … ready (1.2s)");
    expect(trialsHeaderLine(5, "first-run-demo")).toBe(
      "running 5 isolated trials of first-run-demo …",
    );
  });
});

describe("trial verdict lines", () => {
  it("passed / failed use words + duration", () => {
    expect(trialLine(1, { kind: "passed", seconds: 14.31 })).toBe(
      "trial 1  ✓  passed   14.3s",
    );
    expect(
      trialLine(3, {
        kind: "failed",
        seconds: 15.94,
        note: "the comment never names the failing endpoint",
      }),
    ).toBe("trial 3  ✗  failed   15.9s  the comment never names the failing endpoint");
  });

  it("errored shows no duration and is marked excluded", () => {
    const line = trialLine(5, { kind: "errored", reason: "trial timed out" });
    expect(line).toBe("trial 5  ⚠  errored         trial timed out — excluded");
    expect(line).not.toMatch(/\d+\.\d+s/);
  });

  it("never renders a numeric score", () => {
    for (const line of [
      trialLine(1, { kind: "passed", seconds: 2 }),
      trialLine(2, { kind: "failed", seconds: 2, note: "x" }),
    ]) {
      expect(line).not.toMatch(/\/100|\d+%/);
    }
  });
});

describe("summary", () => {
  it("excludes errored trials from the fraction and names the errored reason", () => {
    const lines = summaryLines({
      verdicts: [
        { kind: "passed", seconds: 14.3 },
        { kind: "passed", seconds: 12.1 },
        { kind: "failed", seconds: 15.9, note: "n" },
        { kind: "failed", seconds: 13.5, note: "n" },
        { kind: "errored", reason: "gateway timeout" },
      ],
      failingCriterionPhrase: "the comment never names the failing endpoint",
      failingCriterionCount: 2,
      previewUrl: "https://app.pome.sh/demo/grp_abc123",
    });
    expect(lines[0]).toBe("─────");
    expect(lines[1]).toBe(
      "2 of 4 passed · 1 trial errored on gateway timeout, excluded from the fraction",
    );
    expect(lines[2]).toBe(
      "the comment never names the failing endpoint in 2 of 4 — start there",
    );
    expect(lines[3]).toBe("see the full breakdown — read-only, still no account:");
    expect(lines[4]).toBe("→ https://app.pome.sh/demo/grp_abc123");
  });

  it("renders a clean fraction when nothing errored", () => {
    const lines = summaryLines({
      verdicts: [
        { kind: "passed", seconds: 1 },
        { kind: "passed", seconds: 1 },
        { kind: "passed", seconds: 1 },
        { kind: "failed", seconds: 1, note: "n" },
        { kind: "passed", seconds: 1 },
      ],
      previewUrl: "https://app.pome.sh/demo/grp_x",
    });
    expect(lines[1]).toBe("4 of 5 passed");
    expect(lines.join("\n")).toContain("→ https://app.pome.sh/demo/grp_x");
  });

  it("omits the start-there line when nothing failed", () => {
    const lines = summaryLines({
      verdicts: [
        { kind: "passed", seconds: 1 },
        { kind: "passed", seconds: 1 },
      ],
      previewUrl: "https://app.pome.sh/demo/grp_x",
    });
    expect(lines.join("\n")).not.toContain("start there");
  });

  it("states honestly when no trial produced a verdict (no preview link)", () => {
    const lines = summaryLines({
      verdicts: [
        { kind: "errored", reason: "trial timed out" },
        { kind: "errored", reason: "trial timed out" },
      ],
      previewUrl: "https://app.pome.sh/demo/grp_x",
    });
    expect(lines[1]).toBe(
      "no trials were evaluated · 2 trials errored on trial timed out, excluded from the fraction",
    );
    expect(lines.join("\n")).not.toContain("app.pome.sh/demo");
  });
});

describe("criterionPhrase", () => {
  it("takes the first clause, lower-cases the lead, caps length", () => {
    const phrase = criterionPhrase(
      "Exactly one comment was left on that issue, and it names the failing endpoint (POST /orders). Something else.",
    );
    expect(phrase.startsWith("exactly one comment was left on that issue")).toBe(true);
    expect(phrase).not.toContain("Something else");
    expect(phrase.length).toBeLessThanOrEqual(64);
    expect(phrase.endsWith("…")).toBe(true);
  });

  it("passes short criteria through intact (minus casing)", () => {
    expect(criterionPhrase("No new label was created.")).toBe(
      "no new label was created",
    );
  });
});

describe("at-capacity labels (FDRS-662)", () => {
  it("labels every kind honestly, never a stack trace", () => {
    expect(capacityLabel("daily_model_cap")).toMatch(/daily model budget .* try again tomorrow/);
    expect(capacityLabel("daily_judge_cap")).toMatch(/evaluation budget .* try again tomorrow/);
    expect(capacityLabel("demo_ip_llm_cap")).toMatch(/limit for this network/);
    expect(capacityLabel("demo_ip_mint_cap")).toMatch(/limit for this network/);
    expect(capacityLabel("session_llm_call_cap")).toMatch(/model-call ceiling/);
    expect(capacityLabel("unknown_capacity")).toBe(
      "the demo is at capacity today — try again tomorrow",
    );
    expect(capacityLabel("gateway_unavailable")).toMatch(/unavailable right now/);
  });
});
