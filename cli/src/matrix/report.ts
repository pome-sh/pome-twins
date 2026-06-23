// SPDX-License-Identifier: Apache-2.0
//
// Render a MatrixResult into the two on-disk outputs:
//   - matrix.json : the complete machine-readable result (validated against the
//                   shared zod schema before writing, so a malformed aggregate
//                   fails loudly here, not in a downstream consumer).
//   - report.md   : human-readable markdown tables (leaderboard, scenario
//                   discrimination, measurement reliability, twin-anomaly
//                   digest) — the at-a-glance surface for a matrix run.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  matrixResultSchema,
  type MatrixResult,
  type ScenarioDiscrimination,
  type LeaderboardEntry,
  type TwinAnomaly,
  type CellResult,
} from "./types.js";

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

function fmtNum(x: number, digits = 3): string {
  return x.toFixed(digits);
}

function fmtCost(x: number | null): string {
  if (x === null) return "—";
  // Sub-cent costs need more precision; clamp to a readable width.
  return `$${x < 0.01 ? x.toFixed(5) : x.toFixed(4)}`;
}

function fmtMs(x: number | null): string {
  return x === null ? "—" : `${Math.round(x)}ms`;
}

function fmtConf(x: number | null): string {
  return x === null ? "—" : x.toFixed(2);
}

function leaderboardTable(rows: LeaderboardEntry[]): string {
  // Lead with mean satisfaction (the gradient) — it ranks the fleet more finely
  // than the binary pass-rate, which collapses to a few buckets.
  const lines = [
    "| Agent | Mean satisfaction | Mean pass-rate | Cells | Flaky | Total cost |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.agent_id} | ${r.mean_satisfaction.toFixed(1)} | ${fmtPct(r.mean_pass_rate)} | ${r.cells} | ${r.flaky_cells} | ${fmtCost(r.total_cost_usd)} |`,
    );
  }
  return lines.join("\n");
}

function discriminationTable(rows: ScenarioDiscrimination[]): string {
  const lines = [
    "| Scenario | Fleet pass-rate | Pass variance | Signal | Agents |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.scenario} | ${fmtPct(r.fleet_pass_rate)} | ${fmtNum(r.pass_variance)} | ${r.low_signal ? "low-signal" : "discriminating"} | ${r.agents_evaluated} |`,
    );
  }
  return lines.join("\n");
}

function anomalyTable(rows: TwinAnomaly[]): string {
  if (rows.length === 0) {
    return "_No twin anomalies (no 5xx, unsupported endpoints, or recorder errors across the matrix)._";
  }
  const lines = [
    "| Twin | Method | Path | Status | Fidelity | Occurrences | Sample cell |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.twin} | ${r.method} | \`${r.path}\` | ${r.status} | ${r.fidelity} | ${r.occurrences} | ${r.sample_cell_id} |`,
    );
  }
  return lines.join("\n");
}

function cellTable(cells: CellResult[]): string {
  const lines = [
    "| Cell | Pass-rate | Flaky | Mean satisfaction | Judge conf. | Mean cost | Mean latency |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  const sorted = [...cells].sort((a, b) => a.cell_id.localeCompare(b.cell_id));
  for (const c of sorted) {
    lines.push(
      `| ${c.cell_id} | ${fmtPct(c.pass_rate)} | ${c.flaky ? "yes" : "no"} | ${c.mean_satisfaction.toFixed(0)} | ${fmtConf(c.mean_judge_confidence)} | ${fmtCost(c.mean_cost_usd)} | ${fmtMs(c.mean_latency_ms)} |`,
    );
  }
  return lines.join("\n");
}

export function renderReportMarkdown(result: MatrixResult): string {
  const { config, aggregate } = result;
  const rel = aggregate.measurement_reliability;
  const sections: string[] = [];

  sections.push("# Agent eval matrix");
  sections.push("");
  sections.push(`- Generated: ${result.generated_at}`);
  sections.push(`- Git: \`${result.git_sha}\``);
  sections.push(`- Agents file: \`${config.agents_file}\``);
  sections.push(`- Scenarios: \`${config.scenarios_glob}\``);
  sections.push(
    `- Grid: ${config.agent_ids.length} agents × ${config.scenario_slugs.length} scenarios × ${config.runs} runs = ${result.cells.length} cells`,
  );
  sections.push("");

  sections.push("## Leaderboard (internal)");
  sections.push("");
  sections.push(leaderboardTable(aggregate.leaderboard));
  sections.push("");

  sections.push("## Scenario discrimination");
  sections.push("");
  sections.push(
    "_Low-signal scenarios are all-pass or all-fail across the fleet — they do not separate agents._",
  );
  sections.push("");
  sections.push(discriminationTable(aggregate.scenario_discrimination));
  sections.push("");

  sections.push("## Measurement reliability");
  sections.push("");
  sections.push(
    `- Flaky cells: ${rel.flaky_cells} / ${rel.total_cells} (${fmtPct(rel.flaky_rate)})`,
  );
  sections.push(`- Mean judge confidence: ${fmtConf(rel.mean_judge_confidence)}`);
  sections.push(
    `- Judge confidence stdev: ${rel.judge_confidence_stdev === null ? "—" : fmtNum(rel.judge_confidence_stdev)}`,
  );
  sections.push("");

  sections.push("## Twin-anomaly digest");
  sections.push("");
  sections.push(anomalyTable(aggregate.twin_anomaly_digest));
  sections.push("");

  sections.push("## Cells");
  sections.push("");
  sections.push(cellTable(result.cells));
  sections.push("");

  return sections.join("\n");
}

export type WriteReportOutput = {
  resultsDir: string;
  matrixJsonPath: string;
  reportMdPath: string;
};

// Validate (zod) + serialize matrix.json and report.md into `resultsDir`.
// Validation here is the single gate that the aggregate is well-formed before
// anything reads it; a schema failure throws with the zod path.
export async function writeMatrixReport(
  result: MatrixResult,
  resultsDir: string,
): Promise<WriteReportOutput> {
  const validated = matrixResultSchema.parse(result);
  await mkdir(resultsDir, { recursive: true });
  const matrixJsonPath = join(resultsDir, "matrix.json");
  const reportMdPath = join(resultsDir, "report.md");
  await writeFile(matrixJsonPath, `${JSON.stringify(validated, null, 2)}\n`);
  await writeFile(reportMdPath, renderReportMarkdown(validated));
  return { resultsDir, matrixJsonPath, reportMdPath };
}
