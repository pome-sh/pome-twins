// SPDX-License-Identifier: Apache-2.0
import { serve } from "@hono/node-server";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath, sep as pathSep } from "node:path";
import { sign } from "hono/jwt";
import { parseScenarioFile, seedStateForTwin } from "../scenario/parseScenario.js";
import { bootTwin, type TwinHarness } from "../twin/twinHarness.js";
import { createRecorder } from "../recorder/recorder.js";
import { redactSecrets } from "../recorder/redaction.js";
import { getAvailablePort } from "./ports.js";
import { runAgentCommand } from "./agentRunner.js";
import { egressArgs, spawnCaptureServerChild } from "./captureServerChild.js";
import { buildEgressAllowlist, readBlockedEgress, type BlockedEgress } from "../capture-server/egress.js";
import { mergeAdapterSignalsIntoEvents } from "./mergeAdapterSignals.js";
import { writeRunNoScore } from "./runScenarioCore.js";

// Promisify a Hono/node server `close()` so teardown can await in-flight
// handlers draining before the twin's DB handle is released.
function closeServer(server: ReturnType<typeof serve>): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    server.close((err) => (err ? reject(err) : resolvePromise()));
  });
}

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

  const twins = scenario.config.twins.length ? scenario.config.twins : ["github"];
  const primaryTwin = twins[0]!;
  const isMultiTwin = twins.length > 1;
  const sid = runId;
  const authSecret = process.env.TWIN_AUTH_SECRET ?? randomBytes(32).toString("hex");
  process.env.TWIN_AUTH_SECRET = authSecret;

  // Multi-twin (M3): all twins in one local run share ONE recorder so their
  // HTTP events stream into a single events.jsonl (the same file the
  // capture-server appends to). The runner owns the recorder's lifecycle here;
  // each harness's `close()` releases only its own DB handle. For single-twin
  // this is behaviorally identical to the old bootTwin-internal recorder.
  // The durable store writes TwinHttpEvent rows; finalize dedupes against disk
  // so upload shape stays one row per event.
  const recorder = createRecorder({ eventsPath: eventsJsonlPath });

  // Boot one twin harness per config twin, each on its own localhost port.
  // Merge every twin's POME_<envName>_{REST,MCP}_URL and its extra JWT claims;
  // one token carries the union of claims (e.g. Stripe's account_id).
  const booted: { twin: string; harness: TwinHarness; server: ReturnType<typeof serve> }[] = [];
  const twinEnv: Record<string, string> = {};
  const tokenEnvNames = new Set<string>();
  const stateInitialByTwin: Record<string, unknown> = {};
  let mergedClaims: Record<string, unknown> = {};
  for (const twin of twins) {
    const port = await getAvailablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const harness = await bootTwin({
      twin,
      seedState: seedStateForTwin(scenario, twin),
      runId,
      twinBaseUrl: baseUrl,
      recorder,
    });
    stateInitialByTwin[twin] = await harness.exportState();
    const sessionBase = `${baseUrl}/s/${sid}`;
    // Twin-agnostic URL contract: the agent reads `POME_<TWIN>_{REST,MCP}_URL`.
    // For github this resolves to the historical `POME_GITHUB_{REST,MCP}_URL`;
    // slack/stripe get their own prefixes (the mcp-loop scaffold's
    // `resolveMcpUrl` already keys off `POME_<TWIN>_MCP_URL`).
    twinEnv[`POME_${harness.envName}_REST_URL`] = sessionBase;
    twinEnv[`POME_${harness.envName}_MCP_URL`] = `${sessionBase}/mcp`;
    if (harness.tokenEnvName) tokenEnvNames.add(harness.tokenEnvName);
    mergedClaims = { ...mergedClaims, ...(harness.extraClaims ?? {}) };
    const server = serve({ fetch: harness.app.fetch, port, hostname: "127.0.0.1" });
    booted.push({ twin, harness, server });
  }
  const stateInitial = stateInitialByTwin[primaryTwin];

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
      // to the account the seed data lives in) — merged across all twins.
      // github/slack supply none.
      ...mergedClaims,
      exp: Math.floor(Date.now() / 1000) + Math.max(scenario.config.timeout * 2, 600),
    },
    authSecret
  );

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
  for (const name of tokenEnvNames) twinEnv[name] = token;
  const env = {
    POME_TASK: scenario.prompt,
    POME_TWIN_NAMES: twins.join(","),
    ...twinEnv,
    POME_AUTH_TOKEN: token,
    POME_RUN_ID: runId,
    POME_ARTIFACTS_DIR: runDir,
    POME_ADAPTER_SIGNALS_PATH: signalsPathForEnv,
    ...(options.extraAgentEnv ?? {}),
    ...proxyEnv,
  };

  // Capture each twin's final state: the primary is the legacy `stateFinal`
  // (state_final.json); every other twin is written alongside as
  // `state_final.<twin>.json`. Best-effort disk writes for the extras.
  const captureFinalStates = async (): Promise<unknown> => {
    const finals: Record<string, unknown> = {};
    for (const { twin, harness } of booted) {
      finals[twin] = await harness.exportState();
    }
    if (isMultiTwin) {
      for (const { twin } of booted) {
        if (twin === primaryTwin) continue;
        try {
          await writeFile(
            join(runDir, `state_final.${twin}.json`),
            `${JSON.stringify(redactSecrets(finals[twin]), null, 2)}\n`,
          );
        } catch {
          // best-effort — the primary state_final.json is what writeRun persists
        }
      }
    }
    return finals[primaryTwin];
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
      await recorder.flush?.();
      const stateFinal = await captureFinalStates();
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
        events: recorder.events(),
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
    await recorder.flush?.();
    const stateFinal = await captureFinalStates();
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
      events: recorder.events(),
      stateInitial,
      stateFinal
    });
    await mergeAdapterSignalsIntoEvents(signalsPath, eventsJsonlPath);
    const blockedEgress = await collectBlockedEgress();
    return { scenario, runId, artifacts, agent, exitCode, blockedEgress };
  } finally {
    // Drain capture-server first so any in-flight LlmCallEvent rows land
    // in events.jsonl before we move on; THEN close each twin (releasing its
    // DB handle) and finally the shared recorder (flush + close).
    if (captureServer) await captureServer.shutdown();
    // Await each twin's HTTP server close (letting in-flight handlers drain)
    // BEFORE releasing that twin's DB handle, so a late handler can't run
    // against a closed DB (teardown errors / lost final recorder writes).
    await Promise.all(
      booted.map(async ({ server, harness }) => {
        await closeServer(server);
        await harness.close();
      })
    );
    await recorder.close?.();
  }
}
