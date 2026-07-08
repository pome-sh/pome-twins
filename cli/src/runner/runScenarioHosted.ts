// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runAgentCommand } from "./agentRunner.js";
import { toTwinHttpEvent, writeRunArtifactsCore } from "../recorder/artifacts.js";
import {
  VERDICT_ARTIFACT_VERSION,
  writeVerdictArtifact,
} from "../recorder/verdictArtifact.js";
import { redactEvent, redactSecrets } from "../recorder/redaction.js";
import { parseScenarioFile } from "../scenario/parseScenario.js";
import { createHostedClient, type HostedClient } from "../hosted/client.js";
import {
  redactJsonl,
  scoreFromFinalizeResponse,
  uploadRunBlobs,
} from "../hosted/uploadAndFinalize.js";
import {
  normalizeConfigAgentId,
  normalizeConfigAgentSdk,
  readProjectConfig,
} from "../cli/project-config.js";
import { HostedTrialError } from "../hosted/errors.js";
import type {
  CreateSessionResponse,
  CriterionDef,
  RecorderEvent,
} from "../types/shared.js";
import type { RecorderEvent as LegacyGithubRecorderEvent } from "@pome-sh/shared-types";
import type { Scenario } from "../scenario/scenarioSchema.js";
import type { Score } from "../score/view.js";
import type { RunArtifacts } from "../recorder/artifacts.js";

export interface RunScenarioHostedOptions {
  scenarioPath: string;
  agentCommand: string;
  artifactsDir?: string;
  hosted: { baseUrl: string; apiKey: string };
  /** For tests: inject a HostedClient. Otherwise constructed from `hosted`. */
  client?: HostedClient;
  /** Informational; passed through to `runs.agent_model`. Defaults to "unknown". */
  agentModel?: string;
  /** FDRS-636 — a session minted by the caller (trial groups mint all k
   *  upfront with one shared `group_id`). When set, the runner skips its own
   *  POST /v1/sessions and runs against this session; the `finally` teardown
   *  still DELETEs it (the trial owns its session either way). */
  premintedSession?: CreateSessionResponse;
  /** FDRS-636 — group-trial failure semantics. When true, an agent failure
   *  (preflight failure / timeout / non-zero exit) or a machinery crash
   *  ABANDONS the session (POST /:id/abandon with a machine error_code,
   *  landing BEFORE the teardown DELETE so the code is recorded while the
   *  row is still open) and throws HostedTrialError INSTEAD of finalizing —
   *  an errored trial must never produce a judged run row. Default false:
   *  today's single-run behavior (finalize even on agent timeout) is
   *  unchanged. */
  abandonOnFailure?: boolean;
  /** FDRS-644 — the trial group's shared id, recorded into the trial's
   *  verdict.json so `pome fix-prompt` can reassemble the run set from
   *  local artifacts. Absent on single runs (verdict.json gets null). */
  groupId?: string;
}

export interface RunScenarioHostedResult {
  scenario: Scenario;
  runId: string; // local artifacts dir id (= session_id)
  cloudRunId: string;
  cloudDashboardUrl: string;
  artifacts: RunArtifacts;
  score: Score;
  exitCode: number;
  /** Wall time from run start to post-agent state capture — the same value
   *  reported to /finalize as duration_ms. FDRS-636 renders it as the trial
   *  row's duration. */
  durationMs: number;
}

export async function runScenarioHosted(
  options: RunScenarioHostedOptions
): Promise<RunScenarioHostedResult> {
  const scenario = await parseScenarioFile(options.scenarioPath);
  const scenarioSource = await readFile(options.scenarioPath, "utf8");
  const scenarioHash = createHash("sha256").update(scenarioSource).digest("hex");
  const artifactsDir = options.artifactsDir ?? "runs";
  const startedAt = new Date().toISOString();

  const client =
    options.client ??
    createHostedClient({ baseUrl: options.hosted.baseUrl, apiKey: options.hosted.apiKey });

  // ADR-013 — resolve agentId + agent.sdk from pome.config.json. Hosted runs
  // are grouped under the agent the user registered with `pome register
  // agent`. `agent.sdk` is a free-form string ("claude-agent-sdk",
  // "openai-agents", "openclaw", "hermes", "custom") that the dashboard
  // surfaces as a badge on every run. Both are optional during rollout.
  let agentId: string | undefined;
  let agentSdk: string | null = null;
  const configRead = await readProjectConfig(dirname(options.scenarioPath));
  if (configRead) {
    agentId = normalizeConfigAgentId(configRead.config);
    agentSdk = normalizeConfigAgentSdk(configRead.config);
  }

  // Per-run signals file. POME_ADAPTER_SIGNALS_PATH is injected into the agent
  // env so adapter-rich correlator gets step/tool_call signals when the agent
  // emits them; otherwise the heuristic correlator path runs over events alone.
  const signalsDir = await mkdtemp(join(tmpdir(), "pome-signals-"));
  const signalsPath = join(signalsDir, `${randomUUID()}.jsonl`);
  // Touch the file so adapters that `appendFileSync` to it on first signal
  // don't race the read in the empty case.
  await writeFile(signalsPath, "");

  // 1. Spawn cloud session — fails fast on auth/quota/orch. FDRS-636 trial
  // groups mint all k sessions upfront (one shared group_id) and pass each
  // one in as `premintedSession`; the single-run path mints its own here.
  // Forward the resolved seed (sidecar -> inline JSON -> twin defaults, in that
  // precedence; see parseScenario.resolveSeedState) so the cloud doesn't need
  // to re-extract it from the markdown. Prose `## Seed State` sections have no
  // fenced JSON to extract — cloud would 422 with "no fenced code block".
  const session =
    options.premintedSession ??
    (await client.createSession({
      scenarioSource,
      twins: scenario.config.twins,
      agentId,
      seed: scenario.seedState,
    }));

  // Use session_id as the local artifact-dir id. The cloud's run_id (assigned
  // at /result time) is reported separately to the caller.
  const runId = session.session_id;

  try {
    // 2. Capture initial twin state via bearer-protected /_pome/state.
    const stateInitial = await client.fetchState({
      twinUrl: session.twin_url,
      agentToken: session.agent_token,
    });

    // Agent telemetry → pome-cloud. The agent runs as a LOCAL subprocess even on
    // hosted runs, and its LLM calls happen inside the SDK (they never traverse
    // pome's capture-server proxy), so the agent emits its OWN `gen_ai` OTLP
    // spans (via @pome-sh/adapter-claude-sdk). They post to the SESSION-SCOPED
    // traces endpoint, which ingests them into THIS sim session's
    // `otlp-spans.jsonl` blob; finalize rolls them up onto the run for the
    // dashboard's "Agent telemetry" panel. Wire contract (sim-traces.ts):
    //   - OTLP/HTTP JSON only (the adapter exporter is http/json).
    //   - Auth: the team API key via `X-API-KEY`. sim-traces documents a
    //     preferred `Bearer <agent_token>` path too, but every /v1/sessions
    //     sub-router shares a `use("*", requireApiKey)` middleware that runs
    //     before sim-traces' own auth and rejects a JWT bearer — so the
    //     team-key fallback is the path that actually reaches ingest. The key
    //     is the caller's own and the agent runs locally, so this is the same
    //     trust boundary as POME_GITHUB_TOKEN below.
    // POME_OTEL_EXPORTER_OTLP_ENDPOINT / _HEADERS are the pome-namespaced env the
    // bundled adapter reads; with no endpoint the adapter emission is inert.
    // POME_OTEL_COLLECTOR_URL fully overrides the endpoint for non-standard deploys.
    const otlpEndpoint =
      process.env.POME_OTEL_COLLECTOR_URL?.trim() ||
      new URL(
        `/v1/sessions/${session.session_id}/traces`,
        options.hosted.baseUrl,
      ).toString();

    // 3. Run the agent. Env mirrors self-host so a customer's agent code
    //    is twin-mode-agnostic.
    const env = {
      POME_TASK: scenario.prompt,
      POME_TWIN_NAMES: scenario.config.twins.join(","),
      POME_OTEL_EXPORTER_OTLP_ENDPOINT: otlpEndpoint,
      POME_OTEL_EXPORTER_OTLP_HEADERS: `x-api-key=${options.hosted.apiKey}`,
      OTEL_SERVICE_NAME: agentId ?? "pome-agent",
      OTEL_RESOURCE_ATTRIBUTES: `pome.session_id=${session.session_id},pome.run_id=${runId}${
        agentId ? `,pome.agent_id=${agentId}` : ""
      }`,
      // FDRS-667 — the twin base URL, same value the self-host docs teach
      // agents to fall back on. Agent code written against the standalone
      // docker twin reads POME_TWIN_BASE_URL with a 127.0.0.1:3333 fallback;
      // without this injection that fallback fires on hosted runs and the
      // agent probes a loopback port nothing listens on.
      POME_TWIN_BASE_URL: session.twin_url,
      POME_GITHUB_REST_URL: session.twin_url,
      POME_GITHUB_MCP_URL: `${session.twin_url}/mcp`,
      POME_GITHUB_TOKEN: session.provider_credentials.github?.token ?? session.agent_token,
      POME_STRIPE_API_BASE: session.twin_url,
      // Always use the JWT agent_token as the Stripe SDK's Bearer in
      // hosted mode (FDRS-369). The cloud also returns
      // `provider_credentials.stripe.api_key` (an HMAC-signed
      // `sk_test_pome_*`), but the pome-cloud proxy at
      // `/s/:sid/*` only accepts JWTs — it routes by verifying the
      // bearer against `agent_token`. A stripe-style key short-circuits
      // to the proxy's opaque 404 before the request ever reaches the
      // twin pod. The Stripe SDK is happy to send any opaque string as
      // `Authorization: Bearer …`, and twin-stripe's dual-auth accepts
      // JWTs natively, so the JWT round-trips cleanly end-to-end.
      POME_STRIPE_API_KEY: session.agent_token,
      POME_AUTH_TOKEN: session.agent_token,
      POME_RUN_ID: runId,
      POME_ARTIFACTS_DIR: join(artifactsDir, scenario.slug, runId),
      POME_ADAPTER_SIGNALS_PATH: signalsPath,
    };

    const preflightTimeoutSeconds = Math.min(10, scenario.config.timeout);
    const preflight = await runAgentCommand({
      command: options.agentCommand,
      env,
      timeoutSeconds: preflightTimeoutSeconds,
      preflight: true,
    });

    let agentResult = preflight;
    if (preflight.exitCode === 0) {
      agentResult = await runAgentCommand({
        command: options.agentCommand,
        env,
        timeoutSeconds: scenario.config.timeout,
      });
    }

    // FDRS-636 — group-trial failure semantics. An agent failure on a group
    // trial ABANDONS the session with a machine error_code and throws,
    // instead of finalizing: verdicts come from cloud evaluation only, and a
    // crashed/timed-out trial must render as an errored row EXCLUDED from
    // the fraction — never as a judged score over a garbage trace. Default
    // (single-run) behavior below is untouched: it still finalizes so the
    // run is visible on the dashboard.
    if (
      options.abandonOnFailure &&
      (agentResult.timedOut || agentResult.exitCode !== 0)
    ) {
      // Classify PREFLIGHT failures first: when the preflight never passed
      // (non-zero exit OR killed at its own min(10, timeout)s cap), the real
      // run never happened, so the code is preflight_failed — and a hung
      // preflight quotes the cap that actually killed it, never the full
      // scenario timeout. Only a real-run failure classifies as
      // agent_timeout / agent_exit_nonzero.
      //
      // FDRS-667 — name the cause. The errored trial row renders the reason
      // verbatim, so a bare "agent preflight failed" leaves the user with
      // zero forensics (the k=5 first-publish e2e died five times on the
      // same swallowed stderr). Append the agent's last stderr line to the
      // exit-shaped failures; timeouts already name what killed them.
      const failed = preflight.exitCode !== 0 ? preflight : agentResult;
      const cause = stderrTail(failed.stderr);
      const failure =
        preflight.exitCode !== 0
          ? {
              errorCode: "preflight_failed",
              reason: preflight.timedOut
                ? `agent preflight timed out after ${preflightTimeoutSeconds}s`
                : `agent preflight failed${cause ? ` — ${cause}` : ""}`,
            }
          : agentResult.timedOut
            ? {
                errorCode: "agent_timeout",
                reason: `agent timed out after ${scenario.config.timeout}s`,
              }
            : {
                errorCode: "agent_exit_nonzero",
                reason: `agent exited non-zero (exit ${agentResult.exitCode})${cause ? ` — ${cause}` : ""}`,
              };
      // FDRS-667 — an abandoned trial never reaches the artifact write in
      // step 5, so land the agent's output where a completed trial's would
      // go (runs/<slug>/<session>/): stdout.txt + stderr.log, redacted like
      // writeRunArtifactsCore's copies. Best effort — forensics must never
      // mask the trial's own error.
      try {
        const runDir = join(artifactsDir, scenario.slug, runId);
        await mkdir(runDir, { recursive: true });
        await writeFile(join(runDir, "stdout.txt"), redactSecrets(failed.stdout) as string);
        await writeFile(join(runDir, "stderr.log"), redactSecrets(failed.stderr) as string);
      } catch {
        // ignore — the thrown HostedTrialError below is the signal that matters
      }
      await abandonBestEffort(client, session.session_id, failure.errorCode);
      throw new HostedTrialError(failure.reason, failure.errorCode);
    }

    // 4. Capture final state + recorder events. Run in parallel for
    //    latency. If either rejects (e.g., twin pod restarted between
    //    preflight and now), the run fails before finalize fires —
    //    the cloud has no record. Recovery is "user reruns"; V1 doesn't
    //    retry transient twin failures.
    const [stateFinal, eventsRaw] = await Promise.all([
      client.fetchState({ twinUrl: session.twin_url, agentToken: session.agent_token }),
      client.fetchEvents({ twinUrl: session.twin_url, agentToken: session.agent_token }),
    ]);
    const events = eventsRaw as RecorderEvent[];
    // artifacts.ts still types `events` as the legacy twin/github RecorderEvent
    // (no step_id / tool_call_id / state_delta fields). Runtime data is the
    // same shape — cast to keep writeRunArtifactsCore happy without churning
    // that signature here.
    const legacyEvents = events as unknown as LegacyGithubRecorderEvent[];

    // 5. Write local artifacts — RAW TRACE + state. ADR-013 / FDRS-657:
    //    the OSS CLI never scores locally (no score.json is ever written).
    //    Cloud is the authoritative judge; what /finalize returns is printed
    //    to the terminal and — since FDRS-644 — also cached next to the
    //    trace as a provenance-labeled verdict.json (step 11) so
    //    `pome fix-prompt` can read the cloud's verdict offline.
    const completedAt = new Date().toISOString();
    const durationMs = Date.parse(completedAt) - Date.parse(startedAt);
    const artifacts = await writeRunArtifactsCore({
      artifactsDir,
      runId,
      scenario,
      startedAt,
      completedAt,
      stdout: agentResult.stdout,
      stderr: agentResult.stderr,
      exitCode: agentResult.exitCode,
      events: legacyEvents,
      stateInitial,
      stateFinal,
    });

    // 6. FDRS-657 — NO local correlation. Correlation (like scoring/judging)
    //    is a cloud responsibility; the OSS CLI only captures the raw trace.
    //    Cloud correlates the uploaded events/signals server-side. The events
    //    are uploaded exactly as captured (no local step_id back-fill).

    // 7. Upload events.jsonl + state blobs + adapter signals.jsonl to cloud
    //    storage in parallel. /finalize defaults the trace storage key to
    //    the conventional `team-<>/session-<>/events.jsonl` path, so cloud's
    //    judge finds the trace without an explicit override. State blobs
    //    and signals have no conventional fallback today — without an
    //    explicit override the judge sees "{}" for state files (FDRS-395)
    //    and skips the adapter-rich correlator (F0-4 / L7). All four
    //    uploads are best-effort: any failure leaves the corresponding
    //    blob missing, the judge still runs against whatever it does have,
    //    and the dashboard handles nulls gracefully.
    // Wrap legacy RecorderEvents (no `kind` discriminator) into the unified
    // FDRS-398 shape before upload — cloud's schema gate rejects raw legacy
    // rows. Matches the wrap that `writeRunArtifactsCore` applies for the
    // local events.jsonl file. Use `legacyEvents` (already cast) because
    // `toTwinHttpEvent`'s input is the legacy twin/github RecorderEvent type.
    const eventsJsonl =
      legacyEvents.map((e) => JSON.stringify(redactEvent(toTwinHttpEvent(e)))).join("\n") + "\n";
    const stateInitialJson = JSON.stringify(redactSecrets(stateInitial));
    const stateFinalJson = JSON.stringify(redactSecrets(stateFinal));

    // Upload orchestration lives in ../hosted/uploadAndFinalize.ts (FDRS-656)
    // so `pome eval` shares the exact best-effort semantics. Signals are
    // read + redacted here (the tmp file is runner-owned); empty payloads
    // skip the upload inside uploadRunBlobs. Read + redaction stay inside a
    // guard so a redaction failure degrades to "signals skipped" — the
    // pre-extraction contract — instead of aborting the whole hosted run.
    let signalsJsonl = "";
    try {
      signalsJsonl = redactJsonl(
        await readFile(signalsPath, "utf8").catch(() => ""),
      );
    } catch (err) {
      console.warn(
        `[pome] signals.jsonl upload skipped (${
          err instanceof Error ? err.message : String(err)
        }); continuing with signals_storage_key=null`,
      );
    }
    const uploaded = await uploadRunBlobs(client, session.session_id, {
      eventsJsonl,
      stateInitialJson,
      stateFinalJson,
      signalsJsonl,
    });
    const eventsJsonlUrl = uploaded.eventsKey;
    const stateKeys = {
      initialKey: uploaded.stateInitialKey,
      finalKey: uploaded.stateFinalKey,
    };
    const signalsKey = uploaded.signalsKey;

    // 8. Finalize the run on cloud (ADR-013). Cloud loads the trace from
    //    storage, calls the managed judge via AI Gateway, persists the run
    //    row, and returns the authoritative score the dashboard records.
    //    The CLI prints this score on the `score:` line.
    // `CriterionDef.kind` on the finalize request is still the legacy `D`/`P`
    // wire vocabulary; map the canonical `code`/`model` kind back for the wire.
    const criteriaDefs: CriterionDef[] = scenario.criteria.map((c, idx) => ({
      id: `crit_${idx}`,
      text: c.text,
      kind: c.type === "code" ? "D" : "P",
    }));
    const stopReason = agentResult.timedOut
      ? "agent_timeout"
      : agentResult.exitCode === 0
        ? "agent_exit_0"
        : "agent_exit_nonzero";
    const finalized = await client.finalize(session.session_id, {
      stopReason,
      exitCode: agentResult.exitCode ?? 0,
      durationMs,
      agentModel: options.agentModel ?? "unknown",
      agentSdk,
      criteria: criteriaDefs,
      scenarioName: scenario.slug,
      scenarioHash,
      scenarioPrompt: scenario.prompt,
      expectedBehavior: scenario.expectedBehavior,
      // Explicit overrides when uploads succeeded; otherwise let cloud fall
      // back. For events.jsonl the conventional `team-<>/session-<>/events.jsonl`
      // path matches what /result-upload-url signs, so omitting traceStorageKey
      // still resolves correctly. For state blobs there is no conventional
      // fallback today (FDRS-395) — omitting them means cloud's judge sees
      // "{}", which we accept as best-effort degradation.
      traceStorageKey: eventsJsonlUrl ?? undefined,
      stateInitialStorageKey: stateKeys.initialKey ?? undefined,
      stateFinalStorageKey: stateKeys.finalKey ?? undefined,
      signalsStorageKey: signalsKey ?? undefined,
    });

    // 9. Synthesize the cloud verdict for terminal display + the exit code.
    //    FDRS-657: the CLI never computes a verdict — this is the CLOUD's,
    //    reshaped. Synthesis (incl. the F0-3 / L5 criteria_results handling
    //    and the A1/FDRS-618 caveat) lives in scoreFromFinalizeResponse —
    //    shared with `pome eval` (FDRS-656). Step 11 caches it to
    //    verdict.json (FDRS-644); score.json stays never-written.
    const score: Score = scoreFromFinalizeResponse(finalized);

    // 10. Map cloud score → exit code. F18 / F0-5: the old policy
    //     ("agent failure trumps a passing score") collapsed an agent
    //     non-zero exit AND an agent timeout to exit 3 ("auth error"),
    //     which is wrong on two counts — it stole the auth-error slot
    //     and it overrode the cloud judge's authoritative verdict on
    //     sub-threshold runs (the F18 reproducer was a 50/100 hosted run
    //     where the agent had an unhandled rejection; the test plan
    //     expected exit 1).
    //
    //     Once /finalize has returned, the judge has seen the trace and
    //     produced an authoritative score; the score is canonical. Use
    //     the documented threshold logic: pass → 0, sub-threshold → 1.
    //     Pre-finalize agent failures (auth, quota, twin spawn, exec
    //     errors) take other code paths via thrown HostedAuthError /
    //     HostedQuotaError / HostedOrchError and never reach this line.
    const exitCode =
      finalized.score >= scenario.config.passThreshold ? 0 : 1;

    // 11. FDRS-644 — cache the CLOUD verdict payload next to the raw trace
    //     (verdict.json, provenance-labeled `source: "cloud-finalize"`).
    //     Not a local score: evaluation stayed in the cloud; this records
    //     what /finalize returned so `pome fix-prompt` can hand grouped
    //     failure signatures to the user's coding agent offline. Best
    //     effort: a disk failure degrades to "fix-prompt won't see this
    //     trial", never fails a finalized run.
    try {
      await writeVerdictArtifact(artifacts.runDir, {
        version: VERDICT_ARTIFACT_VERSION,
        source: "cloud-finalize",
        task_name: scenario.slug,
        scenario_path: options.scenarioPath,
        group_id: options.groupId ?? null,
        session_id: session.session_id,
        cloud_run_id: finalized.run_id,
        cloud_dashboard_url: finalized.dashboard_url,
        judge_model: score.judge_model,
        score: finalized.score,
        pass_threshold: scenario.config.passThreshold,
        passed: exitCode === 0,
        criteria_results: score.results,
        duration_ms: durationMs,
        finalized_at: new Date().toISOString(),
      });
    } catch (err) {
      console.warn(
        `[pome] verdict.json not written (${
          err instanceof Error ? err.message : String(err)
        }); pome fix-prompt won't see this trial`,
      );
    }

    return {
      scenario,
      runId,
      cloudRunId: finalized.run_id,
      cloudDashboardUrl: finalized.dashboard_url,
      artifacts,
      score,
      exitCode,
      durationMs,
    };
  } catch (err) {
    // FDRS-636 — a machinery crash on a group trial (twin state fetch,
    // upload orchestration, finalize itself) also abandons the session so
    // the reliability page shows an errored slot with a cause instead of a
    // session stuck open until the sweeper. Must run BEFORE the `finally`
    // DELETE below: abandon only transitions OPEN sessions, and error_code
    // is lost once the row is terminal. Agent failures threw
    // HostedTrialError above and already abandoned with a sharper code.
    if (options.abandonOnFailure && !(err instanceof HostedTrialError)) {
      await abandonBestEffort(client, session.session_id, "trial_crashed");
    }
    throw err;
  } finally {
    // Best-effort teardown. TTL would reap anyway; explicit delete keeps
    // the dashboard sessions list tidy.
    await client.deleteSession(session.session_id).catch(() => undefined);
    await rm(signalsDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** FDRS-667 — the last non-empty stderr line, flattened and bounded, as the
 *  one named cause an errored trial row can render inline. Redacted with the
 *  same rules as the on-disk stderr.log copy. */
function stderrTail(stderr: string): string | null {
  const last = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!last) return null;
  const flat = (redactSecrets(last.replace(/\s+/g, " ")) as string).trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat;
}

/** Abandon is a bookkeeping signal — a failure to deliver it must never
 *  mask the trial's own error. */
async function abandonBestEffort(
  client: HostedClient,
  sessionId: string,
  errorCode: string,
): Promise<void> {
  try {
    await client.abandonSession(sessionId, { errorCode });
  } catch (err) {
    console.warn(
      `[pome] session abandon skipped (${
        err instanceof Error ? err.message : String(err)
      }); the expiry sweeper will close ${sessionId}`,
    );
  }
}
