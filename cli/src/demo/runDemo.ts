// SPDX-License-Identifier: Apache-2.0
// FDRS-643 — `pome demo` orchestration: zero-auth cold start.
//
// Flow per the 2026-07-05 [DECISION] set:
//   1. Reassurance frame first.
//   2. Mint ALL k demo sessions upfront (POST /v1/demo/sessions, one shared
//      grp_ id) — each 15-min TTL comfortably covers the run.
//   3. Per trial: run the bundled agent through the REAL capture path
//      (runScenario: in-process twin + capture-server child + POME_* env),
//      upload the captured blobs with the trial's demo_token as Bearer, then
//      POST /finalize (explicit 60s timeout) — the terminal verdict comes
//      from that cloud evaluation. The CLI never scores locally.
//   4. Errored trials are excluded from the verdict fraction; at-capacity
//      402/429s render as honest labeled states (FDRS-662), never stack
//      traces, never fabricated completions. Any trial that errors after its
//      session was minted best-effort ABANDONS that session with a machine
//      error_code before the CLI exits (F-710 / F-664 decision 3), so the
//      share view flips the slot to errored immediately instead of waiting
//      out the staleness window; a capacity abort also abandons the
//      minted-but-never-run remainder.
//   5. Output ends with the no-login preview link
//      {dashboard}/demo/<group_id>.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAvailablePort } from "../runner/ports.js";
import { runScenario, type RunScenarioOptions } from "../runner/runScenario.js";
import { bootTwin } from "../twin/twinHarness.js";
import { parseScenarioFile } from "../scenario/parseScenario.js";
import { createHostedClient, type HostedClient } from "../hosted/client.js";
import {
  scoreFromFinalizeResponse,
  uploadRunBlobs,
} from "../hosted/uploadAndFinalize.js";
import { outcomeOf, scoreStatus } from "../hosted/evalResultView.js";
import { HostedQuotaError } from "../hosted/errors.js";
import {
  DemoCapacityError,
  capacityKindFrom,
  capacityLabel,
  parseCapacityMarker,
} from "./capacity.js";
import { newGroupId } from "./ids.js";
import { mintDemoSessions, type DemoSession } from "./mint.js";
import {
  criterionPhrase,
  evaluatingLine,
  reassuranceBox,
  summaryLines,
  trialLine,
  trialsHeaderLine,
  twinReadyLine,
  type TrialVerdict,
} from "./render.js";
import { DEMO_REPO, DEMO_TASK_NAME, demoTaskPath } from "./task.js";

/** Explicit finalize timeout — the hosted client defaults to 30s; the demo
 *  judge measured 5-8s, 60s is belt-and-braces ([DECISION]). */
const DEMO_FINALIZE_TIMEOUT_MS = 60_000;

export type DemoTrialClient = Pick<
  HostedClient,
  | "requestEventsUploadUrl"
  | "requestStateUploadUrl"
  | "requestSignalsUploadUrl"
  | "requestMetaUploadUrl"
  | "finalize"
  | "abandonSession"
>;

export interface RunDemoOptions {
  /** Control-plane base URL (POME_API_BASE, default https://api.pome.sh). */
  apiBase: string;
  /** Dashboard base for the preview link (default https://app.pome.sh). */
  dashboardBase: string;
  trials?: number;
  artifactsDir?: string;
  out?: (line: string) => void;
  // ── test seams ─────────────────────────────────────────────────────────
  /** Agent command override. Default re-invokes this binary: `<node> <main.js> demo-agent`. */
  agentCommand?: string;
  captureServerCommand?: RunScenarioOptions["captureServerCommand"];
  runScenarioFn?: typeof runScenario;
  mintFn?: typeof mintDemoSessions;
  /** Per-session upload/finalize client factory (bearer demo_token). */
  trialClientFactory?: (session: DemoSession) => DemoTrialClient;
  /** Skip the warm-up twin boot (tests). */
  skipTwinWarmup?: boolean;
}

export interface RunDemoResult {
  exitCode: number;
  groupId: string;
  verdicts: TrialVerdict[];
}

export async function runDemo(options: RunDemoOptions): Promise<RunDemoResult> {
  const out = options.out ?? ((line: string) => console.error(line));
  const trials = options.trials ?? 5;
  const artifactsDir = options.artifactsDir ?? "runs";
  const runScenarioFn = options.runScenarioFn ?? runScenario;
  const mintFn = options.mintFn ?? mintDemoSessions;
  const trialClientFactory =
    options.trialClientFactory ??
    ((session: DemoSession): DemoTrialClient =>
      createHostedClient({
        baseUrl: options.apiBase,
        apiKey: session.demo_token,
        authScheme: "bearer",
        timeoutMs: DEMO_FINALIZE_TIMEOUT_MS,
      }));

  const groupId = newGroupId();
  const scenarioPath = demoTaskPath();

  for (const line of reassuranceBox()) out(line);
  out("");

  // Mint all k sessions upfront — the group exists before the first trial
  // runs, and an at-capacity day fails HERE with one honest line instead of
  // half-way through a run.
  let sessions: DemoSession[];
  try {
    sessions = await mintFn({
      apiBase: options.apiBase,
      taskName: DEMO_TASK_NAME,
      groupId,
      count: trials,
    });
  } catch (err) {
    if (err instanceof DemoCapacityError) {
      out(capacityLabel(err.kind));
      return { exitCode: 4, groupId, verdicts: [] };
    }
    out(
      `could not reach the pome demo service (${err instanceof Error ? err.message : String(err)})`,
    );
    return { exitCode: 2, groupId, verdicts: [] };
  }

  // Warm-up boot: validates the packaged seed and gives the design's
  // "spinning up github twin … ready" line an honest measurement. Each trial
  // then boots its own isolated twin inside runScenario.
  if (options.skipTwinWarmup !== true) {
    const scenario = await parseScenarioFile(scenarioPath);
    const warmupStart = Date.now();
    const port = await getAvailablePort();
    const harness = await bootTwin({
      twin: "github",
      seedState: scenario.seedState,
      runId: "demo-warmup",
      twinBaseUrl: `http://127.0.0.1:${port}`,
    });
    harness.close();
    out(twinReadyLine((Date.now() - warmupStart) / 1000));
  }

  out(trialsHeaderLine(trials, DEMO_TASK_NAME));

  const agentCommand =
    options.agentCommand ?? defaultDemoAgentCommand(process.execPath, process.argv[1]);

  const verdicts: TrialVerdict[] = [];
  // Failed-criterion texts across evaluated trials, for the "start there" line.
  const collectedFailures: string[] = [];
  let capacityAbort: string | null = null;

  for (let i = 0; i < trials; i += 1) {
    const session = sessions[i]!;
    const trialNumber = i + 1;
    const client = trialClientFactory(session);
    const progress = { finalized: false };

    let verdict: TrialVerdict;
    // F-710 — the machine error_code the abandon carries when this trial's
    // error also aborts the whole demo (capacity); the never-run remainder
    // below reuses it so every orphaned slot names the same cause.
    let abortCode: string | null = null;
    try {
      verdict = await runOneTrial({
        trialNumber,
        session,
        scenarioPath,
        agentCommand,
        artifactsDir,
        apiBase: options.apiBase,
        runScenarioFn,
        client,
        captureServerCommand: options.captureServerCommand,
        out,
        collectedFailures,
        progress,
      });
    } catch (err) {
      if (err instanceof DemoCapacityError) {
        abortCode = err.kind;
        capacityAbort = capacityLabel(err.kind);
        verdict = { kind: "errored", reason: "demo at capacity" };
      } else if (isJudgeCapQuota(err)) {
        abortCode = "daily_judge_cap";
        capacityAbort = capacityLabel("daily_judge_cap");
        verdict = { kind: "errored", reason: "demo at capacity" };
      } else {
        verdict = {
          kind: "errored",
          reason: shortReason(err instanceof Error ? err.message : String(err)),
        };
      }
      // F-710 — flip the errored slot on the share view NOW instead of
      // waiting out the staleness window (F-664 decision 3). Never after a
      // successful finalize: a judged run row must not race an abandon.
      if (!progress.finalized) {
        await abandonQuietly(client, session.session_id, abortCode ?? "trial_crashed");
      }
    }

    verdicts.push(verdict);
    out(trialLine(trialNumber, verdict));

    if (capacityAbort) {
      // F-710 — the abort orphans every minted-but-never-run session; abandon
      // each with the same capacity code so the share view settles honestly
      // instead of showing "running" ghosts for the staleness window.
      for (let j = i + 1; j < trials; j += 1) {
        const orphan = sessions[j]!;
        await abandonQuietly(
          trialClientFactory(orphan),
          orphan.session_id,
          abortCode ?? "unknown_capacity",
        );
      }
      break;
    }
  }

  if (capacityAbort) out(capacityAbort);

  const failing = mostCommonFailedCriterion(collectedFailures);
  out("");
  for (const line of summaryLines({
    verdicts,
    failingCriterionPhrase: failing?.phrase,
    failingCriterionCount: failing?.count,
    previewUrl: `${options.dashboardBase.replace(/\/$/, "")}/demo/${groupId}`,
  })) {
    out(line);
  }

  const evaluated = verdicts.filter((v) => v.kind !== "errored").length;
  const exitCode = evaluated > 0 ? 0 : capacityAbort ? 4 : 1;
  return { exitCode, groupId, verdicts };
}

interface RunOneTrialInput {
  trialNumber: number;
  session: DemoSession;
  scenarioPath: string;
  agentCommand: string;
  artifactsDir: string;
  apiBase: string;
  runScenarioFn: typeof runScenario;
  client: DemoTrialClient;
  captureServerCommand?: RunScenarioOptions["captureServerCommand"];
  out: (line: string) => void;
  collectedFailures: string[];
  /** F-710 — set once finalize succeeds, so the caller's error handling
   *  never abandons a session that already has a judged run row. */
  progress: { finalized: boolean };
}

async function runOneTrial(input: RunOneTrialInput): Promise<TrialVerdict> {
  const startedAt = Date.now();
  const result = await input.runScenarioFn({
    scenarioPath: input.scenarioPath,
    agentCommand: input.agentCommand,
    artifactsDir: input.artifactsDir,
    captureServerCommand: input.captureServerCommand,
    extraAgentEnv: {
      POME_DEMO_LLM_URL: `${input.apiBase}/v1/demo/sessions/${input.session.session_id}/llm`,
      POME_DEMO_TOKEN: input.session.demo_token,
      POME_DEMO_TASK_NAME: DEMO_TASK_NAME,
      POME_DEMO_REPO: DEMO_REPO,
    },
    egressExtraHosts: [new URL(input.apiBase).hostname],
  });
  const agentSeconds = (Date.now() - startedAt) / 1000;

  if (result.exitCode !== 0) {
    const capacityKind = parseCapacityMarker(result.agent.stderr);
    if (capacityKind) {
      // The caller abandons this session (and the never-run remainder) with
      // the capacity kind as it handles the abort.
      throw new DemoCapacityError(capacityKind, capacityLabel(capacityKind));
    }
    if (result.agent.timedOut) {
      await abandonQuietly(input.client, input.session.session_id, "agent_timeout");
      return { kind: "errored", reason: "trial timed out" };
    }
    await abandonQuietly(input.client, input.session.session_id, "agent_exit_nonzero");
    return {
      kind: "errored",
      reason: shortReason(lastLine(result.agent.stderr) ?? "agent failed"),
    };
  }

  // Upload the genuinely captured blobs, then ask the cloud for the verdict.
  input.out(evaluatingLine(input.trialNumber));
  const runDir = result.artifacts.runDir;
  const [eventsJsonl, stateInitialJson, stateFinalJson, metaJson] = await Promise.all([
    readFile(join(runDir, "events.jsonl"), "utf8"),
    readFile(join(runDir, "state_initial.json"), "utf8"),
    readFile(join(runDir, "state_final.json"), "utf8"),
    // D18.1 — best-effort: a demo trial's verdict must never hinge on the
    // meta.json sidecar being readable.
    readFile(join(runDir, "meta.json"), "utf8").catch(() => "{}"),
  ]);
  const uploaded = await uploadRunBlobs(input.client, input.session.session_id, {
    eventsJsonl,
    stateInitialJson,
    stateFinalJson,
    signalsJsonl: "",
    metaJson,
  });

  // criteria: [] — demo finalize replaces the client body with the
  // server-owned task definition entirely (scenario_name selects it).
  const finalized = await input.client.finalize(input.session.session_id, {
    stopReason: "completed",
    exitCode: 0,
    durationMs: Math.max(0, Math.round(agentSeconds * 1000)),
    agentModel: "demo-gateway",
    agentSdk: null,
    criteria: [],
    scenarioName: DEMO_TASK_NAME,
    scenarioHash: "",
    scenarioPrompt: "",
    expectedBehavior: "",
    traceStorageKey: uploaded.eventsKey ?? undefined,
    stateInitialStorageKey: uploaded.stateInitialKey ?? undefined,
    stateFinalStorageKey: uploaded.stateFinalKey ?? undefined,
  });
  input.progress.finalized = true;

  const score = scoreFromFinalizeResponse(finalized);
  const status = scoreStatus(score, 100);
  if (status === "pass") {
    return { kind: "passed", seconds: agentSeconds };
  }
  if (status === "fail") {
    const failedResults = score.results.filter((r) => outcomeOf(r) === "failed");
    for (const r of failedResults) input.collectedFailures.push(r.criterion.text);
    const note = failedResults[0]
      ? criterionPhrase(failedResults[0].criterion.text)
      : "criterion not met";
    return { kind: "failed", seconds: agentSeconds, note };
  }
  // Un-evaluated: the judge could not produce a verdict for this trace —
  // honest exclusion, not a fabricated word.
  return { kind: "errored", reason: "cloud could not evaluate the trace" };
}

/** F-710 — best-effort session abandon on a trial error path: flips the
 *  share-view slot to errored with a machine error_code immediately (F-664
 *  decision 3). SILENT by contract — a network failure or non-200 must change
 *  neither the CLI's exit code nor its terminal output; server-side staleness
 *  (F-664 decision 1) remains the fallback. */
async function abandonQuietly(
  client: DemoTrialClient,
  sessionId: string,
  errorCode: string,
): Promise<void> {
  try {
    await client.abandonSession(sessionId, { errorCode });
  } catch {
    // swallowed — the read-path staleness demotion covers this session
  }
}

function isJudgeCapQuota(err: unknown): boolean {
  return (
    err instanceof HostedQuotaError &&
    capacityKindFrom(402, err.details?.kind) === "daily_judge_cap"
  );
}

function mostCommonFailedCriterion(
  failures: string[],
): { phrase: string; count: number } | null {
  if (failures.length === 0) return null;
  const counts = new Map<string, number>();
  for (const text of failures) {
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  const [text, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  return { phrase: criterionPhrase(text), count };
}

function lastLine(text: string): string | null {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length > 0 ? lines[lines.length - 1]! : null;
}

function shortReason(reason: string): string {
  const flat = reason.replace(/\s+/g, " ").trim();
  return flat.length > 72 ? `${flat.slice(0, 69)}…` : flat;
}

/** Production default: re-invoke this same binary as `pome demo-agent`.
 *  Quotes both parts so paths with spaces survive runAgentCommand's
 *  shell-less split. */
export function defaultDemoAgentCommand(
  execPath: string,
  scriptPath: string | undefined,
): string {
  if (!scriptPath || scriptPath.length === 0) {
    throw new Error(
      "Cannot determine the pome binary path for the demo agent (process.argv[1] is empty).",
    );
  }
  return `"${execPath}" "${scriptPath}" demo-agent`;
}
