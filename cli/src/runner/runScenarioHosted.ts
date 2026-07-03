// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runAgentCommand } from "./agentRunner.js";
import { toTwinHttpEvent, writeRunArtifactsCore } from "../recorder/artifacts.js";
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
import type { CriterionDef, RecorderEvent } from "../types/shared.js";
import type { RecorderEvent as LegacyGithubRecorderEvent } from "../twin/github/types.js";
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
}

export interface RunScenarioHostedResult {
  scenario: Scenario;
  runId: string; // local artifacts dir id (= session_id)
  cloudRunId: string;
  cloudDashboardUrl: string;
  artifacts: RunArtifacts;
  score: Score;
  exitCode: number;
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

  // 1. Spawn cloud session — fails fast on auth/quota/orch.
  // Forward the resolved seed (sidecar -> inline JSON -> twin defaults, in that
  // precedence; see parseScenario.resolveSeedState) so the cloud doesn't need
  // to re-extract it from the markdown. Prose `## Seed State` sections have no
  // fenced JSON to extract — cloud would 422 with "no fenced code block".
  const session = await client.createSession({
    scenarioSource,
    twins: scenario.config.twins,
    agentId,
    seed: scenario.seedState,
  });

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

    const preflight = await runAgentCommand({
      command: options.agentCommand,
      env,
      timeoutSeconds: Math.min(10, scenario.config.timeout),
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

    // 5. Write local artifacts — RAW TRACE + state only. ADR-013 / FDRS-657:
    //    the OSS CLI never scores locally, and local artifacts stay trace/audit
    //    only (no score.json is ever written). Cloud is the authoritative
    //    judge; the verdict from /finalize is printed to the terminal and
    //    recorded to the dashboard, never persisted next to the trace.
    const completedAt = new Date().toISOString();
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
    const criteriaDefs: CriterionDef[] = scenario.criteria.map((c, idx) => ({
      id: `crit_${idx}`,
      text: c.text,
      kind: c.type,
    }));
    const stopReason = agentResult.timedOut
      ? "agent_timeout"
      : agentResult.exitCode === 0
        ? "agent_exit_0"
        : "agent_exit_nonzero";
    const finalized = await client.finalize(session.session_id, {
      stopReason,
      exitCode: agentResult.exitCode ?? 0,
      durationMs: Date.parse(completedAt) - Date.parse(startedAt),
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

    // 9. Synthesize the cloud verdict for EPHEMERAL terminal display + the
    //    exit code. FDRS-657: local artifacts stay trace-only — the verdict is
    //    NOT persisted (no score.json). It lives in the cloud; the CLI prints
    //    it and points at the dashboard. Synthesis (incl. the F0-3 / L5
    //    criteria_results handling and the A1/FDRS-618 caveat) lives in
    //    scoreFromFinalizeResponse — shared with `pome eval` (FDRS-656).
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

    return {
      scenario,
      runId,
      cloudRunId: finalized.run_id,
      cloudDashboardUrl: finalized.dashboard_url,
      artifacts,
      score,
      exitCode,
    };
  } finally {
    // Best-effort teardown. TTL would reap anyway; explicit delete keeps
    // the dashboard sessions list tidy.
    await client.deleteSession(session.session_id).catch(() => undefined);
    await rm(signalsDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
