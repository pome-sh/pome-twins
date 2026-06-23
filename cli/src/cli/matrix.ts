// SPDX-License-Identifier: Apache-2.0
//
// `pome matrix` action handler. Wires CLI options → the matrix orchestrator.
//
// --dry-run resolves + prints the cartesian cell grid (agents × scenarios)
// without executing anything. A real run hands off to `runMatrix()` in
// `../matrix/index.js`, which shells out to `pome run` per cell, aggregates the
// outcome-level result, and writes matrix.json + report.md under the artifacts
// dir. buildCells/resolveScenarioPaths are exported so both this command and
// the orchestrator share one grid-resolution path.
import { basename, extname, join, resolve } from "node:path";
import {
  loadAgentsConfig,
  type AgentEntry,
  type ResolvedAgentsConfig,
} from "../matrix/agentsConfig.js";
import type { MatrixCell } from "../matrix/types.js";
import { runMatrix } from "../matrix/index.js";
import { resolveScenarioPaths } from "../matrix/scenarios.js";

// Re-exported for back-compat with stage-1 consumers/tests that imported the
// globber from this module. The implementation now lives in matrix/scenarios.ts
// so the orchestrator can share it without importing the CLI command module.
export { resolveScenarioPaths };

export type MatrixCommandOptions = {
  agents: string;
  scenarios: string;
  runs: string;
  concurrency?: string;
  artifactsDir: string;
  dryRun?: boolean;
  passThreshold?: string;
  judgeModel?: string;
};

export async function runMatrixCommand(
  options: MatrixCommandOptions,
): Promise<void> {
  const runs = Number.parseInt(options.runs, 10);
  if (!Number.isInteger(runs) || runs < 1) {
    console.error(`pome matrix: invalid --runs "${options.runs}" (expected a positive integer)`);
    process.exitCode = 2;
    return;
  }

  let concurrency: number | undefined;
  if (options.concurrency !== undefined) {
    concurrency = Number.parseInt(options.concurrency, 10);
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      console.error(
        `pome matrix: invalid --concurrency "${options.concurrency}" (expected a positive integer)`,
      );
      process.exitCode = 2;
      return;
    }
  }

  let passThreshold: number | undefined;
  if (options.passThreshold !== undefined) {
    passThreshold = Number.parseInt(options.passThreshold, 10);
    if (!Number.isInteger(passThreshold) || passThreshold < 0 || passThreshold > 100) {
      console.error(
        `pome matrix: invalid --pass-threshold "${options.passThreshold}" (expected an integer 0–100)`,
      );
      process.exitCode = 2;
      return;
    }
  }

  let config: ResolvedAgentsConfig;
  try {
    config = await loadAgentsConfig(options.agents);
  } catch (err) {
    console.error(`pome matrix: failed to load --agents ${options.agents}`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }

  let scenarioPaths: string[];
  try {
    scenarioPaths = await resolveScenarioPaths(options.scenarios);
  } catch (err) {
    console.error(`pome matrix: failed to resolve --scenarios ${options.scenarios}`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }
  if (scenarioPaths.length === 0) {
    console.error(`pome matrix: --scenarios ${options.scenarios} matched no .md files`);
    process.exitCode = 2;
    return;
  }

  const artifactsRoot = resolve(options.artifactsDir);

  if (options.dryRun) {
    const cells = buildCells({ config, scenarioPaths, runs, artifactsRoot });
    printGrid({ config, scenarioPaths, runs, cells });
    return;
  }

  // Real run: hand off to the orchestrator. It preflights provider keys, shells
  // out to `pome run` per cell run, aggregates, and writes matrix.json +
  // report.md under the artifacts dir.
  try {
    const { output, result, exitCode } = await runMatrix({
      agentsFile: options.agents,
      scenarios: options.scenarios,
      runs,
      concurrency,
      artifactsRoot,
      passThreshold,
      judgeModel: options.judgeModel,
    });
    if (output.resultsDir) {
      const { aggregate, cells } = result;
      console.error("pome matrix — done");
      console.error(`  cells:   ${cells.length}`);
      console.error(
        `  flaky:   ${aggregate.measurement_reliability.flaky_cells} / ${aggregate.measurement_reliability.total_cells}`,
      );
      console.error(`  report:  ${output.reportMdPath}`);
      console.error(`  matrix:  ${output.matrixJsonPath}`);
    }
    process.exitCode = exitCode;
  } catch (err) {
    console.error("pome matrix: run failed");
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  }
}

// Resolve the `--agent` command string + per-cell artifacts dir for one
// (agent × scenario) pairing. The actual `--agent` command derivation for
// mcp-loop / claude-agent-sdk scaffolds is finalized in stage 3; for now
// scaffold:"command" agents resolve fully (keyless CI fleet) and the other
// scaffolds carry a placeholder the orchestrator will replace.
export function buildCells(input: {
  config: ResolvedAgentsConfig;
  scenarioPaths: string[];
  runs: number;
  artifactsRoot: string;
}): MatrixCell[] {
  const { config, scenarioPaths, runs, artifactsRoot } = input;
  const cells: MatrixCell[] = [];
  for (const agent of config.agents) {
    for (const scenarioPath of scenarioPaths) {
      const slug = slugFromPath(scenarioPath);
      const cellId = `${agent.id}::${slug}`;
      cells.push({
        cell_id: cellId,
        agent_id: agent.id,
        scenario: slug,
        scenario_path: scenarioPath,
        agent_command: resolveAgentCommand(agent),
        cell_dir: join(artifactsRoot, sanitizeForPath(agent.id), slug),
        runs,
        timeout: agent.timeout,
      });
    }
  }
  return cells;
}

// Stage 1 only resolves scaffold:"command" fully. mcp-loop / claude-agent-sdk
// command derivation is finalized in stage 3 (mcp-loop) — the orchestrator
// rewrites this then. We surface a readable placeholder so the dry-run grid is
// still legible.
function resolveAgentCommand(agent: AgentEntry): string {
  if (agent.scaffold === "command") {
    // superRefine guarantees `command` is present for scaffold:"command".
    return agent.command ?? "";
  }
  return `<${agent.scaffold} ${agent.model ?? "?"} prompt=${agent.prompt ?? "default"}>`;
}

function printGrid(input: {
  config: ResolvedAgentsConfig;
  scenarioPaths: string[];
  runs: number;
  cells: MatrixCell[];
}): void {
  const { config, scenarioPaths, runs, cells } = input;
  console.error(`pome matrix — resolved grid`);
  console.error(`  agents:    ${config.agents.length}`);
  console.error(`  scenarios: ${scenarioPaths.length}`);
  console.error(`  runs:      ${runs}`);
  console.error(`  cells:     ${cells.length} (${cells.length * runs} total runs)`);
  console.error("");
  for (const cell of cells) {
    console.error(`  ${cell.cell_id}`);
    console.error(`    agent:   ${cell.agent_command}`);
    console.error(`    dir:     ${cell.cell_dir}`);
  }
}

function slugFromPath(path: string): string {
  return basename(path, extname(path))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function sanitizeForPath(id: string): string {
  // Agent ids carry slashes (e.g. "opus-4.8/sdk/default"); flatten so the
  // per-cell artifacts dir stays a single path segment per agent.
  return id.replace(/[^a-z0-9._-]+/gi, "_");
}
