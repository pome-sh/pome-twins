// SPDX-License-Identifier: Apache-2.0
//
// `pome matrix-html [results-dir]` — render a finished matrix run into a
// self-contained, English HTML dashboard (report.html) next to its
// matrix.json. With no dir, picks the newest run under the artifacts dir.
// Reusable across sweeps (the founder will run many).
import { readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadAndRender } from "../matrix/report-html.js";

export type MatrixHtmlOptions = {
  artifactsDir: string;
  judgeModel?: string;
};

// Newest immediate subdirectory of `root` that contains a matrix.json.
async function newestResultsDir(root: string): Promise<string | null> {
  if (!existsSync(root)) return null;
  const entries = await readdir(root, { withFileTypes: true });
  const dirs: { path: string; mtime: number }[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = join(root, e.name);
    if (!existsSync(join(p, "matrix.json"))) continue;
    const s = await stat(p);
    dirs.push({ path: p, mtime: s.mtimeMs });
  }
  dirs.sort((a, b) => b.mtime - a.mtime);
  return dirs[0]?.path ?? null;
}

export async function runMatrixHtmlCommand(
  dirArg: string | undefined,
  options: MatrixHtmlOptions,
): Promise<void> {
  let resultsDir: string | null;
  if (dirArg) {
    resultsDir = resolve(dirArg);
    if (!existsSync(join(resultsDir, "matrix.json"))) {
      console.error(`pome matrix-html: no matrix.json in ${resultsDir}`);
      process.exitCode = 2;
      return;
    }
  } else {
    resultsDir = await newestResultsDir(resolve(options.artifactsDir));
    if (!resultsDir) {
      console.error(
        `pome matrix-html: no matrix.json found under ${options.artifactsDir}. Pass a results dir explicitly.`,
      );
      process.exitCode = 2;
      return;
    }
  }

  try {
    const { html, result } = await loadAndRender(
      resultsDir,
      options.judgeModel ?? null,
    );
    const htmlPath = join(resultsDir, "report.html");
    await writeFile(htmlPath, html);
    console.error("pome matrix-html — done");
    console.error(`  source:  ${join(resultsDir, "matrix.json")}`);
    console.error(
      `  grid:    ${result.config.agent_ids.length} models × ${result.config.scenario_slugs.length} scenarios × ${result.config.runs} runs`,
    );
    console.error(`  html:    ${htmlPath}`);
  } catch (err) {
    console.error("pome matrix-html: render failed");
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  }
}
