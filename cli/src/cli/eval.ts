// SPDX-License-Identifier: Apache-2.0
//
// `pome eval [run-dir]` — upload an EXISTING raw trace directory to Pome
// cloud for authoritative evaluation and print the score (FDRS-656; the
// capture/eval split contract: CLI captures, cloud evaluates). No local
// scoring happens anywhere in this command (ADR-013) — the printed verdict
// is whatever POST /v1/sessions/:id/finalize returns.
//
// Server contract (FDRS-655, pome-cloud — must land + deploy first):
//   POST /v1/eval-sessions  { agent, task_name } → 201 { session_id, expires_at }
// After that the EXISTING presigned upload-url routes and /finalize work
// unchanged on the minted session.
//
// Idempotent re-runs: the minted session id is persisted to
// `<run-dir>/eval-session.json` together with the agent/task/api-url it was
// minted for. Re-running `pome eval` on the same dir with the same identity
// reuses that session, so /finalize's idempotent fast-path returns the
// already-judged run instead of re-judging (and instead of erroring). A
// changed --agent/--task/--api-url invalidates the marker (fresh mint), and
// a stored session that the server reaped (404/410) gets one fresh-mint
// retry.

import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  createHostedClient,
  type HostedClient,
} from "../hosted/client.js";
import {
  HostedOrchError,
  HostedUsageError,
  exitCodeFor,
} from "../hosted/errors.js";
import {
  redactJsonl,
  scoreFromFinalizeResponse,
  uploadRunBlobs,
  type UploadClient,
} from "../hosted/uploadAndFinalize.js";
import { readLatestRun, toTwinHttpEvent } from "../recorder/artifacts.js";
import { redactEvent, redactSecrets } from "../recorder/redaction.js";
import {
  markerFor,
  outcomeOf,
  runScoreLine,
  scoreCountsSummary,
  scoreStatus,
  type Score,
} from "../hosted/evalResultView.js";
import { resolveCredentials } from "./credentials.js";
import {
  normalizeConfigAgentSdk,
  readProjectConfig,
  type ProjectConfig,
} from "./project-config.js";
import type { RecorderEvent as LegacyGithubRecorderEvent } from "@pome-sh/shared-types";
import type { FinalizeResponse } from "../types/shared.js";

const EVAL_SESSION_FILE = "eval-session.json";
// The eval command has no scenario file (and therefore no per-scenario
// threshold); mirror `pome run`'s default binary gate.
const EVAL_PASS_THRESHOLD = 100;

// ---------------------------------------------------------------------------
// meta.json
// ---------------------------------------------------------------------------

/** The fields `writeRunArtifactsCore` persists to meta.json that `pome eval`
 *  relies on. Everything is optional-by-parse — validation happens in
 *  `deriveEvalIdentity` so the error can name the flag that fixes it. */
export interface RunMeta {
  runId: string | null;
  /** Scenario slug (`meta.json` key: `scenario`) — the default task name. */
  scenario: string | null;
  title: string | null;
  startedAt: string | null;
  completedAt: string | null;
  exitCode: number | null;
}

function parseExitCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  // Tolerate integer-like strings ("2") from hand-assembled meta.json —
  // silently mapping them to null used to report a fabricated clean exit.
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return null;
}

export function parseRunMeta(raw: unknown): RunMeta {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HostedUsageError(
      "pome eval: meta.json is corrupt — expected a JSON object.",
    );
  }
  const obj = raw as Record<string, unknown>;
  const str = (key: string): string | null => {
    const v = obj[key];
    return typeof v === "string" && v.trim().length > 0 ? v : null;
  };
  return {
    runId: str("run_id"),
    scenario: str("scenario"),
    title: str("title"),
    startedAt: str("started_at"),
    completedAt: str("completed_at"),
    exitCode: parseExitCode(obj.exit_code),
  };
}

// ---------------------------------------------------------------------------
// run-dir validation
// ---------------------------------------------------------------------------

export interface RunDirArtifacts {
  runDir: string;
  meta: RunMeta;
  /** Raw file contents; wrapping + redaction re-applied at upload time. */
  eventsJsonl: string;
  stateInitialJson: string;
  stateFinalJson: string;
  /** Present only when the optional signals.jsonl exists. */
  signalsJsonl: string | null;
  /** D18.1 — raw meta.json text (the same bytes `meta` was parsed from),
   *  re-redacted and uploaded via `requestMetaUploadUrl`. */
  metaJson: string;
}

async function readRequiredFile(runDir: string, name: string): Promise<string> {
  try {
    return await readFile(join(runDir, name), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HostedUsageError(
        `pome eval: ${name} not found in ${runDir} — expected a pome run directory (runs/<scenario>/<run-id>).`,
      );
    }
    throw new HostedUsageError(
      `pome eval: ${name} could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function parseJsonFile(name: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new HostedUsageError(
      `pome eval: ${name} is corrupt — not valid JSON (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
}

function validateJsonl(name: string, raw: string): void {
  const lines = raw.split("\n");
  let nonEmpty = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    nonEmpty += 1;
    try {
      JSON.parse(line);
    } catch {
      throw new HostedUsageError(
        `pome eval: ${name} is corrupt — line ${i + 1} is not valid JSON.`,
      );
    }
  }
  if (name === "events.jsonl" && nonEmpty === 0) {
    throw new HostedUsageError(
      "pome eval: events.jsonl is empty — the run captured no trace to evaluate.",
    );
  }
}

/** Read + validate a raw trace directory. Every missing/corrupt artifact
 *  fails with an error that names the offending file (FDRS-656). */
export async function readRunDirArtifacts(
  runDir: string,
): Promise<RunDirArtifacts> {
  const stats = await stat(runDir).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new HostedUsageError(
      `pome eval: run directory not found: ${runDir}`,
    );
  }

  const metaRaw = await readRequiredFile(runDir, "meta.json");
  const meta = parseRunMeta(parseJsonFile("meta.json", metaRaw));

  const eventsJsonl = await readRequiredFile(runDir, "events.jsonl");
  validateJsonl("events.jsonl", eventsJsonl);

  const stateInitialJson = await readRequiredFile(runDir, "state_initial.json");
  parseJsonFile("state_initial.json", stateInitialJson);
  const stateFinalJson = await readRequiredFile(runDir, "state_final.json");
  parseJsonFile("state_final.json", stateFinalJson);

  // signals.jsonl is optional (adapter-emitted); when present it must parse.
  let signalsJsonl: string | null = null;
  try {
    signalsJsonl = await readFile(join(runDir, "signals.jsonl"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new HostedUsageError(
        `pome eval: signals.jsonl could not be read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (signalsJsonl !== null) validateJsonl("signals.jsonl", signalsJsonl);

  return {
    runDir,
    meta,
    eventsJsonl,
    stateInitialJson,
    stateFinalJson,
    signalsJsonl,
    metaJson: metaRaw,
  };
}

// ---------------------------------------------------------------------------
// agent + task derivation
// ---------------------------------------------------------------------------

export interface EvalIdentity {
  agent: string;
  taskName: string;
}

/** Precedence: explicit flags → meta.json (`scenario`, then `title`) for the
 *  task; explicit flag → pome.config.json (`agentSlug`, then `agentId`) for
 *  the agent. */
export function deriveEvalIdentity(
  meta: RunMeta,
  flags: { agent?: string; task?: string },
  config: ProjectConfig | null,
): EvalIdentity {
  const taskName = flags.task?.trim() || meta.scenario || meta.title;
  if (!taskName) {
    throw new HostedUsageError(
      "pome eval: could not derive a task name — meta.json has no `scenario` or `title` field. Pass --task <name>.",
    );
  }
  const agent = flags.agent?.trim() || configAgent(config);
  if (!agent) {
    throw new HostedUsageError(
      "pome eval: no agent identity found. Pass --agent <slug>, or run `pome register agent <name>` so pome.config.json carries agentSlug.",
    );
  }
  return { agent, taskName };
}

function configAgent(config: ProjectConfig | null): string | null {
  if (!config) return null;
  const slug = typeof config.agentSlug === "string" ? config.agentSlug.trim() : "";
  if (slug.length > 0) return slug;
  const id = typeof config.agentId === "string" ? config.agentId.trim() : "";
  if (id.length > 0) return id;
  return null;
}

/** Walk up from the run dir first (in-project runs), then from the CWD
 *  (external run dirs like `pome eval /tmp/some-run` invoked from a
 *  configured project). Corrupt configs surface as named usage errors
 *  instead of raw JSON.parse throws (exit 2). */
async function discoverProjectConfig(
  runDir: string,
): Promise<ProjectConfig | null> {
  const fromRunDir = await readConfigNamed(runDir);
  if (fromRunDir) return fromRunDir;
  return readConfigNamed(process.cwd());
}

async function readConfigNamed(startDir: string): Promise<ProjectConfig | null> {
  try {
    return (await readProjectConfig(startDir))?.config ?? null;
  } catch (err) {
    throw new HostedUsageError(
      `pome eval: pome.config.json is corrupt — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// eval-session persistence (idempotent re-runs)
// ---------------------------------------------------------------------------

/** Strip trailing slashes so `https://api.pome.sh` and `https://api.pome.sh/`
 *  compare equal. */
function normalizeApiUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

async function readStoredEvalSession(
  runDir: string,
  apiBaseUrl: string,
  identity: EvalIdentity,
): Promise<string | null> {
  let parsed: {
    session_id?: unknown;
    api_url?: unknown;
    agent?: unknown;
    task_name?: unknown;
  };
  try {
    parsed = JSON.parse(
      await readFile(join(runDir, EVAL_SESSION_FILE), "utf8"),
    ) as typeof parsed;
  } catch {
    // Missing or corrupt marker → behave like a first run.
    return null;
  }
  if (typeof parsed.session_id !== "string" || parsed.session_id.length === 0) {
    return null;
  }
  // The marker must record WHAT the session was minted for. A missing or
  // different api_url/agent/task means the stored session would misattribute
  // this invocation's verdict — invalidate and mint fresh.
  const matches =
    typeof parsed.api_url === "string" &&
    normalizeApiUrl(parsed.api_url) === normalizeApiUrl(apiBaseUrl) &&
    parsed.agent === identity.agent &&
    parsed.task_name === identity.taskName;
  if (!matches) {
    console.warn(
      `[pome] ${EVAL_SESSION_FILE} was minted for a different agent/task/api-url — minting a fresh eval session`,
    );
    return null;
  }
  return parsed.session_id;
}

async function writeStoredEvalSession(
  runDir: string,
  sessionId: string,
  apiBaseUrl: string,
  identity: EvalIdentity,
): Promise<void> {
  const payload = {
    session_id: sessionId,
    api_url: apiBaseUrl,
    agent: identity.agent,
    task_name: identity.taskName,
    created_at: new Date().toISOString(),
  };
  await writeFile(
    join(runDir, EVAL_SESSION_FILE),
    `${JSON.stringify(payload, null, 2)}\n`,
  ).catch(() => undefined); // best-effort: read-only run dirs still evaluate
}

/** True only for the "stored session no longer exists" shape (404/410 from
 *  the control plane, or its "not found" message when a status is missing).
 *  Transient 5xx orch errors must NOT trigger a fresh mint — re-judging an
 *  already-evaluated dir would duplicate the run and the judge spend. */
function isSessionGoneError(err: unknown): boolean {
  if (!(err instanceof HostedOrchError)) return false;
  if (err.status === 404 || err.status === 410) return true;
  return err.status === undefined && /not found/i.test(err.message);
}

// ---------------------------------------------------------------------------
// core flow
// ---------------------------------------------------------------------------

/** The narrow client surface `runEval` needs; tests mock exactly this. */
export type EvalClient = UploadClient &
  Pick<HostedClient, "createEvalSession" | "finalize">;

export interface RunEvalOptions {
  runDir: string;
  agent?: string;
  task?: string;
  hosted: { baseUrl: string; apiKey: string };
  /** For tests: inject a client. Otherwise constructed from `hosted`. */
  client?: EvalClient;
  /** For tests: bypass pome.config.json discovery (pass null for "none"). */
  projectConfig?: ProjectConfig | null;
}

export interface RunEvalResult {
  taskName: string;
  agent: string;
  sessionId: string;
  /** True when a stored eval-session was reused, so /finalize may have hit
   *  its idempotent fast-path and returned an already-judged run. */
  reusedSession: boolean;
  cloudRunId: string;
  dashboardUrl: string;
  score: Score;
  exitCode: number;
}

export async function runEval(options: RunEvalOptions): Promise<RunEvalResult> {
  const runDir = options.runDir;
  const artifacts = await readRunDirArtifacts(runDir);

  const config =
    options.projectConfig !== undefined
      ? options.projectConfig
      : await discoverProjectConfig(runDir);

  const identity = deriveEvalIdentity(
    artifacts.meta,
    { agent: options.agent, task: options.task },
    config,
  );
  const { agent, taskName } = identity;

  const client =
    options.client ??
    createHostedClient({
      baseUrl: options.hosted.baseUrl,
      apiKey: options.hosted.apiKey,
    });

  // Re-apply wrapping + redaction before anything leaves the machine.
  // events.jsonl and the state blobs are written pre-redacted (and
  // pre-wrapped) by artifacts.ts, but `pome eval` also accepts
  // hand-assembled dirs — redaction is idempotent, and toTwinHttpEvent
  // passes rows that already carry a `kind` through untouched, so this is
  // cheap insurance that exactly mirrors what the hosted runner uploads
  // (cloud's FDRS-398 schema gate rejects raw legacy rows).
  const eventsJsonl =
    artifacts.eventsJsonl
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) =>
        JSON.stringify(
          redactEvent(
            toTwinHttpEvent(JSON.parse(line) as LegacyGithubRecorderEvent),
          ),
        ),
      )
      .join("\n") + "\n";
  const blobs = {
    eventsJsonl,
    stateInitialJson: JSON.stringify(
      redactSecrets(JSON.parse(artifacts.stateInitialJson)),
    ),
    stateFinalJson: JSON.stringify(
      redactSecrets(JSON.parse(artifacts.stateFinalJson)),
    ),
    signalsJsonl: redactJsonl(artifacts.signalsJsonl ?? ""),
    // D18.1 — already validated as parseable JSON in readRunDirArtifacts.
    metaJson: JSON.stringify(redactSecrets(JSON.parse(artifacts.metaJson))),
  };

  let reusedSession = false;
  let sessionId = await readStoredEvalSession(
    runDir,
    options.hosted.baseUrl,
    identity,
  );
  if (sessionId) {
    reusedSession = true;
  } else {
    const minted = await client.createEvalSession({ agent, taskName });
    sessionId = minted.session_id;
    await writeStoredEvalSession(runDir, sessionId, options.hosted.baseUrl, identity);
  }

  async function uploadAndFinalize(sid: string): Promise<FinalizeResponse> {
    const keys = await uploadRunBlobs(client, sid, blobs);
    return client.finalize(sid, {
      stopReason: "eval_upload",
      // /finalize's schema requires an integer exit_code, so `null` (agent
      // timed out, or meta.json lacked the field) cannot pass through.
      // Send -1 as the explicit "unknown" sentinel — never a fabricated 0,
      // which would report a clean agent exit the trace can't vouch for.
      exitCode: artifacts.meta.exitCode ?? -1,
      durationMs: durationMsFrom(artifacts.meta),
      agentModel: "unknown",
      agentSdk: config ? normalizeConfigAgentSdk(config) : null,
      // Eval sessions carry no client-side criteria — the cloud eval judge
      // owns them (FDRS-655). Cloud's finalize schema defaults all scenario
      // fields, so empty strings are accepted.
      criteria: [],
      scenarioName: taskName,
      scenarioHash: "",
      scenarioPrompt: "",
      expectedBehavior: "",
      traceStorageKey: keys.eventsKey ?? undefined,
      stateInitialStorageKey: keys.stateInitialKey ?? undefined,
      stateFinalStorageKey: keys.stateFinalKey ?? undefined,
      signalsStorageKey: keys.signalsKey ?? undefined,
    });
  }

  let finalized: FinalizeResponse;
  try {
    finalized = await uploadAndFinalize(sessionId);
  } catch (err) {
    // The stored session may have been reaped server-side (TTL) since the
    // last attempt. Mint a fresh session and retry ONCE — but only for
    // reused sessions and ONLY for the 404/410 "session gone" shape.
    // Transient orch errors (502/503) and auth/quota/usage errors propagate
    // untouched: blind re-minting on a 502 would silently re-judge an
    // already-evaluated dir (duplicate run + judge spend).
    if (!reusedSession || !isSessionGoneError(err)) throw err;
    const minted = await client.createEvalSession({ agent, taskName });
    sessionId = minted.session_id;
    reusedSession = false;
    await writeStoredEvalSession(runDir, sessionId, options.hosted.baseUrl, identity);
    finalized = await uploadAndFinalize(sessionId);
  }

  // FDRS-657 — the cloud verdict is EPHEMERAL: printed to the terminal below,
  // never persisted next to the trace. Local artifacts stay trace-only (no
  // score.json), and the verdict lives in the cloud (see the dashboard URL).
  const score = scoreFromFinalizeResponse(finalized);

  // Exit-code policy — DELIBERATE DIVERGENCE from hosted `pome run`
  // (FDRS-618): `pome run` maps the raw cloud score (score >= threshold →
  // 0), because pre-FDRS-618 cloud builds don't emit criteria_results and
  // the cloud exit decision is documented as score-only. `pome eval` is a
  // NEW command with no such compatibility surface, so it adopts the full
  // FDRS-591/611 A5 guard up front: exit 0 ONLY when the run was evaluated,
  // every criterion was judged (can_pass), AND the score clears the
  // threshold. An UNEVAL verdict (e.g. all criteria skipped) exits 1.
  const exitCode = scoreStatus(score, EVAL_PASS_THRESHOLD) === "pass" ? 0 : 1;

  return {
    taskName,
    agent,
    sessionId,
    reusedSession,
    cloudRunId: finalized.run_id,
    dashboardUrl: finalized.dashboard_url,
    score,
    exitCode,
  };
}

function durationMsFrom(meta: RunMeta): number {
  const started = meta.startedAt ? Date.parse(meta.startedAt) : Number.NaN;
  const completed = meta.completedAt ? Date.parse(meta.completedAt) : Number.NaN;
  const duration = completed - started;
  return Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : 0;
}

// ---------------------------------------------------------------------------
// CLI wrapper (printing + exit codes)
// ---------------------------------------------------------------------------

export interface EvalCommandOptions {
  artifactsDir: string;
  agent?: string;
  task?: string;
  apiUrl: string;
}

export async function runEvalCommand(
  runDirArg: string | undefined,
  opts: EvalCommandOptions,
): Promise<void> {
  try {
    let runDir: string;
    if (runDirArg) {
      runDir = resolve(runDirArg);
    } else {
      const latestPath = join(opts.artifactsDir, "latest.json");
      let latest: Awaited<ReturnType<typeof readLatestRun>>;
      try {
        latest = await readLatestRun(opts.artifactsDir);
      } catch (err) {
        // Corrupt latest.json is a usage problem (exit 5), not an orch one.
        throw new HostedUsageError(
          `pome eval: ${latestPath} is corrupt — not valid JSON (${err instanceof Error ? err.message : String(err)}).`,
        );
      }
      if (!latest || typeof latest.run_dir !== "string" || latest.run_dir.length === 0) {
        throw new HostedUsageError(
          `pome eval: no run directory given and ${latestPath} ${latest ? "has no run_dir field" : "not found"}. Pass a run directory (runs/<scenario>/<run-id>).`,
        );
      }
      runDir = resolve(latest.run_dir);
    }

    // Mirror `pome run`: bad-input paths surface as usage errors (exit 5)
    // BEFORE credential resolution, so a bad path never masquerades as an
    // auth problem.
    const stats = await stat(runDir).catch(() => null);
    if (!stats?.isDirectory()) {
      throw new HostedUsageError(
        `pome eval: run directory not found: ${runDir}`,
      );
    }

    const creds = await resolveCredentials({ apiBaseUrl: opts.apiUrl });
    const result = await runEval({
      runDir,
      agent: opts.agent,
      task: opts.task,
      hosted: { baseUrl: creds.apiBaseUrl, apiKey: creds.apiKey },
    });

    // Same verdict shape as hosted `pome run`: LABEL, score line, cloud URL.
    const status = scoreStatus(result.score, EVAL_PASS_THRESHOLD);
    const label =
      status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "UNEVAL";
    console.error(`${label} ${result.taskName}`);
    console.error(`  ${runScoreLine(result.score, EVAL_PASS_THRESHOLD, "cloud score")}`);
    if (result.score.results.length > 0) {
      console.error(`  criteria: ${scoreCountsSummary(result.score)}`);
      for (const criterionResult of result.score.results) {
        console.error(
          `  ${markerFor(outcomeOf(criterionResult))} [${criterionResult.criterion.type}] ${criterionResult.criterion.text}`,
        );
      }
    }
    if (result.reusedSession) {
      // Truthful in both cases: we can't observe whether /finalize took its
      // idempotent fast-path (stored run) or judged for the first time after
      // an earlier failed attempt on this session.
      console.error(
        "  note: reused the eval session recorded in eval-session.json — if this dir was already judged, this is the cloud's stored result.",
      );
    }
    console.error(`  cloud: ${result.dashboardUrl}`);
    process.exitCode = result.exitCode;
  } catch (err) {
    const code = exitCodeFor(err);
    console.error(err instanceof Error ? err.message : String(err));
    if (code === 3) {
      console.error(
        "Tip: `pome login` first — `pome eval` uploads the trace to Pome cloud for evaluation (ADR-013; there is no local scoring).",
      );
    } else if (
      err instanceof HostedOrchError &&
      (err.status === 404 || err.status === 405)
    ) {
      // The upgrade hint promised at the client layer (createEvalSession):
      // a 404/405 means this control plane predates `POST /v1/eval-sessions`
      // (FDRS-655) — the exact release-gate scenario where the endpoint is on
      // main but not yet deployed to prod. Point the user at the cause instead
      // of a bare "Not Found".
      console.error(
        "Tip: this control plane does not serve `POST /v1/eval-sessions` yet — the Pome cloud eval path (FDRS-655) is not deployed. Upgrade the control plane (or wait for the deploy). In the meantime, a hosted `pome run` still returns a cloud verdict.",
      );
    }
    process.exitCode = code;
  }
}
