// SPDX-License-Identifier: Apache-2.0
//
// FDRS-413 — PR/FAQ acceptance #2 e2e gate. Runs `pome run` against scenario 01
// with the CAS-adapter triage fixture (`packages/adapter-claude-sdk/fixtures/
// cas-triage-agent.ts`) and asserts the resulting events.jsonl shape:
//
//   * ≥ 1 LlmCallEvent
//   * ≥ 1 TwinHttpEvent with tool_call_id non-null (the adapter's
//     x-pome-correlation-id flowed through), and ≥ 1 ToolUseEvent in the same
//     run so the "originating tool use" half of the call is present. See the
//     [DECISION] note below on why this is the operational reading of the
//     "matching event_id" line in FDRS-413's done-when list.
//   * ≥ 1 HookEvent with hook_name="PreToolUse"
//   * `pome inspect` exits 0 with a "Trace health:" section, and the CAS
//     adapter layer is non-zero + [ok] (i.e., "present")
//
// [DECISION] FDRS-413 done-when reads: "TwinHttpEvent.tool_call_id matching an
// originating ToolUseEvent.event_id". The locked adapter architecture
// (FDRS-322) makes those two ids structurally distinct: tool_call_id is an
// ALS-bound `tlc_<hex>` minted by `wrapHandler.generateToolCallId()`, while
// ToolUseEvent.event_id is a separate UUID minted in the signals writer. They
// cannot be made string-equal without coupling that wasn't planned for in M0.
// The intent of the line is to verify the run contains BOTH halves of an
// adapter tool call — the twin-side recorder row tagged with a correlation
// id AND the agent-side payload row from `withToolEvents`. That joint
// presence is what this gate enforces; the literal field-match was Linear
// shorthand, not a schema invariant.
//
// Designed to be run from `cli/`:
//   cd cli && bun run scripts/cas-adapter-acceptance.ts

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCENARIO_PATH = process.env.CAS_ACCEPTANCE_SCENARIO ?? "scenarios/01-bug-happy-path.md";
const AGENT_FIXTURE =
  process.env.CAS_ACCEPTANCE_AGENT ??
  // Resolved relative to `cli/` since `pome run` invokes the agent with cwd=cli.
  "../packages/adapter-claude-sdk/fixtures/cas-triage-agent.ts";
// See the long comment on overhead-gate.ts: pome run spawns the capture-server
// child by re-invoking process.execPath/process.argv[1], so the binary needs
// to be node-runnable. Use the compiled output by default.
const POME_BIN = process.env.CAS_ACCEPTANCE_POME ?? "node dist/src/cli/main.js";
// CI artifact path: where the gate copies the run's events.jsonl + signals
// for visual inspection. Optional — local runs leave it unset.
const ARTIFACT_OUT = process.env.CAS_ACCEPTANCE_ARTIFACT_OUT ?? null;

// The script is designed to run from `cli/`; resolve scenario/agent/bin
// against that root so `pome run` can be spawned from an isolated scaffold dir.
const CLI_ROOT = process.cwd();

// FDRS-641 — `pome run` hard-gates on the doctor wiring checks (config → twin
// → routing → egress) with no --force. This synthetic gate used to run in a
// bare `cli/` with no pome.config.json, so post-FDRS-641 it dies at the config
// check before spawning the agent. Rather than bypass the gate, run `pome run`
// from a throwaway directory holding a valid pome.config.json + a wiring-marker
// source that reads POME_GITHUB_REST_URL — what doctor's routing scan wants,
// with no hardcoded host to trip it. Twin/egress pass against the local github
// twin + deny-by-default floor the run already uses.
async function makeDoctorScaffold(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pome-cas-scaffold-"));
  await writeFile(
    join(dir, "pome.config.json"),
    `${JSON.stringify({ agent: { command: "bun agent.ts" } }, null, 2)}\n`,
  );
  await writeFile(
    join(dir, "agent.ts"),
    [
      "// FDRS-641 doctor wiring marker. The gate's real agent is passed via",
      "// --agent; this file exists only so `pome doctor`'s routing scan finds",
      "// a POME_*_REST_URL read (and no hardcoded host) in the config dir.",
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

interface EventRow {
  kind: string;
  tool_call_id?: unknown;
  tool_use_id?: unknown;
  hook_name?: unknown;
  event_id?: unknown;
}

async function main(): Promise<void> {
  if (!existsSync(SCENARIO_PATH)) fail(`scenario not found: ${SCENARIO_PATH}`);
  if (!existsSync(AGENT_FIXTURE)) fail(`agent fixture not found: ${AGENT_FIXTURE}`);

  const echo = await startEchoServer();
  const target = `127.0.0.1:${echo.port}`;
  const scaffold = await makeDoctorScaffold();
  console.log(`[cas-acceptance] echo target=${target}`);

  try {
    const runDir = await runPome({ target, scaffold });
    console.log(`[cas-acceptance] run dir: ${runDir}`);

    await assertEventsShape(runDir);
    await assertInspect(runDir);

    if (ARTIFACT_OUT) {
      await copyArtifacts(runDir, ARTIFACT_OUT);
      console.log(`[cas-acceptance] artifacts copied to ${ARTIFACT_OUT}`);
    }

    console.log("[cas-acceptance] PASS");
  } finally {
    await echo.close();
    await rm(scaffold, { recursive: true, force: true });
  }
}

async function runPome(input: { target: string; scaffold: string }): Promise<string> {
  const artifactsDir = await mkdtemp(join(tmpdir(), "pome-cas-acceptance-"));
  const [pomeExec, ...pomeArgs] = POME_BIN.split(/\s+/);
  if (!pomeExec) fail("CAS_ACCEPTANCE_POME is empty");
  // Absolute scenario/agent/bin paths: `pome run` is spawned with cwd set to
  // the doctor scaffold dir, so relative paths (resolved against cli/) would
  // break. The pome bin must be absolute because the capture-server child
  // re-invokes `process.execPath process.argv[1]`.
  const args = [
    ...pomeArgs.map(absIfFile),
    "run",
    resolve(CLI_ROOT, SCENARIO_PATH),
    "--agent",
    `bun ${resolve(CLI_ROOT, AGENT_FIXTURE)}`,
    "--artifacts-dir",
    artifactsDir,
  ];

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    POME_LOCAL: "1",
    POME_CLI_DISABLE_KEYCHAIN: "1",
    POME_CAPTURE_TEST_TARGET: input.target,
  };
  env.POME_AGENT_ENV_ALLOWLIST = appendAllowlist(process.env.POME_AGENT_ENV_ALLOWLIST, "POME_CAPTURE_TEST_TARGET");

  // cwd = scaffold dir so `pome run`'s FDRS-641 doctor preflight finds the
  // scaffolded pome.config.json + wiring marker (and passes).
  const { stdout, stderr, exitCode } = await runChild(pomeExec, args, env, input.scaffold);
  if (exitCode !== 0) {
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    fail(`pome run exited ${exitCode}`);
  }

  const latest = JSON.parse(readFileSync(join(artifactsDir, "latest.json"), "utf8")) as {
    run_dir: string;
  };
  return resolve(latest.run_dir);
}

function appendAllowlist(existing: string | undefined, name: string): string {
  const values = new Set((existing ?? "").split(",").map((entry) => entry.trim()).filter(Boolean));
  values.add(name);
  return [...values].join(",");
}

async function assertEventsShape(runDir: string): Promise<void> {
  const eventsPath = join(runDir, "events.jsonl");
  if (!existsSync(eventsPath)) fail(`events.jsonl missing at ${eventsPath}`);
  const raw = await readFile(eventsPath, "utf8");
  const rows: EventRow[] = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as EventRow);

  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.kind] = (counts[row.kind] ?? 0) + 1;
  console.log(
    `[cas-acceptance] events.jsonl rows=${rows.length} ` +
      Object.entries(counts)
        .map(([k, v]) => `${k}=${v}`)
        .join(" "),
  );

  // (i) ≥1 LlmCallEvent
  const llm = rows.filter((r) => r.kind === "LlmCallEvent");
  if (llm.length === 0) fail("expected ≥1 LlmCallEvent, got 0");

  // (ii) ≥1 TwinHttpEvent with tool_call_id non-null …
  const twin = rows.filter((r) => r.kind === "TwinHttpEvent");
  if (twin.length === 0) fail("expected ≥1 TwinHttpEvent, got 0");
  const tagged = twin.filter((r) => typeof r.tool_call_id === "string" && (r.tool_call_id as string).length > 0);
  if (tagged.length === 0) {
    fail(
      `expected ≥1 TwinHttpEvent with non-null tool_call_id, got ${twin.length} ` +
        `TwinHttpEvent rows but none carried a correlation id (was withPome's fetch hook installed?)`,
    );
  }

  // … (ii cont.) and ≥1 ToolUseEvent in the run (see [DECISION] in header).
  const toolUse = rows.filter((r) => r.kind === "ToolUseEvent");
  if (toolUse.length === 0) {
    fail(
      "expected ≥1 ToolUseEvent (originating tool use for the correlation header), got 0",
    );
  }

  // (iii) ≥1 HookEvent with hook_name "PreToolUse"
  const preToolUse = rows.filter(
    (r) => r.kind === "HookEvent" && r.hook_name === "PreToolUse",
  );
  if (preToolUse.length === 0) {
    const hookSummary = rows
      .filter((r) => r.kind === "HookEvent")
      .map((r) => String(r.hook_name))
      .join(",");
    fail(
      `expected ≥1 HookEvent with hook_name="PreToolUse", got 0 (hooks seen: ${hookSummary || "none"})`,
    );
  }

  console.log(
    `[cas-acceptance] shape OK — Llm=${llm.length} TwinTagged=${tagged.length}/${twin.length} ToolUse=${toolUse.length} PreToolUse=${preToolUse.length}`,
  );
}

async function assertInspect(runDir: string): Promise<void> {
  const [pomeExec, ...pomeArgs] = POME_BIN.split(/\s+/);
  if (!pomeExec) fail("CAS_ACCEPTANCE_POME is empty");
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
  // The Trace health renderer emits `  CAS adapter: <count>/expected≥<n> [ok]`
  // when at least one CAS-layer event landed in the trace. We check for that
  // [ok] tail explicitly so a degenerate "0/expected≥1 [warning]" line — which
  // technically contains the string "CAS adapter" — still fails the gate.
  const casLine = stdout
    .split("\n")
    .find((l) => l.includes("CAS adapter:"));
  if (!casLine) fail(`pome inspect Trace health missing "CAS adapter:" line`);
  if (!/\[ok\]/.test(casLine)) {
    fail(`Trace health CAS adapter line not [ok]: "${casLine.trim()}" (FDRS-413 requires CAS adapter present)`);
  }
  if (/\b0\//.test(casLine)) {
    fail(`Trace health CAS adapter count is zero: "${casLine.trim()}"`);
  }
  console.log(`[cas-acceptance] inspect OK — ${casLine.trim()}`);
}

async function copyArtifacts(runDir: string, dest: string): Promise<void> {
  const { mkdir, copyFile } = await import("node:fs/promises");
  await mkdir(dest, { recursive: true });
  // Mirrors the file set the runner produces (see scoreAndWriteRun.ts). We
  // include the score + state diffs because the trace is most useful in CI
  // when paired with what the scorer thought the run did.
  for (const name of [
    "events.jsonl",
    "signals.jsonl",
    "meta.json",
    "score.json",
    "state-diff.json",
    "stdout.txt",
    "stderr.log",
  ]) {
    const src = join(runDir, name);
    if (existsSync(src)) await copyFile(src, join(dest, name));
  }
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

function fail(message: string): never {
  console.error(`[cas-acceptance] FAIL: ${message}`);
  process.exit(1);
}

await main();
