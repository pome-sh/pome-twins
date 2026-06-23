// SPDX-License-Identifier: Apache-2.0
//
// `pome eval-report <data.json>` — render a curated eval-report aggregate into a
// self-contained, English INTERNAL HTML view. The input conforms to
// `evalReportSchema` (cli/src/matrix/eval-report-schema.ts) and is produced by the
// eval-research aggregate scripts that now live in the `research` workspace — it is
// NOT raw `pome matrix` output (that's a different MatrixResult shape). No eval data
// ships in the OSS repo, so the path must be passed explicitly.
//
// One data layer, two views: this is the internal view; a marketing view can
// derive from the same JSON later.
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadAndRenderEvalReport } from "../matrix/eval-report-html.js";

export type EvalReportOptions = {
  out: string;
};

export async function runEvalReportCommand(
  dataArg: string | undefined,
  options: EvalReportOptions,
): Promise<void> {
  if (!dataArg) {
    console.error("pome eval-report: pass the path to a curated eval-report aggregate JSON (evalReportSchema; produced by the research-workspace aggregate scripts).");
    process.exitCode = 2;
    return;
  }
  const dataPath = resolve(dataArg);
  if (!existsSync(dataPath)) {
    console.error(`pome eval-report: no data file at ${dataPath}`);
    process.exitCode = 2;
    return;
  }
  const outPath = resolve(options.out);
  try {
    const html = await loadAndRenderEvalReport(dataPath);
    await writeFile(outPath, html);
    console.error("pome eval-report — done");
    console.error(`  source:  ${dataPath}`);
    console.error(`  html:    ${outPath}`);
  } catch (err) {
    console.error("pome eval-report: render failed");
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  }
}
