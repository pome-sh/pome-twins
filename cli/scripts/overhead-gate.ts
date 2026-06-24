// SPDX-License-Identifier: Apache-2.0
// FDRS-405 — `agent-trace-overhead-gate`. Runs `pome run` against the bundled
// triage scenario twice — once with the capture-server proxy enabled
// (default) and once with `--no-capture` — accumulates N=100 per-call latency
// samples from each run's agent stdout, and fails if p99(with - without) > 5ms.
//
// Same run also enforces PR/FAQ acceptance #1: scenario 01 with no-adapter
// agent produces `events.jsonl` with ≥1 `LlmCallEvent` + ≥1 `TwinHttpEvent`
// (tool_call_id: null), and `pome inspect <run>` exits 0 + prints a
// "Trace health" section.
//
// Designed to be run from `cli/`:
//   cd cli && bun run scripts/overhead-gate.ts

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  p99Delta,
  parseSamples,
  summarize,
  type LatencyStats,
} from "./overhead-stats.js";

const N = Number.parseInt(process.env.OVERHEAD_BENCH_N ?? "100", 10);
const BUDGET_MS = Number.parseFloat(process.env.OVERHEAD_BENCH_BUDGET_MS ?? "5");
const SCENARIO_PATH = process.env.OVERHEAD_BENCH_SCENARIO ?? "scenarios/01-bug-happy-path.md";
const AGENT_SCRIPT = process.env.OVERHEAD_BENCH_AGENT ?? "scripts/overhead-bench-agent.ts";
// Pome's in-process twin uses better-sqlite3 (no Bun support), and
// pome's capture-server child re-invokes `process.execPath process.argv[1]
// capture-server …` — which only works when argv[1] is a runtime-loadable
// file. Easiest invariant: build first, then point the gate at the compiled
// `dist/src/cli/main.js` so both the parent and the spawned child run under
// node with no transpiler in the loop.
const POME_BIN = process.env.OVERHEAD_BENCH_POME ?? "node dist/src/cli/main.js";

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

  console.log(`[overhead-gate] N=${N} budget=${BUDGET_MS}ms target=${target}`);

  try {
    // RUN A — capture enabled (default). The agent inherits HTTPS_PROXY
    // pointing at the spawned capture-server child; per-iteration timings
    // include the CONNECT-tunnel hop.
    console.log("[overhead-gate] run A: capture enabled");
    const withCapture = await runPome({ noCapture: false, target });

    // RUN B — `--no-capture`. No proxy is spawned, HTTPS_PROXY is unset; the
    // agent makes direct TCP connections to the same upstream.
    console.log("[overhead-gate] run B: --no-capture");
    const withoutCapture = await runPome({ noCapture: true, target });

    const a = summarize(withCapture.samples);
    const b = summarize(withoutCapture.samples);
    const delta = p99Delta(withCapture.samples, withoutCapture.samples);

    printStats("with capture", a);
    printStats("without capture", b);
    console.log(`[overhead-gate] p99(with − without) = ${fmt(delta)}ms (budget ${BUDGET_MS}ms)`);

    // PR/FAQ acceptance #1 — events.jsonl shape after the capture-enabled
    // run. ≥1 LlmCallEvent + ≥1 TwinHttpEvent (tool_call_id: null because
    // this run uses a no-adapter agent).
    await assertPrFaqAcceptance1(withCapture.runDir);

    // PR/FAQ acceptance #1 (cont.) — `pome inspect <run>` must exit 0 and
    // print a "Trace health" section. Run it against the capture-enabled run.
    await assertInspectHealthy(withCapture.runDir);

    if (!Number.isFinite(delta)) {
      fail(`p99 delta is not finite (${delta}); the gate cannot be evaluated`);
    }
    if (delta > BUDGET_MS) {
      fail(`p99 overhead ${fmt(delta)}ms exceeds budget ${BUDGET_MS}ms`);
    }
    console.log("[overhead-gate] PASS");
  } finally {
    await echo.close();
  }
}

async function runPome(input: { noCapture: boolean; target: string }): Promise<RunResult> {
  const artifactsDir = await mkdtemp(join(tmpdir(), `pome-overhead-${input.noCapture ? "off" : "on"}-`));
  const [pomeExec, ...pomeArgs] = POME_BIN.split(/\s+/);
  if (!pomeExec) fail("OVERHEAD_BENCH_POME is empty");
  const args = [
    ...pomeArgs,
    "run",
    SCENARIO_PATH,
    "--agent",
    `bun ${AGENT_SCRIPT}`,
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
  env.POME_AGENT_ENV_ALLOWLIST = appendAllowlist(process.env.POME_AGENT_ENV_ALLOWLIST, "POME_CAPTURE_TEST_TARGET");
  // Pome reads ~/.pome/credentials.json when present; POME_LOCAL=1 routes
  // around it. The keychain shim is also force-disabled so a developer with
  // creds in macOS Keychain doesn't accidentally trigger a hosted run.
  env.POME_CLI_DISABLE_KEYCHAIN = "1";

  const { stdout, stderr, exitCode } = await runChild(pomeExec, args, env);
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

function appendAllowlist(existing: string | undefined, name: string): string {
  const values = new Set((existing ?? "").split(",").map((entry) => entry.trim()).filter(Boolean));
  values.add(name);
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
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((doResolve, doReject) => {
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
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
