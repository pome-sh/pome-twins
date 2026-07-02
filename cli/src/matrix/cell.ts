// SPDX-License-Identifier: Apache-2.0
//
// Per-cell execution (plan decision — SHELL OUT, never in-process).
//
// `runMatrixCell` spawns the existing `pome run <scenario> --agent <cmd>
// --artifacts-dir <cellDir>` CLI once per run-index, awaits close, then reads
// the run's score.json / meta.json / events.jsonl off disk into a typed
// CellRun. Each cell run is its own OS process with a fresh twin DB handle,
// port range, auth secret and capture buffer — so a concurrency pool over cells
// is safe (the in-process runner mutates process.env + races port/secret
// allocation and could not be parallelized; see the plan's runner finding).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { eventSchema, type Event } from "../types/shared.js";
import type { Score } from "../evaluator/score.js";
import { countAnomalies, anomalyHits, type AnomalyHit } from "./anomalies.js";
import { cellPassed } from "./aggregate.js";
import { runResourceMetrics, type PricingTable } from "./cost.js";
import type { CellRun } from "./types.js";

// How to invoke the `pome` binary as a child. Production re-invokes the same
// compiled binary (process.argv[1]); tests inject `{ execPath:"bun",
// prefixArgs:["src/cli/main.ts"] }` to run from source. Mirrors the runner's
// CaptureServerCommand override idiom so the matrix runs without a global
// install.
export type PomeCommand = {
  execPath: string;
  prefixArgs: string[];
};

// Resolve the `pome` entrypoint once. Three cases:
//   - compiled `dist` run: argv[1] is `…/main.js` → re-invoke `node main.js`.
//   - source run (tsx/`bun run dev`): argv[1] is `…/main.ts` → re-invoke with
//     the same node binary plus the tsx loader (`node --import tsx main.ts`),
//     so the child resolves the runner's `.js`-suffixed ESM imports the same
//     way the parent does. (bun can't host the better-sqlite3 twin, so we stay
//     on node + tsx, not bun.)
//   - argv[1] absent (vitest worker, REPL): fall back to the dist binary path;
//     tests should inject `pomeCommand` instead.
export function resolvePomeCommand(): PomeCommand {
  const argv1 = process.argv[1];
  if (argv1 && existsSync(argv1)) {
    if (argv1.endsWith(".ts")) {
      return { execPath: process.execPath, prefixArgs: ["--import", "tsx", argv1] };
    }
    return { execPath: process.execPath, prefixArgs: [argv1] };
  }
  // Best-effort dist fallback (matches the package "pome" script).
  const distMain = resolve(process.cwd(), "dist/src/cli/main.js");
  return { execPath: process.execPath, prefixArgs: [distMain] };
}

export type RunCellInput = {
  pome: PomeCommand;
  cellId: string;
  scenarioPath: string; // absolute or cwd-relative; passed straight to `pome run`
  agentCommand: string; // the resolved `--agent` command string
  cellDir: string; // <artifactsRoot>/<sanitized agent id>/<slug>
  runIndex: number; // each run-index writes into its own <cellDir>/run-<index>
  pricing: PricingTable;
  // Satisfaction (0–100) a run must clear to count as passed, decoupled from the
  // scenario's own passThreshold so the matrix can apply a fleet-wide override
  // (--pass-threshold). Defaults to 100 (the binary gate) when omitted.
  passThreshold?: number;
  // Extra env injected into the child (e.g. POME_MATRIX_MODEL / _PROMPT_PATH for
  // mcp-loop). Merged over process.env in the child.
  env?: Record<string, string>;
  // Force the local in-process twin path (POME_LOCAL=1). The matrix is a
  // self-host orchestrator — it does not talk to the hosted control plane —
  // so this defaults on.
  local?: boolean;
  // Skip the capture-server child (proxy). Keyless scripted cells make no LLM
  // calls, so capture adds only overhead + a child-spawn dependency; defaults
  // on for them via the orchestrator. When false, LlmCallEvents are captured.
  noCapture?: boolean;
};

export type RunCellOutput = {
  run: CellRun;
  // Anomaly hits from this run, flattened up to the matrix-wide digest.
  anomalies: AnomalyHit[];
  // Per-[P] confidences seen this run (for the cell-level judge-confidence mean
  // the aggregator needs); empty when the run had no [P] criteria / no judge.
  judgeConfidences: number[];
  judgeModel: string | null;
};

// Each run-index gets its own artifacts dir under the cell dir, so concurrent
// run-indexes never collide on latest.json and findRunDir is unambiguous.
function runArtifactsDir(input: RunCellInput): string {
  return join(input.cellDir, `run-${input.runIndex}`);
}

// Spawn `pome run` for one run-index and return its exit code + stdout/stderr.
function spawnPomeRun(input: RunCellInput): Promise<{ exitCode: number }> {
  const args = [
    ...input.pome.prefixArgs,
    "run",
    input.scenarioPath,
    "--agent",
    input.agentCommand,
    "--artifacts-dir",
    runArtifactsDir(input),
  ];
  if (input.noCapture) args.push("--no-capture");

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(input.local ? { POME_LOCAL: "1" } : {}),
    ...(input.env ?? {}),
  };

  return new Promise((resolveSpawn) => {
    const child = spawn(input.pome.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
    // Drain pipes so the child never blocks on a full buffer; the matrix keeps
    // its own console quiet (per-run stdout/stderr already land in the cell's
    // run dir via the runner).
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    child.on("close", (code) => {
      resolveSpawn({ exitCode: code ?? 3 });
    });
    child.on("error", () => {
      resolveSpawn({ exitCode: 3 });
    });
  });
}

// Find the run dir `pome run` wrote for THIS run-index. The runner lays runs
// out as <artifactsDir>/<scenario-slug>/<run_id>, and each run-index uses its
// own <cellDir>/run-<index> artifacts dir, so there is exactly one run_* dir to
// find. Read <artifactsDir>/latest.json first (the runner writes it last),
// falling back to a single-dir scan.
async function findRunDir(artifactsDir: string): Promise<string | null> {
  const latestPath = join(artifactsDir, "latest.json");
  if (existsSync(latestPath)) {
    try {
      const latest = JSON.parse(await readFile(latestPath, "utf8")) as {
        run_dir?: string;
      };
      if (latest.run_dir && existsSync(latest.run_dir)) return latest.run_dir;
    } catch {
      /* fall through to scan */
    }
  }
  if (!existsSync(artifactsDir)) return null;
  const slugs = await readdir(artifactsDir, { withFileTypes: true });
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const slugDir = join(artifactsDir, slug.name);
    const runs = await readdir(slugDir, { withFileTypes: true });
    for (const r of runs) {
      if (r.isDirectory() && r.name.startsWith("run_")) {
        return join(slugDir, r.name);
      }
    }
  }
  return null;
}

async function readJsonOrNull<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

// Tolerant events.jsonl reader: skips rows that fail the strict union parse
// (a forward-compatible event shape must never crash the matrix) rather than
// throwing like `pome inspect`'s reader.
export async function readCellEvents(runDir: string): Promise<Event[]> {
  const path = join(runDir, "events.jsonl");
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf8");
  const events: Event[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const result = eventSchema.safeParse(parsed);
    if (result.success) events.push(result.data);
  }
  return events;
}

type MetaJson = {
  run_id?: string;
  exit_code?: number | null;
};

// Mean confidence across this run's [P] criteria, plus the judge model. Null
// confidence when there are no [P] verdicts carrying a confidence.
function judgeFromScore(score: Score | null): {
  confidences: number[];
  judgeModel: string | null;
} {
  if (!score) return { confidences: [], judgeModel: null };
  const confidences: number[] = [];
  for (const r of score.results) {
    if (
      r.criterion.type === "P" &&
      !r.skipped &&
      typeof r.confidence === "number"
    ) {
      confidences.push(r.confidence);
    }
  }
  return { confidences, judgeModel: score.judge_model };
}

// Execute one run-index of a cell and read its artifacts into a CellRun.
export async function runMatrixCell(input: RunCellInput): Promise<RunCellOutput> {
  const { exitCode } = await spawnPomeRun(input);
  const runDir = await findRunDir(runArtifactsDir(input));

  // No run dir means the child died before writing anything (e.g. a bad agent
  // command). Surface an honest errored run so the cell still produces a row.
  if (!runDir) {
    return {
      run: erroredRun(input, exitCode, "<no-run-dir>", "<no-run-dir>"),
      anomalies: [],
      judgeConfidences: [],
      judgeModel: null,
    };
  }

  const meta = await readJsonOrNull<MetaJson>(join(runDir, "meta.json"));
  const score = await readJsonOrNull<Score>(join(runDir, "score.json"));
  const events = await readCellEvents(runDir);
  const resources = runResourceMetrics(events, input.pricing);
  const { confidences, judgeModel } = judgeFromScore(score);

  const runId = meta?.run_id ?? "<unknown>";
  // The spawned process exit code is authoritative for the agent-error signal
  // (exit 3 = timeout / non-zero agent). The pass/fail decision is recomputed
  // from satisfaction against the matrix pass threshold (default 100), so a
  // fleet-wide --pass-threshold takes effect without re-plumbing `pome run`.
  const agentErrored = exitCode === 3;
  const satisfaction = score?.satisfaction ?? 0;
  const passThreshold = input.passThreshold ?? 100;
  // `can_pass` is absent on legacy score.json → default true (old behavior).
  const canPass = score?.can_pass ?? true;
  const passed = cellPassed(satisfaction, agentErrored, passThreshold, canPass);

  const run: CellRun = {
    run_index: input.runIndex,
    run_id: runId,
    run_dir: runDir,
    passed,
    satisfaction,
    exit_code: exitCode,
    agent_errored: agentErrored,
    criteria_passed: score?.passed ?? 0,
    criteria_failed: score?.failed ?? 0,
    criteria_skipped: score?.skipped ?? 0,
    criteria_errored: score?.errored ?? 0,
    prompt_tokens: resources.prompt_tokens,
    completion_tokens: resources.completion_tokens,
    cost_usd: resources.cost_usd,
    latency_ms: resources.latency_ms,
    tool_calls: resources.tool_calls,
    twin_anomaly_count: countAnomalies(events),
  };

  return {
    run,
    anomalies: anomalyHits(events, input.cellId),
    judgeConfidences: confidences,
    judgeModel,
  };
}

function erroredRun(
  input: RunCellInput,
  exitCode: number,
  runId: string,
  runDir: string,
): CellRun {
  return {
    run_index: input.runIndex,
    run_id: runId,
    run_dir: runDir,
    passed: false,
    satisfaction: 0,
    exit_code: exitCode,
    agent_errored: true,
    criteria_passed: 0,
    criteria_failed: 0,
    criteria_skipped: 0,
    criteria_errored: 0,
    prompt_tokens: null,
    completion_tokens: null,
    cost_usd: null,
    latency_ms: null,
    tool_calls: 0,
    twin_anomaly_count: 0,
  };
}
