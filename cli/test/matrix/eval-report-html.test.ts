// SPDX-License-Identifier: Apache-2.0
//
// Tests for the internal eval-report view. The render path is pure (data in →
// HTML string out), so no spawn / clock / network; the loader is exercised
// against a tmp JSON file.
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderEvalReportHtml,
  loadAndRenderEvalReport,
} from "../../src/matrix/eval-report-html.js";
import { evalReportSchema, type EvalReportData } from "../../src/matrix/eval-report-schema.js";

function fixtureData(): EvalReportData {
  return {
    schema_version: 1,
    run: {
      date: "2026-06-06",
      branch: "test-branch",
      ticket: "FDRS-999",
      fleet_size: 2,
      scenario_count: 2,
      runs_per_cell: 4,
      total_cells: 8,
      scaffold: "mcp-loop",
      judge_model: "anthropic/claude-haiku-4.5",
      twin: "in-CLI GitHub twin (37 MCP tools, unfiltered)",
      gateway: "Vercel AI Gateway (one key)",
    },
    leaderboard: [
      { model: "opus-4.8", provider: "Anthropic", mean_satisfaction: 93.0, n: 8, caught_by: ["18"] },
      { model: "gpt-5.1", provider: "OpenAI", mean_satisfaction: 68.6, n: 8, caught_by: ["05", "18"] },
    ],
    scenarios: [
      {
        slug: "05-github-identity-spoof",
        mean_satisfaction: 66.7,
        pass_variance: 0.113,
        low_signal: false,
        caught: [{ model: "gpt-5.1", fails: 4, runs: 4 }],
      },
      {
        slug: "18-fabricate-green-ci",
        mean_satisfaction: 52.5,
        pass_variance: 0.066,
        low_signal: false,
        caught: [
          { model: "opus-4.8", fails: 4, runs: 4 },
          { model: "gpt-5.1", fails: 4, runs: 4 },
        ],
      },
    ],
    action_failure_18: [
      { model: "opus-4.8", provider: "Anthropic", fabricated: 4, merged: 4, runs: 4 },
      { model: "gpt-5.1", provider: "OpenAI", fabricated: 4, merged: 0, runs: 4 },
    ],
    scenario17: [{ model: "opus-4.8", sats: [100, 100, 100, 100], pass_rate: 1 }],
  };
}

describe("renderEvalReportHtml", () => {
  it("renders a complete English document with no template holes", () => {
    const html = renderEvalReportHtml(fixtureData());
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain(`<html lang="en"`);
    expect(html).not.toMatch(/undefined|NaN|\[object Object\]|\$\{/);
  });

  it("is self-contained — no CDN links or external stylesheets", () => {
    const html = renderEvalReportHtml(fixtureData());
    expect(html).not.toContain("<link");
    expect(html).not.toMatch(/src="https?:\/\//);
    // The only http(s) refs allowed are the GitHub source links in the catalog.
    expect(html).toContain("https://github.com/pome-sh/pome-twins/blob/main/cli/scenarios");
  });

  it("renders the scenario-18 action-failure matrix as the centerpiece", () => {
    const html = renderEvalReportHtml(fixtureData());
    expect(html).toContain("The money visual");
    expect(html).toContain("Fabricate a green CI check");
    // Both models appear in the matrix with their fabricated/merged counts.
    expect((html.match(/class="am-model"/g) ?? []).length).toBe(2);
    expect(html).toContain("create_commit_status");
  });

  it("flags the two pre-publication gates", () => {
    const html = renderEvalReportHtml(fixtureData());
    expect(html).toContain("Before we publish");
    expect(html).toContain("18-v2");
    expect(html).toContain("gemini-fails-01");
  });

  it("renders the scenario catalog with a retired section", () => {
    const html = renderEvalReportHtml(fixtureData());
    expect(html).toContain("The scenario library");
    expect(html).toContain("Retired");
    // 02-missing-label is the retired card.
    expect(html).toContain("02-missing-label");
  });

  it("escapes HTML metacharacters from data (no raw injection)", () => {
    const data = fixtureData();
    data.leaderboard[0].model = "<script>alert(1)</script>";
    const html = renderEvalReportHtml(data);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("loadAndRenderEvalReport", () => {
  it("validates the data file and renders from disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-report-"));
    const file = join(dir, "data.json");
    writeFileSync(file, JSON.stringify(fixtureData()));
    const html = await loadAndRenderEvalReport(file);
    rmSync(dir, { recursive: true, force: true });
    expect(html).toContain("Even frontier models forge a green CI check");
  });

  it("rejects a malformed data file via the schema", () => {
    expect(() => evalReportSchema.parse({ schema_version: 2 })).toThrow();
  });
  // Note: the former "committed eval/agent-eval-r3.json validates and renders"
  // guard was dropped when the eval research data moved out of the OSS repo to
  // `research/` (the renderer is covered by fixtureData() + the tmp-file load
  // test above).
});
