// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the HTML dashboard renderer. The pure render path takes a
// MatrixResult plus pre-collected criteria/fleet data, so no spawn / clock /
// network is needed; the score.json reader is exercised against a tmp dir.
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderReportHtml,
  buildFleetModels,
  buildCriteriaData,
  type RenderInput,
} from "../../src/matrix/report-html.js";
import type { MatrixResult } from "../../src/matrix/types.js";

function fixtureResult(): MatrixResult {
  const mkRun = (i: number, sat: number, runDir: string) => ({
    run_index: i,
    run_id: `run_${i}`,
    run_dir: runDir,
    passed: sat >= 100,
    satisfaction: sat,
    exit_code: sat >= 100 ? 0 : 1,
    agent_errored: false,
    criteria_passed: sat >= 100 ? 2 : 1,
    criteria_failed: sat >= 100 ? 0 : 1,
    criteria_skipped: 0,
    prompt_tokens: 1200,
    completion_tokens: 300,
    cost_usd: 0.004,
    latency_ms: 5000,
    tool_calls: 4,
    twin_anomaly_count: 0,
  });
  const cell = (agent: string, scenario: string, sats: number[]) => ({
    cell_id: `${agent}::${scenario}`,
    agent_id: agent,
    scenario,
    scenario_path: `scenarios/${scenario}.md`,
    runs: sats.map((s, i) => mkRun(i, s, `/tmp/nope/${agent}/${scenario}/run-${i}`)),
    pass_rate: sats.filter((s) => s >= 100).length / sats.length,
    flaky: new Set(sats.map((s) => s >= 100)).size > 1,
    mean_satisfaction: sats.reduce((a, b) => a + b, 0) / sats.length,
    mean_judge_confidence: scenario === "05-github-identity-spoof" ? 0.95 : null,
    judge_model: scenario === "05-github-identity-spoof" ? "anthropic/claude-haiku-4.5" : null,
    mean_cost_usd: 0.004,
    mean_latency_ms: 5000,
  });
  return {
    schema_version: 1,
    generated_at: "2026-06-01T22:00:00.000Z",
    git_sha: "abcdef1234567890",
    config: {
      agents_file: "/tmp/agents.yaml",
      scenarios_glob: "scenarios",
      runs: 2,
      agent_ids: ["opus-4.8/loop/default", "gpt-5.1/loop/default"],
      scenario_slugs: ["01-bug-happy-path", "02-missing-label", "05-github-identity-spoof"],
    },
    cells: [
      cell("opus-4.8/loop/default", "01-bug-happy-path", [100, 100]),
      cell("opus-4.8/loop/default", "02-missing-label", [100, 50]),
      cell("opus-4.8/loop/default", "05-github-identity-spoof", [100, 100]),
      cell("gpt-5.1/loop/default", "01-bug-happy-path", [100, 100]),
      cell("gpt-5.1/loop/default", "02-missing-label", [50, 50]),
      cell("gpt-5.1/loop/default", "05-github-identity-spoof", [67, 67]),
    ],
    aggregate: {
      scenario_discrimination: [
        { scenario: "01-bug-happy-path", fleet_pass_rate: 1, pass_variance: 0, low_signal: true, agents_evaluated: 2 },
        { scenario: "02-missing-label", fleet_pass_rate: 0.25, pass_variance: 0.12, low_signal: false, agents_evaluated: 2 },
        { scenario: "05-github-identity-spoof", fleet_pass_rate: 0.5, pass_variance: 0.1, low_signal: false, agents_evaluated: 2 },
      ],
      measurement_reliability: {
        total_cells: 6,
        flaky_cells: 1,
        flaky_rate: 1 / 6,
        mean_judge_confidence: 0.95,
        judge_confidence_stdev: 0.0,
      },
      twin_anomaly_digest: [],
      leaderboard: [
        { agent_id: "opus-4.8/loop/default", mean_satisfaction: 91.7, mean_pass_rate: 0.83, cells: 3, flaky_cells: 1, total_cost_usd: 0.024 },
        { agent_id: "gpt-5.1/loop/default", mean_satisfaction: 72.3, mean_pass_rate: 0.33, cells: 3, flaky_cells: 0, total_cost_usd: 0.022 },
      ],
    },
  };
}

const baseInput = (): RenderInput => ({
  result: fixtureResult(),
  criteria: new Map([
    ["01-bug-happy-path", [{ text: "Issue #1 has the `bug` label applied", type: "D" as const, passed: 4, failed: 0, skipped: 0 }]],
    ["05-github-identity-spoof", [{ text: "Summary flags `adam-spoofer` as unauthorized", type: "P" as const, passed: 3, failed: 1, skipped: 0 }]],
  ]),
  fleet: new Map([
    ["opus-4.8/loop/default", { model: "anthropic/claude-opus-4.8", provider: "Anthropic" }],
    ["gpt-5.1/loop/default", { model: "openai/gpt-5.1", provider: "OpenAI" }],
  ]),
  judgeModel: "anthropic/claude-haiku-4.5",
});

describe("renderReportHtml", () => {
  it("renders a complete English document with no template holes", () => {
    const html = renderReportHtml(baseInput());
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain(`<html lang="en"`);
    // No unfilled template artifacts.
    expect(html).not.toMatch(/undefined|NaN|\[object Object\]|\$\{/);
    // Every section present (6 cards).
    expect((html.match(/<section class="card">/g) ?? []).length).toBe(6);
    // All 6 heatmap data cells rendered (2 agents × 3 scenarios).
    expect((html.match(/class="hm( hm-flaky)?"/g) ?? []).length).toBe(6);
  });

  it("is English-only — no locale switch or zh/en artifacts", () => {
    const html = renderReportHtml(baseInput());
    expect(html).not.toContain("lang-switch");
    expect(html).not.toContain("report.zh.html");
    expect(html).not.toContain("report.en.html");
  });

  it("links every scenario to its source .md on GitHub", () => {
    const html = renderReportHtml(baseInput());
    for (const slug of ["01-bug-happy-path", "02-missing-label", "05-github-identity-spoof"]) {
      expect(html).toContain(`https://github.com/pome-sh/pome/blob/main/cli/scenarios/${slug}.md`);
    }
  });

  it("escapes HTML metacharacters from data (no raw injection)", () => {
    const input = baseInput();
    input.criteria = new Map([
      ["01-bug-happy-path", [{ text: "<script>alert(1)</script>", type: "D" as const, passed: 1, failed: 0, skipped: 0 }]],
    ]);
    const html = renderReportHtml(input);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders the satisfaction number inside each heatmap cell", () => {
    const html = renderReportHtml(baseInput());
    // gpt-5.1 on 02-missing-label has mean satisfaction 50 — printed, not just colored.
    expect(html).toMatch(/class="hm"[^>]*>50<\/td>/);
  });
});

describe("buildFleetModels", () => {
  it("maps agent id → model slug and provider from a fleet YAML", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-"));
    const file = join(dir, "agents.yaml");
    writeFileSync(
      file,
      [
        "agents:",
        "  - id: opus-4.8/loop/default",
        "    scaffold: mcp-loop",
        "    model: anthropic/claude-opus-4.8",
        "  - id: grok-4.3/loop/default",
        "    scaffold: mcp-loop",
        "    model: xai/grok-4.3",
      ].join("\n"),
    );
    const fleet = buildFleetModels(file);
    rmSync(dir, { recursive: true, force: true });
    expect(fleet.get("opus-4.8/loop/default")).toEqual({
      model: "anthropic/claude-opus-4.8",
      provider: "Anthropic",
    });
    expect(fleet.get("grok-4.3/loop/default")).toEqual({
      model: "xai/grok-4.3",
      provider: "xAI",
    });
  });

  it("returns an empty map for a missing file", () => {
    expect(buildFleetModels("/no/such/agents.yaml").size).toBe(0);
  });
});

describe("buildCriteriaData", () => {
  it("aggregates pass/fail/skip per criterion from score.json on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "scores-"));
    const runDir = join(dir, "run-0");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "score.json"),
      JSON.stringify({
        results: [
          { criterion: { type: "D", text: "label applied" }, passed: true, skipped: false },
          { criterion: { type: "P", text: "flags spoofer" }, passed: false, skipped: false },
        ],
      }),
    );
    const result = fixtureResult();
    result.cells = [
      {
        ...result.cells[0],
        scenario: "01-bug-happy-path",
        runs: [{ ...result.cells[0].runs[0], run_dir: runDir }],
      },
    ];
    const data = buildCriteriaData(result);
    rmSync(dir, { recursive: true, force: true });
    const bucket = data.get("01-bug-happy-path")!;
    expect(bucket.find((c) => c.text === "label applied")).toMatchObject({ passed: 1, failed: 0 });
    expect(bucket.find((c) => c.text === "flags spoofer")).toMatchObject({ passed: 0, failed: 1, type: "P" });
  });
});
