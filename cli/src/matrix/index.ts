// SPDX-License-Identifier: Apache-2.0
//
// `runMatrix()` — the matrix orchestrator.
//
// Build the cartesian grid (agents × scenarios × runs), preflight provider
// keys, shell out to `pome run` per cell run with a concurrency-limited pool
// (each run is its own OS process — see cell.ts), fold the per-run records into
// CellResults, aggregate into the outcome-level MatrixAggregate, and write
// matrix.json + report.md into eval/results/<timestamp>/.
//
// PURE/IMPURE split: the cell execution + clock + IO live here; the aggregation
// math is in aggregate.ts (pure) and the rendering is in report.ts, so the
// payoff math stays unit-testable without spawning a single process.
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  loadAgentsConfig,
  type AgentEntry,
  type ResolvedAgentsConfig,
} from "./agentsConfig.js";
import { resolveScenarioPaths } from "./scenarios.js";
import {
  resolvePomeCommand,
  runMatrixCell,
  type PomeCommand,
  type RunCellInput,
} from "./cell.js";
import { type AnomalyHit } from "./anomalies.js";
import { type PricingTable } from "./cost.js";
import { aggregateMatrix, summarizeCell } from "./aggregate.js";
import { resolveJudgeEnv } from "./judge.js";
import { preflightFleet, missingKeyMessage } from "./preflight.js";
import { writeMatrixReport, type WriteReportOutput } from "./report.js";
import type { CellResult, MatrixResult } from "./types.js";
import { twinBuildInfo } from "../twin-github/build-info.js";

export type RunMatrixOptions = {
  agentsFile: string;
  scenarios: string;
  runs: number;
  artifactsRoot: string;
  // Concurrency: how many cell runs execute in parallel. Each is a separate OS
  // process; default keeps the box responsive without starving it.
  concurrency?: number;
  // Skip the provider-key preflight (CI keyless scripted fleet sets this when
  // it knows no keys are needed; the preflight is a no-op for command agents
  // anyway, but this is the explicit escape hatch).
  skipPreflight?: boolean;
  // Satisfaction (0–100) a run must clear to count as passed. Defaults to 100
  // (the binary gate). Lower it to credit "got most of it right" partial runs.
  passThreshold?: number;
  // LLM-judge model slug for [P] criteria (e.g. "anthropic/claude-haiku-4-5").
  // When set, the matrix derives the judge env each cell needs and injects it
  // into the child `pome run` — so [P] criteria actually run instead of being
  // skipped. See resolveJudgeEnv for the routing (gateway-first).
  judgeModel?: string;
  // Test seam: override the `pome` entrypoint and the wall-clock + git-sha so
  // tests can run from source and assert deterministic output.
  pomeCommand?: PomeCommand;
  now?: () => Date;
  gitSha?: string;
  pricingPath?: string; // defaults to eval/pricing.json next to the agents file
};

export type RunMatrixResult = {
  result: MatrixResult;
  output: WriteReportOutput;
  exitCode: number;
};

// Load the tier-2 pricing table. Best-effort: a missing/garbled file yields an
// empty table (tier-1 cost_usd still works; tier-2 just can't fire).
async function loadPricing(pricingPath: string): Promise<PricingTable> {
  if (!existsSync(pricingPath)) return {};
  try {
    const raw = JSON.parse(await readFile(pricingPath, "utf8")) as Record<
      string,
      unknown
    >;
    const table: PricingTable = {};
    for (const [model, v] of Object.entries(raw)) {
      if (model.startsWith("_")) continue; // skip _comment etc.
      if (
        v &&
        typeof v === "object" &&
        typeof (v as Record<string, unknown>).input_per_mtok === "number" &&
        typeof (v as Record<string, unknown>).output_per_mtok === "number"
      ) {
        table[model] = v as { input_per_mtok: number; output_per_mtok: number };
      }
    }
    return table;
  } catch {
    return {};
  }
}

// Resolve an agent entry to the `--agent` command string + extra env. For
// scaffold:"command" this is the raw command. For mcp-loop / claude-agent-sdk
// the model + resolved prompt path flow through env (POME_MATRIX_MODEL /
// POME_MATRIX_PROMPT_PATH) to keep the command string twin-agnostic. The
// mcp-loop entrypoint (examples/agents/mcp-loop-agent.ts) reads that contract.
export function resolveAgentInvocation(
  agent: AgentEntry,
  config: ResolvedAgentsConfig,
): { command: string; env: Record<string, string> } {
  if (agent.scaffold === "command") {
    // superRefine guarantees `command` for scaffold:"command".
    return { command: agent.command ?? "", env: {} };
  }
  const env: Record<string, string> = {};
  if (agent.model) env.POME_MATRIX_MODEL = agent.model;
  if (agent.prompt) {
    const promptPath = config.prompts[agent.prompt];
    if (promptPath) env.POME_MATRIX_PROMPT_PATH = promptPath;
  }
  // mcp-loop runs through the model-agnostic loop entrypoint. The
  // claude-agent-sdk scaffold currently routes here too (its model is resolved
  // by the same provider registry); a native Claude Agent SDK scaffold with its
  // own entrypoint is a documented follow-up, not yet wired.
  const command = "npx tsx examples/agents/mcp-loop-agent.ts";
  return { command, env };
}

// A small concurrency-limited map. Runs `worker` over `items` with at most
// `limit` in flight, preserving input order in the result array.
async function pool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i] as T, i);
    }
  });
  await Promise.all(runners);
  return results;
}

// One unit of work: a single (cell × run-index) execution.
type CellRunTask = {
  cellId: string;
  agentId: string;
  scenario: string;
  scenarioPath: string;
  cellDir: string;
  command: string;
  env: Record<string, string>;
  noCapture: boolean;
  runIndex: number;
};

export async function runMatrix(
  options: RunMatrixOptions,
): Promise<RunMatrixResult> {
  const now = options.now ?? (() => new Date());
  const config = await loadAgentsConfig(options.agentsFile);

  // Preflight provider keys before spawning anything.
  if (!options.skipPreflight) {
    const pf = preflightFleet(config.agents);
    if (!pf.ok) {
      for (const line of missingKeyMessage(pf)) console.error(line);
      const empty = emptyResult(options, config.configPath, now(), options.gitSha);
      return { result: empty, output: await writeNothing(), exitCode: 2 };
    }
  }

  const scenarioPaths = await resolveScenarioPaths(options.scenarios);
  if (scenarioPaths.length === 0) {
    throw new Error(
      `pome matrix: --scenarios ${options.scenarios} matched no .md files`,
    );
  }

  const artifactsRoot = resolve(options.artifactsRoot);
  const pricingPath =
    options.pricingPath ?? resolve(config.configPath, "..", "pricing.json");
  const pricing = await loadPricing(pricingPath);
  const pome = options.pomeCommand ?? resolvePomeCommand();
  const passThreshold = options.passThreshold ?? 100;

  // Resolve the judge env once (gateway-first) and inject it into every cell so
  // [P] criteria are graded rather than skipped. Empty when --judge-model is
  // unset; the note explains the routing either way.
  const judge = resolveJudgeEnv(options.judgeModel);
  console.error(`pome matrix — ${judge.note}`);

  // Build the task list: one entry per (agent × scenario × run-index).
  const tasks: CellRunTask[] = [];
  const cellMeta = new Map<
    string,
    { agentId: string; scenario: string; scenarioPath: string }
  >();
  for (const agent of config.agents) {
    const { command, env } = resolveAgentInvocation(agent, config);
    // Keyless `command` cells make no LLM calls. mcp-loop cells self-report
    // per-call LLM usage (tokens/latency/cost) into the trace via signals, so
    // the capture-server proxy is redundant for them — and worse, its
    // token-less, real-latency LlmCallEvent rows would SUM with the scaffold's
    // (cost.ts sums latency_ms across all LlmCallEvent rows), double-counting
    // latency. Turning capture off makes the scaffold the single source.
    const noCapture =
      agent.scaffold === "command" || agent.scaffold === "mcp-loop";
    for (const scenarioPath of scenarioPaths) {
      const slug = slugOf(scenarioPath);
      const cellId = `${agent.id}::${slug}`;
      const cellDir = join(artifactsRoot, sanitizeId(agent.id), slug);
      cellMeta.set(cellId, {
        agentId: agent.id,
        scenario: slug,
        scenarioPath,
      });
      for (let runIndex = 0; runIndex < options.runs; runIndex++) {
        tasks.push({
          cellId,
          agentId: agent.id,
          scenario: slug,
          scenarioPath,
          cellDir,
          command,
          env,
          noCapture,
          runIndex,
        });
      }
    }
  }

  const concurrency = options.concurrency ?? 4;
  const outputs = await pool(tasks, concurrency, async (task) => {
    const input: RunCellInput = {
      pome,
      cellId: task.cellId,
      scenarioPath: task.scenarioPath,
      agentCommand: task.command,
      cellDir: task.cellDir,
      runIndex: task.runIndex,
      pricing,
      passThreshold,
      // Agent invocation env (model/prompt) + judge routing env (POME_LLM_*).
      env: { ...task.env, ...judge.env },
      local: true,
      noCapture: task.noCapture,
    };
    return runMatrixCell(input);
  });

  // Group run outputs back into cells (input order is grouped by cell already,
  // but group by cell_id explicitly for robustness).
  const byCell = new Map<string, typeof outputs>();
  for (let i = 0; i < tasks.length; i++) {
    const cellId = tasks[i]!.cellId;
    const list = byCell.get(cellId) ?? [];
    list.push(outputs[i]!);
    byCell.set(cellId, list);
  }

  const cells: CellResult[] = [];
  const allAnomalies: AnomalyHit[] = [];
  for (const [cellId, runOutputs] of byCell) {
    const meta = cellMeta.get(cellId)!;
    const summary = summarizeCell({
      cellId,
      agentId: meta.agentId,
      scenario: meta.scenario,
      scenarioPath: meta.scenarioPath,
      runs: runOutputs.map((o) => ({
        passed: o.run.passed,
        satisfaction: o.run.satisfaction,
        cost_usd: o.run.cost_usd,
        latency_ms: o.run.latency_ms,
        judge_confidence:
          o.judgeConfidences.length === 0
            ? null
            : o.judgeConfidences.reduce((a, b) => a + b, 0) /
              o.judgeConfidences.length,
        judge_model: o.judgeModel,
      })),
    });
    // summarizeCell leaves `runs: []`; fill the per-run records (sorted by index).
    summary.runs = runOutputs
      .map((o) => o.run)
      .sort((a, b) => a.run_index - b.run_index);
    cells.push(summary);
    for (const o of runOutputs) allAnomalies.push(...o.anomalies);
  }
  cells.sort((a, b) => a.cell_id.localeCompare(b.cell_id));

  const aggregate = aggregateMatrix(cells, allAnomalies);
  const generatedAt = now().toISOString();
  const gitSha = options.gitSha ?? twinBuildInfo().git_sha;

  const result: MatrixResult = {
    schema_version: 1,
    generated_at: generatedAt,
    git_sha: gitSha,
    config: {
      agents_file: config.configPath,
      scenarios_glob: options.scenarios,
      runs: options.runs,
      agent_ids: config.agents.map((a) => a.id),
      scenario_slugs: scenarioPaths.map(slugOf),
    },
    cells,
    aggregate,
  };

  // results/<timestamp>/ — a real wall-clock read at runtime, never hardcoded.
  const stamp = timestampForDir(now());
  const resultsDir = join(artifactsRoot, stamp);
  const output = await writeMatrixReport(result, resultsDir);

  // Exit code: 0 if every cell fully passed; 1 if any cell did not fully pass.
  const anyFail = cells.some((c) => c.pass_rate < 1);
  return { result, output, exitCode: anyFail ? 1 : 0 };
}

// A filesystem-safe sortable timestamp: 2026-06-01T13-26-18-362Z.
function timestampForDir(d: Date): string {
  return d.toISOString().replace(/:/g, "-").replace(/\./g, "-");
}

function slugOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  const noExt = base.replace(/\.[^.]+$/, "");
  return noExt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-z0-9._-]+/gi, "_");
}

function emptyResult(
  options: RunMatrixOptions,
  configPath: string,
  now: Date,
  gitSha?: string,
): MatrixResult {
  return {
    schema_version: 1,
    generated_at: now.toISOString(),
    git_sha: gitSha ?? twinBuildInfo().git_sha,
    config: {
      agents_file: configPath,
      scenarios_glob: options.scenarios,
      runs: options.runs,
      agent_ids: [],
      scenario_slugs: [],
    },
    cells: [],
    aggregate: {
      scenario_discrimination: [],
      measurement_reliability: {
        total_cells: 0,
        flaky_cells: 0,
        flaky_rate: 0,
        mean_judge_confidence: null,
        judge_confidence_stdev: null,
      },
      twin_anomaly_digest: [],
      leaderboard: [],
    },
  };
}

// Preflight-failure path writes no report; return a placeholder output.
async function writeNothing(): Promise<WriteReportOutput> {
  return { resultsDir: "", matrixJsonPath: "", reportMdPath: "" };
}
