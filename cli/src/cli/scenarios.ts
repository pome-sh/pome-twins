// SPDX-License-Identifier: Apache-2.0
/**
 * `pome scenarios` — browse the bundled scenarios library and optionally
 * copy a twin's runnable scenarios into the current project.
 *
 * Discovery only — no network. Source files live under `scenarios/` in
 * the published tarball; `resolvePackageRoot` locates them whether the
 * CLI was started from `dist/` (published) or `src/` (dev).
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { resolvePackageRoot } from "./resolve-package-root.js";
import {
  SCENARIO_TWINS,
  findTwin,
  runnableScenarios,
  type CatalogScenario,
  type ScenarioTwin,
} from "./scenarios-catalog.js";

export interface ScenariosCommandOptions {
  copy?: boolean;
  force?: boolean;
  dest?: string;
}

const DEFAULT_DEST_DIR = "scenarios";

function useColor(): boolean {
  return Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
}

function dim(s: string): string {
  return useColor() ? `\x1b[2m${s}\x1b[0m` : s;
}

function bold(s: string): string {
  return useColor() ? `\x1b[1m${s}\x1b[0m` : s;
}

export async function runScenariosCommand(
  twinArg: string | undefined,
  opts: ScenariosCommandOptions,
): Promise<void> {
  if (!twinArg) {
    if (opts.copy || opts.force || opts.dest) {
      console.error("Specify a twin to copy from, e.g. `pome scenarios github --copy`.");
      process.exitCode = 2;
      return;
    }
    printTwinIndex();
    return;
  }

  const twin = findTwin(twinArg);
  if (!twin) {
    const available = SCENARIO_TWINS.map((t) => t.id).join(", ");
    console.error(
      `Unknown twin "${twinArg}". Available: ${available}. Run \`pome scenarios\` for the index.`,
    );
    process.exitCode = 2;
    return;
  }

  if (opts.copy) {
    await copyTwinScenarios(twin, {
      destDir: opts.dest ?? DEFAULT_DEST_DIR,
      force: Boolean(opts.force),
    });
    return;
  }

  printTwinScenarios(twin);
}

function printTwinIndex(): void {
  console.log(bold("Pome scenarios"));
  console.log(dim("Bundled scenario library, grouped by twin."));
  console.log("");
  for (const twin of SCENARIO_TWINS) {
    const count = runnableScenarios(twin).length;
    console.log(`  ${bold(twin.id)} ${dim(`(${count} scenarios)`)} — ${twin.label}`);
    console.log(`    ${dim(twin.description)}`);
  }
  console.log("");
  console.log(
    dim("Run `pome scenarios <twin>` to list scenarios, or add `--copy` to drop them into ./scenarios/."),
  );
}

function printTwinScenarios(twin: ScenarioTwin): void {
  const runnable = runnableScenarios(twin);
  console.log(bold(`Pome scenarios — ${twin.label}`));
  console.log(dim(`${runnable.length} scenarios bundled with this CLI.`));
  console.log("");
  for (const scenario of runnable) {
    console.log(`  ${bold(scenario.filename)}`);
    console.log(`    ${dim(scenario.title)} — ${scenario.summary}`);
  }
  console.log("");
  console.log(
    dim(
      `Copy locally: \`pome scenarios ${twin.id} --copy\` (or \`--copy --dest <dir>\`).`,
    ),
  );
  console.log(
    dim(
      `Run one: \`pome run scenarios/${runnable[0]?.filename ?? "01-bug-happy-path.md"}\`.`,
    ),
  );
}

interface CopyOptions {
  destDir: string;
  force: boolean;
}

interface CopyOutcome {
  copied: string[];
  skipped: string[];
  missingSources: string[];
}

export async function copyTwinScenarios(
  twin: ScenarioTwin,
  opts: CopyOptions,
): Promise<void> {
  const root = resolvePackageRoot(import.meta.url);
  if (!root) {
    console.error(
      "Could not locate the installed pome package (package.json not found).",
    );
    process.exitCode = 2;
    return;
  }

  const sourceDir = join(root, "scenarios");
  const destDir = resolve(process.cwd(), opts.destDir);
  await mkdir(destDir, { recursive: true });

  const outcome = await copyScenarioFiles({
    scenarios: runnableScenarios(twin),
    sourceDir,
    destDir,
    force: opts.force,
  });

  console.log(
    bold(
      `Copied ${outcome.copied.length} ${twin.label} scenario${outcome.copied.length === 1 ? "" : "s"} into ${opts.destDir}/.`,
    ),
  );
  for (const file of outcome.copied) {
    console.log(`  ${dim("+")} ${file}`);
  }
  for (const file of outcome.skipped) {
    console.log(
      `  ${dim("-")} ${file} ${dim("(exists — pass --force to overwrite)")}`,
    );
  }
  for (const file of outcome.missingSources) {
    console.error(
      `  ${dim("!")} ${file} ${dim("(missing from this package install)")}`,
    );
  }
  if (outcome.missingSources.length > 0) {
    process.exitCode = 2;
    return;
  }
  console.log("");
  const first = outcome.copied[0] ?? outcome.skipped[0];
  if (first) {
    console.log(
      dim(`Next: \`pome run ${opts.destDir}/${first}\`.`),
    );
  }
}

async function copyScenarioFiles(input: {
  scenarios: CatalogScenario[];
  sourceDir: string;
  destDir: string;
  force: boolean;
}): Promise<CopyOutcome> {
  const outcome: CopyOutcome = { copied: [], skipped: [], missingSources: [] };
  for (const scenario of input.scenarios) {
    const src = join(input.sourceDir, scenario.filename);
    const dest = join(input.destDir, scenario.filename);
    if (!existsSync(src)) {
      outcome.missingSources.push(scenario.filename);
      continue;
    }
    if (existsSync(dest) && !input.force) {
      outcome.skipped.push(scenario.filename);
    } else {
      await copyFile(src, dest);
      outcome.copied.push(scenario.filename);
    }

    // Sidecar seeds (`<name>.seed.json`) are optional — scenarios that use
    // default seed state don't have one. Missing source is silent; missing
    // dest is copied; existing dest follows the same --force rule as the .md.
    const sidecar = scenario.filename.replace(/\.md$/i, ".seed.json");
    const sidecarSrc = join(input.sourceDir, sidecar);
    const sidecarDest = join(input.destDir, sidecar);
    if (!existsSync(sidecarSrc)) continue;
    if (existsSync(sidecarDest) && !input.force) {
      outcome.skipped.push(sidecar);
      continue;
    }
    await copyFile(sidecarSrc, sidecarDest);
    outcome.copied.push(sidecar);
  }
  return outcome;
}
