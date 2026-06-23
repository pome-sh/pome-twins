// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the OUTCOME-LEVEL aggregation math. Synthetic CellResults are
// injected directly (no spawn, no clock, no filesystem) so the discrimination /
// flakiness / reliability / leaderboard math is exercised in isolation.
import { describe, expect, it } from "vitest";
import {
  aggregateMatrix,
  cellPassed,
  leaderboard,
  measurementReliability,
  scenarioDiscrimination,
  stdevSample,
  summarizeCell,
  variance,
} from "../../src/matrix/aggregate.js";
import {
  anomalyHits,
  digestAnomalies,
  isAnomalousTwinEvent,
  normalizeTwinPath,
  type AnomalyHit,
} from "../../src/matrix/anomalies.js";
import type { TwinHttpEvent } from "../../src/types/shared.js";
import { runResourceMetrics, type PricingTable } from "../../src/matrix/cost.js";
import type { CellResult } from "../../src/matrix/types.js";
import type { Event } from "../../src/types/shared.js";

// Build a CellResult from a pass/fail run vector. `confidences` is one number
// per run (the run's mean [P] confidence) or null when the run had no judge.
function cell(input: {
  agentId: string;
  scenario: string;
  passes: boolean[];
  satisfactions?: number[]; // per-run satisfaction; defaults to passed?100:0
  confidences?: Array<number | null>;
  costs?: Array<number | null>;
  judgeModel?: string | null;
}): CellResult {
  const { passes } = input;
  const summary = summarizeCell({
    cellId: `${input.agentId}::${input.scenario}`,
    agentId: input.agentId,
    scenario: input.scenario,
    scenarioPath: `scenarios/${input.scenario}.md`,
    runs: passes.map((passed, i) => ({
      passed,
      satisfaction: input.satisfactions?.[i] ?? (passed ? 100 : 0),
      cost_usd: input.costs?.[i] ?? null,
      latency_ms: null,
      judge_confidence: input.confidences?.[i] ?? null,
      judge_model: input.judgeModel ?? null,
    })),
  });
  return summary;
}

describe("variance / stdev primitives", () => {
  it("population variance of a constant series is 0", () => {
    expect(variance([0.5, 0.5, 0.5])).toBe(0);
  });

  it("population variance matches the hand-computed value", () => {
    // values 0, 1 → mean 0.5, sq dev 0.25 each → variance 0.25
    expect(variance([0, 1])).toBeCloseTo(0.25, 10);
  });

  it("empty variance is 0", () => {
    expect(variance([])).toBe(0);
  });

  it("sample stdev needs >= 2 values", () => {
    expect(stdevSample([0.9])).toBeNull();
    expect(stdevSample([])).toBeNull();
  });

  it("sample stdev matches the n-1 formula", () => {
    // values 0.2, 0.4 → mean 0.3, sq dev 0.01 each, /(n-1)=/1 → 0.02 → sqrt
    expect(stdevSample([0.2, 0.4])).toBeCloseTo(Math.sqrt(0.02), 10);
  });
});

describe("per-cell flakiness (summarizeCell)", () => {
  it("all-pass cell is not flaky and has pass_rate 1", () => {
    const c = cell({ agentId: "a", scenario: "s1", passes: [true, true, true] });
    expect(c.pass_rate).toBe(1);
    expect(c.flaky).toBe(false);
  });

  it("all-fail cell is not flaky and has pass_rate 0", () => {
    const c = cell({ agentId: "a", scenario: "s1", passes: [false, false] });
    expect(c.pass_rate).toBe(0);
    expect(c.flaky).toBe(false);
  });

  it("mixed cell is flaky with the right pass_rate", () => {
    const c = cell({ agentId: "a", scenario: "s1", passes: [true, false, true, false] });
    expect(c.pass_rate).toBe(0.5);
    expect(c.flaky).toBe(true);
  });

  it("mean cost ignores nulls and is null when all runs are null", () => {
    const allNull = cell({ agentId: "a", scenario: "s1", passes: [true, true] });
    expect(allNull.mean_cost_usd).toBeNull();
    const some = cell({
      agentId: "a",
      scenario: "s1",
      passes: [true, true],
      costs: [0.1, null],
    });
    // only the present value counts → mean = 0.1
    expect(some.mean_cost_usd).toBeCloseTo(0.1, 10);
  });
});

describe("scenario discrimination", () => {
  it("flags all-pass and all-fail scenarios as low-signal", () => {
    const cells = [
      cell({ agentId: "a", scenario: "easy", passes: [true, true] }),
      cell({ agentId: "b", scenario: "easy", passes: [true, true] }),
      cell({ agentId: "a", scenario: "impossible", passes: [false, false] }),
      cell({ agentId: "b", scenario: "impossible", passes: [false, false] }),
    ];
    const disc = scenarioDiscrimination(cells);
    const easy = disc.find((d) => d.scenario === "easy")!;
    const impossible = disc.find((d) => d.scenario === "impossible")!;
    expect(easy.low_signal).toBe(true);
    expect(easy.pass_variance).toBe(0);
    expect(easy.fleet_pass_rate).toBe(1);
    expect(impossible.low_signal).toBe(true);
    expect(impossible.fleet_pass_rate).toBe(0);
  });

  it("a scenario that splits the fleet is discriminating with positive variance", () => {
    const cells = [
      cell({ agentId: "strong", scenario: "hard", passes: [true, true] }), // pass_rate 1
      cell({ agentId: "weak", scenario: "hard", passes: [false, false] }), // pass_rate 0
    ];
    const disc = scenarioDiscrimination(cells);
    const hard = disc.find((d) => d.scenario === "hard")!;
    expect(hard.low_signal).toBe(false);
    // per-agent pass rates [1, 0] → variance 0.25, fleet mean 0.5
    expect(hard.pass_variance).toBeCloseTo(0.25, 10);
    expect(hard.fleet_pass_rate).toBeCloseTo(0.5, 10);
    expect(hard.agents_evaluated).toBe(2);
  });

  it("a uniformly-flaky scenario (every agent 0.5) is NOT low-signal", () => {
    const cells = [
      cell({ agentId: "a", scenario: "flaky", passes: [true, false] }),
      cell({ agentId: "b", scenario: "flaky", passes: [false, true] }),
    ];
    const disc = scenarioDiscrimination(cells)[0]!;
    expect(disc.low_signal).toBe(false);
    expect(disc.fleet_pass_rate).toBeCloseTo(0.5, 10);
    // both agents at 0.5 → zero variance, but still signal (run-to-run spread)
    expect(disc.pass_variance).toBe(0);
  });

  it("orders most-discriminating scenarios first", () => {
    const cells = [
      // 'splitter' variance 0.25, 'uniform' variance 0
      cell({ agentId: "a", scenario: "splitter", passes: [true] }),
      cell({ agentId: "b", scenario: "splitter", passes: [false] }),
      cell({ agentId: "a", scenario: "uniform", passes: [true] }),
      cell({ agentId: "b", scenario: "uniform", passes: [true] }),
    ];
    const disc = scenarioDiscrimination(cells);
    expect(disc[0]!.scenario).toBe("splitter");
  });
});

describe("measurement reliability", () => {
  it("counts flaky cells and computes the flaky rate", () => {
    const cells = [
      cell({ agentId: "a", scenario: "s1", passes: [true, false] }), // flaky
      cell({ agentId: "a", scenario: "s2", passes: [true, true] }), // not
      cell({ agentId: "b", scenario: "s1", passes: [false, true] }), // flaky
      cell({ agentId: "b", scenario: "s2", passes: [false, false] }), // not
    ];
    const rel = measurementReliability(cells);
    expect(rel.total_cells).toBe(4);
    expect(rel.flaky_cells).toBe(2);
    expect(rel.flaky_rate).toBeCloseTo(0.5, 10);
  });

  it("judge confidence stdev measures cross-cell judge agreement", () => {
    const cells = [
      cell({
        agentId: "a",
        scenario: "p1",
        passes: [true],
        confidences: [0.8],
        judgeModel: "judge-x",
      }),
      cell({
        agentId: "b",
        scenario: "p1",
        passes: [true],
        confidences: [0.6],
        judgeModel: "judge-x",
      }),
    ];
    const rel = measurementReliability(cells);
    expect(rel.mean_judge_confidence).toBeCloseTo(0.7, 10);
    // sample stdev of [0.8, 0.6] = sqrt(((0.1)^2 + (0.1)^2)/1) = sqrt(0.02)
    expect(rel.judge_confidence_stdev).toBeCloseTo(Math.sqrt(0.02), 10);
  });

  it("null judge confidence when no cell carries a [P] verdict", () => {
    const cells = [cell({ agentId: "a", scenario: "d1", passes: [true] })];
    const rel = measurementReliability(cells);
    expect(rel.mean_judge_confidence).toBeNull();
    expect(rel.judge_confidence_stdev).toBeNull();
  });

  it("empty matrix has a 0 flaky rate and null judge stats", () => {
    const rel = measurementReliability([]);
    expect(rel.total_cells).toBe(0);
    expect(rel.flaky_rate).toBe(0);
    expect(rel.mean_judge_confidence).toBeNull();
  });
});

describe("agent leaderboard", () => {
  it("ranks agents by mean pass-rate and rolls up flaky cells + cost", () => {
    const cells = [
      cell({ agentId: "strong", scenario: "s1", passes: [true], costs: [0.2] }),
      cell({ agentId: "strong", scenario: "s2", passes: [true], costs: [0.3] }),
      cell({ agentId: "weak", scenario: "s1", passes: [true, false], costs: [0.1, null] }), // flaky
      cell({ agentId: "weak", scenario: "s2", passes: [false], costs: [null] }),
    ];
    const board = leaderboard(cells);
    expect(board[0]!.agent_id).toBe("strong");
    expect(board[0]!.mean_pass_rate).toBe(1);
    expect(board[0]!.flaky_cells).toBe(0);
    expect(board[0]!.total_cost_usd).toBeCloseTo(0.5, 10);
    expect(board[1]!.agent_id).toBe("weak");
    // weak: pass rates [0.5, 0] → mean 0.25
    expect(board[1]!.mean_pass_rate).toBeCloseTo(0.25, 10);
    expect(board[1]!.flaky_cells).toBe(1);
  });

  it("total cost is null when no cell in the agent had a cost", () => {
    const cells = [cell({ agentId: "scripted", scenario: "s1", passes: [true] })];
    const board = leaderboard(cells);
    expect(board[0]!.total_cost_usd).toBeNull();
  });

  it("leads ranking with the satisfaction gradient, breaking binary pass-rate ties", () => {
    // Both agents fail the binary gate everywhere (pass_rate 0), so the old
    // pass-rate-only ranking would tie them and fall back to agent id. The
    // gradient must separate "got 3/4 criteria" (sat 75) from "whiffed" (sat 0).
    const cells = [
      cell({ agentId: "zeta-close", scenario: "s1", passes: [false], satisfactions: [75] }),
      cell({ agentId: "alpha-whiff", scenario: "s1", passes: [false], satisfactions: [0] }),
    ];
    const board = leaderboard(cells);
    expect(board[0]!.agent_id).toBe("zeta-close");
    expect(board[0]!.mean_satisfaction).toBeCloseTo(75, 10);
    expect(board[0]!.mean_pass_rate).toBe(0);
    expect(board[1]!.agent_id).toBe("alpha-whiff");
    expect(board[1]!.mean_satisfaction).toBe(0);
  });
});

describe("cellPassed (gradient gate)", () => {
  it("passes when satisfaction clears the threshold and the agent did not error", () => {
    expect(cellPassed(100, false, 100)).toBe(true);
    expect(cellPassed(75, false, 75)).toBe(true);
    expect(cellPassed(80, false, 75)).toBe(true);
  });

  it("fails when satisfaction is below the threshold", () => {
    expect(cellPassed(75, false, 100)).toBe(false);
    expect(cellPassed(0, false, 1)).toBe(false);
  });

  it("an agent error fails regardless of satisfaction or threshold", () => {
    expect(cellPassed(100, true, 0)).toBe(false);
    expect(cellPassed(100, true, 100)).toBe(false);
  });

  it("a 0 threshold passes any non-errored run (the loosest gate)", () => {
    expect(cellPassed(0, false, 0)).toBe(true);
  });
});

describe("aggregateMatrix end-to-end", () => {
  it("assembles all four aggregate sections", () => {
    const cells = [
      cell({ agentId: "a", scenario: "s1", passes: [true, false] }),
      cell({ agentId: "b", scenario: "s1", passes: [false, false] }),
    ];
    const anomalies: AnomalyHit[] = [
      {
        twin: "github",
        method: "GET",
        path: "/repos/:owner/:repo/issues/:n",
        status: 500,
        fidelity: "semantic",
        cell_id: "a::s1",
      },
    ];
    const agg = aggregateMatrix(cells, anomalies);
    expect(agg.scenario_discrimination).toHaveLength(1);
    expect(agg.measurement_reliability.total_cells).toBe(2);
    expect(agg.twin_anomaly_digest).toHaveLength(1);
    expect(agg.leaderboard).toHaveLength(2);
  });
});

describe("twin-anomaly digest", () => {
  it("normalizes session prefix + numeric + repo + opaque ids", () => {
    expect(
      normalizeTwinPath(
        "/s/run_abc-123/repos/acme/api/issues/42/labels",
      ),
    ).toBe("/repos/:owner/:repo/issues/:n/labels");
    expect(normalizeTwinPath("/s/run_x/v1/payment_intents/pi_3ABC456")).toBe(
      "/v1/payment_intents/:id",
    );
    expect(normalizeTwinPath("/s/run_x/")).toBe("/");
  });

  it("folds identical anomalies into one row with an occurrence count", () => {
    const hits: AnomalyHit[] = [
      {
        twin: "github",
        method: "GET",
        path: "/repos/:owner/:repo",
        status: 500,
        fidelity: "semantic",
        cell_id: "a::s1",
      },
      {
        twin: "github",
        method: "GET",
        path: "/repos/:owner/:repo",
        status: 500,
        fidelity: "semantic",
        cell_id: "b::s1",
      },
      {
        twin: "github",
        method: "POST",
        path: "/repos/:owner/:repo/labels",
        status: 422,
        fidelity: "unsupported",
        cell_id: "a::s2",
      },
    ];
    const digest = digestAnomalies(hits);
    expect(digest).toHaveLength(2);
    // most-frequent first
    expect(digest[0]!.occurrences).toBe(2);
    expect(digest[0]!.method).toBe("GET");
    expect(digest[0]!.sample_cell_id).toBe("a::s1");
    expect(digest[1]!.occurrences).toBe(1);
    expect(digest[1]!.fidelity).toBe("unsupported");
  });

  it("empty hit list yields an empty digest", () => {
    expect(digestAnomalies([])).toEqual([]);
  });
});

describe("twin-anomaly classification (isAnomalousTwinEvent)", () => {
  // The twin sets `error` on EVERY status >= 400 (twin/github/app.ts respond()),
  // so these fixtures mirror that: any 4xx carries a non-null error message.
  function twinHttp(over: Partial<TwinHttpEvent>): TwinHttpEvent {
    const status = over.status ?? 200;
    return {
      kind: "TwinHttpEvent",
      ts: "2026-06-01T00:00:00.000Z",
      run_id: "run_test",
      twin: "github",
      request_id: "req_test",
      correlation_id: "req_test",
      scenario_step_id: null,
      step_id: null,
      tool_call_id: null,
      method: "POST",
      path: "/s/run_test/mcp",
      request_body: null,
      response_body: null,
      latency_ms: 1,
      fidelity: "semantic",
      state_mutation: false,
      state_delta: null,
      error: status >= 400 ? "request failed" : null,
      event_id: "req_test",
      parent_id: null,
      ...over,
    } as TwinHttpEvent;
  }

  it("flags 5xx, unsupported, and non-HTTP transport faults", () => {
    expect(isAnomalousTwinEvent(twinHttp({ status: 500 }))).toBe(true);
    expect(
      isAnomalousTwinEvent(twinHttp({ status: 200, fidelity: "unsupported" })),
    ).toBe(true);
    // status < 400 but the recorder flagged a failure → genuine anomaly.
    expect(isAnomalousTwinEvent(twinHttp({ status: 0, error: "ECONNRESET" }))).toBe(
      true,
    );
  });

  it("does NOT flag a faithful 4xx even though the twin sets `error`", () => {
    // This is the regression: a semantic 422 (e.g. add label that doesn't exist —
    // exactly what 02-missing-label tests) must not pollute the twin-anomaly digest.
    const validation422 = twinHttp({
      status: 422,
      error: "Validation Failed",
    });
    expect(validation422.error).not.toBeNull();
    expect(isAnomalousTwinEvent(validation422)).toBe(false);
    expect(isAnomalousTwinEvent(twinHttp({ status: 404 }))).toBe(false);
    // anomalyHits over the same event yields nothing.
    expect(anomalyHits([validation422], "a::s1")).toEqual([]);
  });

  it("does NOT flag an agent probing a non-existent endpoint (POST /mcp 404)", () => {
    // Regression for the false positive in the 2026-06-01T15-40 frontier sweep:
    // the mcp-loop agent POSTs to /mcp on the twin's HTTP server, gets a faithful
    // 404 (semantic, not an unsupported twin endpoint), and that flooded the
    // digest with `POST /mcp 404 ×37`. A client-side 4xx is never a twin anomaly.
    const mcpProbe = twinHttp({
      method: "POST",
      path: "/s/run_test/mcp",
      status: 404,
      fidelity: "semantic",
      error: "Not Found",
    });
    expect(isAnomalousTwinEvent(mcpProbe)).toBe(false);
    expect(anomalyHits([mcpProbe], "sonnet-4.6/loop/default::05-github-identity-spoof")).toEqual([]);
    expect(digestAnomalies(anomalyHits([mcpProbe, mcpProbe], "c"))).toEqual([]);
  });
});

describe("cost rollup (runResourceMetrics)", () => {
  const PRICING: PricingTable = {
    "openai/gpt-5": { input_per_mtok: 1.25, output_per_mtok: 10.0 },
  };

  function llmEvent(over: Partial<Record<string, unknown>>): Event {
    return {
      kind: "LlmCallEvent",
      ts: "2026-06-01T00:00:00.000Z",
      event_id: "e1",
      parent_id: null,
      host: "api.openai.com",
      port: 443,
      latency_ms: 100,
      bytes_in: 0,
      bytes_out: 0,
      url: null,
      method: "POST",
      status: 200,
      model: "openai/gpt-5",
      prompt_tokens: 1000,
      completion_tokens: 500,
      cost_usd: null,
      ...over,
    } as Event;
  }

  function twinEvent(): Event {
    return {
      kind: "TwinHttpEvent",
      ts: "2026-06-01T00:00:00.000Z",
      event_id: "t1",
      parent_id: null,
      run_id: "run_1",
      twin: "github",
      request_id: "req_1",
      step_id: null,
      tool_call_id: null,
      method: "GET",
      path: "/s/run_1/repos/acme/api",
      request_body: null,
      status: 200,
      response_body: null,
      latency_ms: 5,
      fidelity: "semantic",
      state_mutation: false,
      state_delta: null,
      error: null,
    } as Event;
  }

  it("no LLM events → null tokens/cost/latency but counts tool calls", () => {
    const m = runResourceMetrics([twinEvent(), twinEvent()], PRICING);
    expect(m.prompt_tokens).toBeNull();
    expect(m.completion_tokens).toBeNull();
    expect(m.cost_usd).toBeNull();
    expect(m.latency_ms).toBeNull();
    expect(m.tool_calls).toBe(2);
  });

  it("tier-1: sums LlmCallEvent.cost_usd when present", () => {
    const m = runResourceMetrics(
      [llmEvent({ cost_usd: 0.01 }), llmEvent({ cost_usd: 0.02 })],
      PRICING,
    );
    expect(m.cost_usd).toBeCloseTo(0.03, 10);
    expect(m.prompt_tokens).toBe(2000);
    expect(m.completion_tokens).toBe(1000);
    expect(m.latency_ms).toBe(200);
  });

  it("tier-2: prices summed tokens off the static table when cost_usd absent", () => {
    const m = runResourceMetrics([llmEvent({})], PRICING);
    // 1000 in * 1.25/Mtok + 500 out * 10/Mtok = 0.00125 + 0.005 = 0.00625
    expect(m.cost_usd).toBeCloseTo(0.00625, 10);
  });

  it("tier-2 with an unpriced model yields null cost (honest, not zero)", () => {
    const m = runResourceMetrics(
      [llmEvent({ model: "mystery/model-9" })],
      PRICING,
    );
    expect(m.cost_usd).toBeNull();
  });
});
