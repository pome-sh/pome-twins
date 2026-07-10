// SPDX-License-Identifier: Apache-2.0
import { serve } from "@hono/node-server";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath, sep as pathSep } from "node:path";
import { sign } from "hono/jwt";
import { parseScenarioFile } from "../scenario/parseScenario.js";
import { bootTwin } from "../twin/twinHarness.js";
import { getAvailablePort } from "./ports.js";
import { runAgentCommand } from "./agentRunner.js";
import { egressArgs, spawnCaptureServerChild } from "./captureServerChild.js";
import { buildEgressAllowlist, readBlockedEgress, type BlockedEgress } from "../capture-server/egress.js";
import { mergeAdapterSignalsIntoEvents } from "./mergeAdapterSignals.js";
import { writeRunNoScore } from "./runScenarioCore.js";

// Override for how `pome capture-server` is invoked as a child. Production
// re-invokes process.argv[1] (the same compiled `pome` binary). Tests pass
// `{ execPath: process.execPath, prefixArgs: ["--import", "tsx", "src/cli/main.ts"] }` to run from source.
// The full child argv ends up as `[...prefixArgs, "capture-server", "--port",
// "0", "--events-out", <eventsJsonlPath>]`.
export type CaptureServerCommand = {
  execPath: string;
  prefixArgs: string[];
};

export type RunScenarioOptions = {
  scenarioPath: string;
  agentCommand: string;
  artifactsDir?: string;
  captureServerCommand?: CaptureServerCommand;
  // FDRS-405 — skip spawning the capture-server child and do NOT inject
  // HTTP_PROXY/HTTPS_PROXY into the agent env. Used by the overhead-gate
  // CI workflow to measure proxy-on-vs-off latency, and exposed as
  // `pome run --no-capture` for ad-hoc baselining.
  noCapture?: boolean;
  // Fired once the capture-server child is up and listening, with its pid.
  // Tests use this to assert no orphan after the run.
  onCaptureServerSpawned?: (pid: number) => void;
  // FDRS-643 — extra env injected into the agent child on top of the POME_*
  // contract vars. `pome demo` uses this to hand the bundled agent its
  // anonymous-gateway coordinates (POME_DEMO_LLM_URL, POME_DEMO_TOKEN, …).
  // Spread after the built-ins (a caller may deliberately override them) but
  // BEFORE the proxy vars — the capture path is not overridable.
  extraAgentEnv?: Record<string, string>;
  // FDRS-643 — extra egress-floor allowlist patterns for this run (demo mode
  // adds the POME_API_BASE host so gateway CONNECTs aren't refused).
  egressExtraHosts?: readonly string[];
};

export async function runScenario(options: RunScenarioOptions) {
  const scenario = await parseScenarioFile(options.scenarioPath);
  const runId = `run_${randomUUID()}`;
  const artifactsDir = options.artifactsDir ?? "runs";
  const startedAt = new Date().toISOString();

  // FDRS-657 — self-host is CAPTURE-ONLY: record the raw trace + state, never
  // score/judge/correlate locally. A verdict comes only from the cloud.
  const writeRun = writeRunNoScore;

  // FDRS-411: per-run signals file. Lives as a sibling of events.jsonl in the
  // run's artifact directory so adapters that import `@pome-sh/adapter-claude-sdk`
  // and call `withPome()` can write M0 HookEvent / ToolUseEvent rows. The
  // runner merges these into events.jsonl post-run via
  // `mergeAdapterSignalsIntoEvents`. Forward-slash path is passed to the
  // subprocess so cross-platform shell quoting stays sane.
  const runDir = join(artifactsDir, scenario.slug, runId);
  await mkdir(runDir, { recursive: true });
  const signalsPath = join(runDir, "signals.jsonl");
  await writeFile(signalsPath, "");
  const signalsPathForEnv = pathSep === "\\" ? signalsPath.replace(/\\/g, "/") : signalsPath;
  const eventsJsonlPath = join(runDir, "events.jsonl");
  // Touch events.jsonl so the capture-server child has a target file to
  // append to (it would create it anyway, but this also ensures `pome
  // inspect` doesn't fall back to the legacy-detection branch if the run
  // dies before any rows are written).
  await writeFile(eventsJsonlPath, "");

  // FDRS-399: spawn the capture-server child BEFORE the twin and the agent.
  // The agent inherits HTTP_PROXY/HTTPS_PROXY pointing at this child;
  // NO_PROXY keeps twin traffic out of the proxy so it isn't double-counted
  // as LlmCallEvent. FDRS-405: `noCapture` skips spawn + env injection.
  //
  // FDRS-635: the child enforces the deny-by-default egress floor. The
  // allowlist is LLM providers + custom base-URL hosts + POME_EGRESS_ALLOW;
  // the self-host twin lives on loopback, which the floor always allows.
  // Refused CONNECTs land in the egress sidecar, read back after the run so
  // the CLI can name the blocked hosts.
  const egressAllowHosts = buildEgressAllowlist(process.env, {
    extraHosts: options.egressExtraHosts,
  });
  const egressJsonlPath = join(runDir, "egress.jsonl");
  const captureServer = options.noCapture
    ? null
    : await spawnCaptureServerChild({
        eventsOut: resolvePath(eventsJsonlPath),
        allowHosts: egressAllowHosts,
        egressOut: resolvePath(egressJsonlPath),
        execPath: options.captureServerCommand?.execPath,
        binArgs: options.captureServerCommand
          ? [
              ...options.captureServerCommand.prefixArgs,
              "capture-server",
              "--port",
              "0",
              "--events-out",
              resolvePath(eventsJsonlPath),
              ...egressArgs(egressAllowHosts, resolvePath(egressJsonlPath)),
            ]
          : undefined,
      });
  if (captureServer) options.onCaptureServerSpawned?.(captureServer.pid);

  // Drain the capture-server (flushing any in-flight egress rows), then read
  // back the refusals. Idempotent shutdown — the finally block's call is a
  // no-op afterwards.
  const collectBlockedEgress = async (): Promise<BlockedEgress[]> => {
    if (!captureServer) return [];
    await captureServer.shutdown();
    return readBlockedEgress(egressJsonlPath);
  };

  const twinName = scenario.config.twins[0] ?? "github";
  const port = await getAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  // F-698: stream twin HTTP events into the same events.jsonl the
  // capture-server appends to. Durable store writes TwinHttpEvent rows;
  // finalize dedupes against disk so upload shape stays one row per event.
  const harness = await bootTwin({
    twin: twinName,
    seedState: scenario.seedState,
    runId,
    twinBaseUrl: baseUrl,
    eventsPath: eventsJsonlPath,
  });
  const stateInitial = await harness.exportState();

  const sid = runId;
  const authSecret = process.env.TWIN_AUTH_SECRET ?? randomBytes(32).toString("hex");
  process.env.TWIN_AUTH_SECRET = authSecret;
  const token = await sign(
    {
      sid,
      team_id: "tm_local",
      // The self-host agent acts as `pome-agent`, the collaborator the twin
      // seeds onto every repo. Without a login claim the REST merge gate
      // (which checks the authenticated user has push access) rejects merges —
      // the MCP merge path calls the domain directly and never hit this, so it
      // was invisible until a scripted REST agent needed to merge.
      login: "pome-agent",
      // Twin-supplied claims (e.g. Stripe's `account_id`, so the token resolves
      // to the account the seed data lives in). github/slack supply none.
      ...(harness.extraClaims ?? {}),
      exp: Math.floor(Date.now() / 1000) + Math.max(scenario.config.timeout * 2, 600),
    },
    authSecret
  );
  const sessionBase = `${baseUrl}/s/${sid}`;

  const server = serve({ fetch: harness.app.fetch, port, hostname: "127.0.0.1" });

  const proxyEnv: Record<string, string> = captureServer
    ? {
        // FDRS-399 — agent's outbound traffic flows through the capture-server.
        // Twin traffic is localhost, NO_PROXY excludes it so it stays a
        // TwinHttpEvent (recorded in-process) and isn't double-counted as a
        // proxy-captured LlmCallEvent.
        HTTP_PROXY: `http://127.0.0.1:${captureServer.port}`,
        HTTPS_PROXY: `http://127.0.0.1:${captureServer.port}`,
        NO_PROXY: "127.0.0.1,localhost",
      }
    : {};
  const env = {
    POME_TASK: scenario.prompt,
    POME_TWIN_NAMES: scenario.config.twins.join(","),
    // Twin-agnostic URL contract: the agent reads `POME_<TWIN>_{REST,MCP}_URL`.
    // For github this resolves to the historical `POME_GITHUB_{REST,MCP}_URL`;
    // slack/stripe get their own prefixes (the mcp-loop scaffold's
    // `resolveMcpUrl` already keys off `POME_<TWIN>_MCP_URL`).
    [`POME_${harness.envName}_REST_URL`]: sessionBase,
    [`POME_${harness.envName}_MCP_URL`]: `${sessionBase}/mcp`,
    POME_AUTH_TOKEN: token,
    POME_RUN_ID: runId,
    POME_ARTIFACTS_DIR: runDir,
    POME_ADAPTER_SIGNALS_PATH: signalsPathForEnv,
    ...(options.extraAgentEnv ?? {}),
    ...proxyEnv,
  };

  try {
    const preflight = await runAgentCommand({
      command: options.agentCommand,
      env,
      // Cold agent startup can exceed 10s on CI; cap preflight below full scenario
      // timeout but leave enough headroom for toolchain startup.
      timeoutSeconds: Math.min(60, scenario.config.timeout),
      preflight: true
    });
    if (preflight.exitCode !== 0) {
      // Flush durable twin rows before finalize/merge so pending TwinHttpEvent
      // lines are on disk before events.jsonl is rewritten (not only in finally).
      await harness.flush();
      const stateFinal = await harness.exportState();
      const { artifacts, exitCode } = await writeRun({
        artifactsDir,
        runId,
        scenario,
        startedAt,
        completedAt: new Date().toISOString(),
        agentStdout: preflight.stdout,
        agentStderr: preflight.stderr,
        agentExitCode: preflight.exitCode,
        agentTimedOut: preflight.timedOut ?? false,
        events: harness.events(),
        stateInitial,
        stateFinal
      });
      await mergeAdapterSignalsIntoEvents(signalsPath, eventsJsonlPath);
      // Preflight failure always exits 3 (matches prior behavior).
      void exitCode;
      const blockedEgress = await collectBlockedEgress();
      return { scenario, runId, artifacts, agent: preflight, exitCode: 3, blockedEgress };
    }

    const agent = await runAgentCommand({
      command: options.agentCommand,
      env,
      timeoutSeconds: scenario.config.timeout
    });
    await harness.flush();
    const stateFinal = await harness.exportState();
    const { artifacts, exitCode } = await writeRun({
      artifactsDir,
      runId,
      scenario,
      startedAt,
      completedAt: new Date().toISOString(),
      agentStdout: agent.stdout,
      agentStderr: agent.stderr,
      agentExitCode: agent.exitCode,
      agentTimedOut: agent.timedOut ?? false,
      events: harness.events(),
      stateInitial,
      stateFinal
    });
    await mergeAdapterSignalsIntoEvents(signalsPath, eventsJsonlPath);
    const blockedEgress = await collectBlockedEgress();
    return { scenario, runId, artifacts, agent, exitCode, blockedEgress };
  } finally {
    // Drain capture-server first so any in-flight LlmCallEvent rows land
    // in events.jsonl before we move on; THEN close the twin (which flushes
    // the durable recorder and resets twin-side sockets).
    if (captureServer) await captureServer.shutdown();
    server.close();
    await harness.close();
  }
}
