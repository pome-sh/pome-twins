// SPDX-License-Identifier: Apache-2.0
// FDRS-405 / F-728 — `agent-trace-overhead-gate`. Runs `pome run` against the
// bundled triage scenario in A/B pairs — capture-server proxy enabled
// (default) vs `--no-capture` — accumulating N per-call latency samples from
// each run's agent stdout. Fails when p99(with − without) exceeds the 5ms
// budget: strictly on the first pair's delta, or (after escalating to
// multiple pairs) on the median delta vs budget + a measured A/A
// runner-noise allowance. See the protocol comment in main().
//
// Same run also enforces PR/FAQ acceptance #1: scenario 01 with no-adapter
// agent produces `events.jsonl` with ≥1 `LlmCallEvent` + ≥1 `TwinHttpEvent`
// (tool_call_id: null), and `pome inspect <run>` exits 0 + prints a
// "Trace health" section.
//
// Designed to be run from `cli/`:
//   cd cli && npx tsx scripts/overhead-gate.ts

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  evaluateGate,
  p99Delta,
  parseSamples,
  summarize,
  type LatencyStats,
} from "./overhead-stats.js";

// F-728 — N default raised 100 → 1000: at N=100 the nearest-rank p99 is the
// second-largest sample, so one OS scheduling stall in either run's tail
// flipped the verdict on shared runners. At N=1000 the p99 sits 10 ranks off
// the max. Samples are local TCP connects, so the extra 900 cost ~1–2s/run.
const N = Number.parseInt(process.env.OVERHEAD_BENCH_N ?? "1000", 10);
// Number of A/B run pairs measured when the first pair lands over budget
// (the escalation path). The verdict is the median of the per-pair deltas.
const PAIRS = Number.parseInt(process.env.OVERHEAD_BENCH_PAIRS ?? "3", 10);
const BUDGET_MS = Number.parseFloat(process.env.OVERHEAD_BENCH_BUDGET_MS ?? "5");
const SCENARIO_PATH = process.env.OVERHEAD_BENCH_SCENARIO ?? "scenarios/01-bug-happy-path.md";
const AGENT_SCRIPT = process.env.OVERHEAD_BENCH_AGENT ?? "scripts/overhead-bench-agent.ts";
// Pome's in-process twin uses better-sqlite3 (Node N-API), and
// pome's capture-server child re-invokes `process.execPath process.argv[1]
// capture-server …` — which only works when argv[1] is a runtime-loadable
// file. Easiest invariant: build first, then point the gate at the compiled
// `dist/src/cli/main.js` so both the parent and the spawned child run under
// node with no transpiler in the loop.
const POME_BIN = process.env.OVERHEAD_BENCH_POME ?? "node dist/src/cli/main.js";

// The script is designed to run from `cli/`; resolve the scenario, agent, and
// pome binary against that root so `pome run` can be spawned from an isolated
// scaffold directory (see makeDoctorScaffold) with a different cwd.
const CLI_ROOT = process.cwd();

// The agent must be launched via cli's own tsx install, NOT `npx tsx`: the
// agent is spawned with cwd = the tmp scaffold (no node_modules), so npx
// resolves tsx from registry.npmjs.org at runtime — a CONNECT the run's
// deny-by-default egress floor refuses, killing the agent preflight (exit 3).
const TSX_BIN = resolve(CLI_ROOT, "node_modules/.bin/tsx");

// FDRS-641 — `pome run` now hard-gates on the doctor wiring checks (config →
// twin → routing → egress) with no --force. This synthetic benchmark used to
// run in a bare `cli/` with no pome.config.json, so post-FDRS-641 it dies at
// the config check before spawning the agent. We can't (and shouldn't) bypass
// the gate, so instead we run `pome run` from a throwaway directory that holds
// a valid pome.config.json plus a wiring-marker source that reads
// POME_GITHUB_REST_URL — exactly what doctor's routing scan wants and nothing
// that trips its hardcoded-host detection. The twin/egress checks pass against
// the local github twin + deny-by-default floor the run already uses.
async function makeDoctorScaffold(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pome-overhead-scaffold-"));
  await writeFile(
    join(dir, "pome.config.json"),
    `${JSON.stringify({ agent: { command: "npx tsx agent.ts" } }, null, 2)}\n`,
  );
  await writeFile(
    join(dir, "agent.ts"),
    [
      "// FDRS-641 doctor wiring marker. The benchmark's real agent is passed",
      "// via --agent; this file exists only so `pome doctor`'s routing scan",
      "// finds a POME_*_REST_URL read (and no hardcoded host) in the config dir.",
      "const baseUrl = process.env.POME_GITHUB_REST_URL;",
      "void baseUrl;",
      "export {};",
      "",
    ].join("\n"),
  );
  return dir;
}

// Turn a path argument into an absolute path when it names an existing file
// under CLI_ROOT (e.g. `dist/src/cli/main.js`), leaving flags untouched — so
// the spawned `node …/main.js` resolves regardless of the child's cwd.
function absIfFile(arg: string): string {
  const abs = resolve(CLI_ROOT, arg);
  return existsSync(abs) ? abs : arg;
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  runDir: string;
  samples: number[];
}

async function main(): Promise<void> {
  if (!existsSync(SCENARIO_PATH)) {
    fail(`scenario not found: ${SCENARIO_PATH} (cwd=${process.cwd()})`);
  }
  if (!existsSync(AGENT_SCRIPT)) {
    fail(`agent not found: ${AGENT_SCRIPT}`);
  }

  // The proxy itself is a CONNECT tunnel — it doesn't introspect the inner
  // bytes, so a plain TCP echo is a fair upstream for measuring CONNECT-tunnel
  // overhead. Avoids dragging openssl / a self-signed cert into CI for
  // millisecond-level math that doesn't care about TLS.
  const echo = await startEchoServer();
  const target = `127.0.0.1:${echo.port}`;
  const scaffold = await makeDoctorScaffold();

  console.log(`[overhead-gate] N=${N} budget=${BUDGET_MS}ms target=${target}`);

  try {
    // F-728 (supersedes the FDRS-405 retry loop) — the gate metric is a
    // difference of two tail percentiles from two separate short runs. The
    // TRUE proxy overhead is ~1ms, but shared-runner noise flipped the
    // verdict near the 5ms budget (PR #99: 5.160ms and 5.442ms on unchanged
    // recorder code, exhausting 3 retries twice — the noise was persistent
    // per-runner, so retry-until-pass couldn't shed it). The protocol now:
    //
    //   1. Measure one A/B pair. Within the strict budget → PASS (the common
    //      quiet-runner case costs the same 2 runs as before).
    //   2. Over budget → escalate: measure PAIRS A/B pairs total, alternating
    //      run order to cancel warm-up bias. Verdict = median(per-pair p99
    //      deltas) ≤ budget + allowance, where allowance is the A/A noise
    //      floor measured from the baseline runs (capped at the budget).
    //
    // A real regression shifts every A/B delta but not the B/B null deltas,
    // so it fails the escalated verdict; runner noise inflates the null
    // deltas too and is absorbed. The PR/FAQ #1 correctness assertions are
    // shape checks independent of latency, so they run once, on the first
    // capture-enabled run.
    const withRuns: number[][] = [];
    const withoutRuns: number[][] = [];
    let acceptanceChecked = false;

    for (let pair = 1; pair <= PAIRS; pair++) {
      // Alternate which side runs first (A,B / B,A / A,B …) so first-run
      // effects (page cache, CPU frequency ramp) don't systematically load
      // onto the capture side.
      const captureFirst = pair % 2 === 1;
      console.log(
        `[overhead-gate] pair ${pair}/${PAIRS}: ${captureFirst ? "capture → no-capture" : "no-capture → capture"}`,
      );
      let withCapture: RunResult;
      let withoutCapture: RunResult;
      if (captureFirst) {
        withCapture = await runPome({ noCapture: false, target, scaffold });
        withoutCapture = await runPome({ noCapture: true, target, scaffold });
      } else {
        withoutCapture = await runPome({ noCapture: true, target, scaffold });
        withCapture = await runPome({ noCapture: false, target, scaffold });
      }
      withRuns.push(withCapture.samples);
      withoutRuns.push(withoutCapture.samples);

      printStats(`with capture #${pair}`, summarize(withCapture.samples));
      printStats(`without capture #${pair}`, summarize(withoutCapture.samples));
      const delta = p99Delta(withCapture.samples, withoutCapture.samples);
      console.log(`[overhead-gate] pair ${pair} p99(with − without) = ${fmt(delta)}ms (budget ${BUDGET_MS}ms)`);

      // PR/FAQ acceptance #1 — events.jsonl shape after the capture-enabled
      // run (≥1 LlmCallEvent + ≥1 TwinHttpEvent with tool_call_id: null, since
      // this run uses a no-adapter agent) and `pome inspect` exits 0 with a
      // "Trace health" section. Correctness, not latency — assert once.
      if (!acceptanceChecked) {
        await assertPrFaqAcceptance1(withCapture.runDir);
        await assertInspectHealthy(withCapture.runDir);
        acceptanceChecked = true;
      }

      // A non-finite delta is a structural failure (e.g. missing samples),
      // not noise — more pairs can't help, so fail immediately.
      if (!Number.isFinite(delta)) {
        fail(`p99 delta is not finite (${delta}); the gate cannot be evaluated`);
      }

      // Fast path: the first pair passing the STRICT budget is the strongest
      // possible verdict — no allowance in play, nothing more to measure.
      if (pair === 1 && delta <= BUDGET_MS) {
        console.log("[overhead-gate] PASS (first pair within strict budget)");
        return;
      }
      if (pair === 1) {
        console.log(
          `[overhead-gate] first pair over budget — escalating to ${PAIRS}-pair protocol with A/A noise allowance`,
        );
      }
    }

    const verdict = evaluateGate(withRuns, withoutRuns, BUDGET_MS);
    console.log(
      `[overhead-gate] escalated verdict: median(deltas)=${fmt(verdict.medianDelta)}ms ` +
        `deltas=[${verdict.deltas.map(fmt).join(", ")}]ms ` +
        `A/A noise floor=${fmt(verdict.noiseFloor)}ms allowance=${fmt(verdict.allowance)}ms ` +
        `effective budget=${fmt(verdict.effectiveBudgetMs)}ms`,
    );
    if (verdict.pass) {
      console.log("[overhead-gate] PASS (median delta within budget + measured runner-noise allowance)");
      return;
    }
    fail(
      `median p99 overhead ${fmt(verdict.medianDelta)}ms exceeded budget ${BUDGET_MS}ms + noise allowance ${fmt(verdict.allowance)}ms across ${PAIRS} pairs — a real regression, not runner noise`,
    );
  } finally {
    await echo.close();
    await rm(scaffold, { recursive: true, force: true });
  }
}

async function runPome(input: { noCapture: boolean; target: string; scaffold: string }): Promise<RunResult> {
  const artifactsDir = await mkdtemp(join(tmpdir(), `pome-overhead-${input.noCapture ? "off" : "on"}-`));
  const [pomeExec, ...pomeArgs] = POME_BIN.split(/\s+/);
  if (!pomeExec) fail("OVERHEAD_BENCH_POME is empty");
  // Absolute scenario/agent/bin paths: `pome run` is spawned with cwd set to
  // the doctor scaffold dir, so relative paths (resolved against cli/) would
  // break. The pome bin must be absolute in particular because the
  // capture-server child re-invokes `process.execPath process.argv[1]`.
  const args = [
    ...pomeArgs.map(absIfFile),
    "run",
    resolve(CLI_ROOT, SCENARIO_PATH),
    "--agent",
    // Quoted: pome run re-tokenizes this string (splitCommand honors quotes),
    // so unquoted absolute paths would split on whitespace-containing checkouts.
    `"${TSX_BIN}" "${resolve(CLI_ROOT, AGENT_SCRIPT)}"`,
    "--artifacts-dir",
    artifactsDir,
  ];
  if (input.noCapture) args.push("--no-capture");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    POME_LOCAL: "1", // force self-host even if hosted credentials exist locally
    POME_CAPTURE_TEST_TARGET: input.target,
    OVERHEAD_BENCH_N: String(N),
  };
  // OVERHEAD_BENCH_N must be allowlisted explicitly or `pome run`'s agent-env
  // filter strips it and the agent silently falls back to its own default —
  // invisible while both defaults were 100 (F-728 raised the orchestrator's).
  env.POME_AGENT_ENV_ALLOWLIST = appendAllowlist(
    process.env.POME_AGENT_ENV_ALLOWLIST,
    "POME_CAPTURE_TEST_TARGET",
    "OVERHEAD_BENCH_N",
  );
  // Pome reads ~/.pome/credentials.json when present; POME_LOCAL=1 routes
  // around it. The keychain shim is also force-disabled so a developer with
  // creds in macOS Keychain doesn't accidentally trigger a hosted run.
  env.POME_CLI_DISABLE_KEYCHAIN = "1";

  // cwd = scaffold dir so `pome run`'s FDRS-641 doctor preflight finds the
  // scaffolded pome.config.json + wiring marker (and passes).
  const { stdout, stderr, exitCode } = await runChild(pomeExec, args, env, input.scaffold);
  if (exitCode !== 0) {
    process.stderr.write(stderr);
    fail(`pome run exited ${exitCode} (noCapture=${input.noCapture})`);
  }

  const runDir = await findRunDir(artifactsDir);
  const agentStdout = await readFile(join(runDir, "stdout.txt"), "utf8");
  const samples = parseSamples(agentStdout);
  if (samples.length === 0) {
    fail(
      `no OVERHEAD_BENCH_SAMPLE_MS lines found in ${join(runDir, "stdout.txt")} (noCapture=${input.noCapture}). agent stdout head: ${agentStdout.slice(0, 800)}`,
    );
  }
  if (samples.length < N) {
    console.warn(`[overhead-gate] warning: got ${samples.length}/${N} samples (noCapture=${input.noCapture})`);
  }
  return { stdout, stderr, exitCode, runDir, samples };
}

function appendAllowlist(existing: string | undefined, ...names: string[]): string {
  const values = new Set((existing ?? "").split(",").map((entry) => entry.trim()).filter(Boolean));
  for (const name of names) values.add(name);
  return [...values].join(",");
}

async function assertPrFaqAcceptance1(runDir: string): Promise<void> {
  const eventsPath = join(runDir, "events.jsonl");
  if (!existsSync(eventsPath)) fail(`events.jsonl missing at ${eventsPath}`);
  const lines = (await readFile(eventsPath, "utf8"))
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const rows = lines.map((l) => JSON.parse(l) as { kind: string; tool_call_id?: unknown });
  const llm = rows.filter((r) => r.kind === "LlmCallEvent");
  const twin = rows.filter((r) => r.kind === "TwinHttpEvent");
  if (llm.length === 0) fail("PR/FAQ #1: expected ≥1 LlmCallEvent, got 0");
  if (twin.length === 0) fail("PR/FAQ #1: expected ≥1 TwinHttpEvent, got 0");
  // No-adapter agent → twin sees no x-pome-correlation-id → tool_call_id null.
  const nullTwin = twin.filter((r) => r.tool_call_id === null);
  if (nullTwin.length === 0) {
    fail(
      `PR/FAQ #1: expected ≥1 TwinHttpEvent with tool_call_id: null, got ${twin.length} TwinHttpEvent rows but none with null tool_call_id`,
    );
  }
  console.log(`[overhead-gate] events.jsonl: ${llm.length} LlmCallEvent + ${twin.length} TwinHttpEvent OK`);
}

async function assertInspectHealthy(runDir: string): Promise<void> {
  const [pomeExec, ...pomeArgs] = POME_BIN.split(/\s+/);
  if (!pomeExec) fail("OVERHEAD_BENCH_POME is empty");
  const { stdout, stderr, exitCode } = await runChild(
    pomeExec,
    [...pomeArgs, "inspect", runDir],
    { ...process.env, POME_CLI_DISABLE_KEYCHAIN: "1" },
  );
  if (exitCode !== 0) {
    process.stderr.write(stderr);
    fail(`pome inspect exited ${exitCode}`);
  }
  if (!stdout.includes("Trace health:")) {
    fail(`pome inspect output missing "Trace health:" section. stdout head: ${stdout.slice(0, 800)}`);
  }
  console.log("[overhead-gate] pome inspect: exit 0 + Trace health section OK");
}

function runChild(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((doResolve, doReject) => {
    const child = spawn(cmd, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", doReject);
    child.once("close", (code) => {
      doResolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

async function findRunDir(artifactsDir: string): Promise<string> {
  // The runner writes `latest.json` at the top of the artifacts dir on
  // every run; read it rather than scanning subdirectories.
  const latest = JSON.parse(readFileSync(join(artifactsDir, "latest.json"), "utf8")) as {
    run_dir: string;
  };
  return resolve(latest.run_dir);
}

async function startEchoServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.on("data", (chunk) => socket.write(chunk));
    socket.once("close", () => sockets.delete(socket));
    socket.once("error", () => sockets.delete(socket));
  });
  await new Promise<void>((doResolve, doReject) => {
    server.once("error", doReject);
    server.listen(0, "127.0.0.1", () => doResolve());
  });
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) fail("echo server returned no address");
  return {
    port: addr.port,
    close: () =>
      new Promise<void>((doResolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => doResolve());
      }),
  };
}

function fmt(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : String(value);
}

function printStats(label: string, stats: LatencyStats): void {
  console.log(
    `[overhead-gate] ${label.padEnd(16)} n=${stats.count} min=${fmt(stats.min)}ms p50=${fmt(stats.p50)}ms p95=${fmt(stats.p95)}ms p99=${fmt(stats.p99)}ms max=${fmt(stats.max)}ms`,
  );
}

function fail(message: string): never {
  console.error(`[overhead-gate] FAIL: ${message}`);
  process.exit(1);
}

await main();
