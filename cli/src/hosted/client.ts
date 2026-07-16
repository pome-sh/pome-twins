// SPDX-License-Identifier: Apache-2.0
import {
  createEvalSessionResponseSchema,
  type CreateEvalSessionResponse,
  createSessionResponseSchema,
  type CreateSessionResponse,
  criterionDefSchema,
  finalizeResponseSchema,
  type FinalizeResponse,
  sessionPublicSchema,
  type SessionPublic,
  submitResultResponseSchema,
  type SubmitResultResponse,
  type CriterionResult,
  type Lane,
  type PerTwinStateKeys,
  type Step,
} from "../types/shared.js";
import { z } from "zod";
import {
  HostedAuthError,
  HostedOrchError,
  HostedQuotaError,
} from "./errors.js";

// Writer-side shape of the finalize criteria (see FinalizeInput.criteria).
// Derived with z.input so it tracks whatever the installed contract accepts
// as INPUT rather than its parsed output.
export type CriterionDefWire = z.input<typeof criterionDefSchema>;

// Multi-twin (M3): provenance marker for `per_twin`. A single-twin OLD cloud
// ships NO `per_twin` key; `createSessionResponseSchema` then SYNTHESIZES one
// (host-rewrites api.pome.sh→mcp.pome.sh with no `/mcp` suffix). Consumers that
// build agent env from `per_twin[twin].mcp_url` must NOT trust that synthesized
// value — it would drift POME_*_MCP_URL off origin/main's `${twin_url}/mcp`. We
// record, on the parsed object as a NON-ENUMERABLE symbol (never serialized,
// never spread), whether the raw wire body actually carried a `per_twin` key.
const PER_TWIN_PROVENANCE = Symbol("pome.perTwinFromCloud");

function markPerTwinProvenance(
  session: CreateSessionResponse,
  fromCloud: boolean,
): CreateSessionResponse {
  Object.defineProperty(session, PER_TWIN_PROVENANCE, {
    value: fromCloud,
    enumerable: false,
    configurable: true,
  });
  return session;
}

/** True when the cloud's create-session body actually returned a `per_twin`
 *  key (empty `{}` counts) — i.e. `per_twin` was NOT synthesized by the schema
 *  from a legacy `twin_url`-only response. Consumers use this to decide whether
 *  `per_twin[twin].mcp_url` is trustworthy. */
export function perTwinReturnedByCloud(session: CreateSessionResponse): boolean {
  return (
    (session as Record<PropertyKey, unknown>)[PER_TWIN_PROVENANCE] === true
  );
}

/** Whether a raw create-session wire body carried a usable `per_twin` map
 *  (before schema synthesis). A `per_twin: null` counts as absent — the schema
 *  would synthesize entries for it, and synthesized URLs must not be trusted.
 *  Exported so the runner's env unit test can model the exact provenance the
 *  client stamps. */
export function rawBodyHadPerTwin(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const pt = (raw as { per_twin?: unknown }).per_twin;
  return typeof pt === "object" && pt !== null;
}

export interface HostedClientConfig {
  baseUrl: string;
  /** Team API key (`pme_…`) — or, with `authScheme: "bearer"`, a
   *  session-scoped JWT (demo_token / agent_token). */
  apiKey: string;
  /** Per-request timeout. Defaults to 30s; the cloud's own twin spawn is
   *  ~2s cold but we leave headroom for GHCR pulls.  */
  timeoutMs?: number;
  /** Overall time allowed for finalize request + asynchronous polling to
   * reach a terminal state. Defaults to five minutes. */
  finalizeTimeoutMs?: number;
  /** Initial async-finalize polling delay. Defaults to 500ms. */
  finalizePollInitialDelayMs?: number;
  /** Maximum async-finalize polling delay. Defaults to 5s. */
  finalizePollMaxDelayMs?: number;
  /** FDRS-643 — how the credential travels. "x-api-key" (default) is the
   *  team-key contract. "bearer" sends `Authorization: Bearer <apiKey>` for
   *  the session-token surface (upload-url/finalize accept a sid-scoped JWT
   *  via requireApiKeyOrSessionToken; `pome demo` authenticates each trial's
   *  uploads with its demo_token this way). */
  authScheme?: "x-api-key" | "bearer";
}

export interface CreateSessionInput {
  scenarioSource: string;
  twins: string[];
  /** Omit for one-off sessions; reuse only when intentionally replaying a create after network uncertainty. */
  idempotencyKey?: string;
  /** Agents-as-first-class-entity (ADR-013). Resolved from pome.config.json's
   *  `agentId` by callers. Server validates `agent.team_id === apiKey.team_id`
   *  and `requested_twins ⊆ agent_enabled_services`. Optional during rollout;
   *  will become required once the dashboard / control-plane catch up. */
  agentId?: string;
  /** Pre-resolved seed JSON. When supplied, cloud uses it directly and skips
   *  extracting JSON from the scenario markdown — required for the post-2026-05-22
   *  prose `## Seed State` shape, where the markdown has no fenced JSON block. */
  seed?: unknown;
  /** FDRS-636 — trial-group identity (`grp_` + nanoid21). `pome run -n k`
   *  (k>1) stamps ONE shared id on every mint of the invocation; the cloud
   *  copies it onto `sessions.group_id` at mint and `runs.group_id` at
   *  finalize, and the reliability page reads the group by it.
   *  shared-types 0.6.0 adds the field server-side; an older cloud silently
   *  strips it, so sending it is always safe. NEVER set for k=1 — a group
   *  of 1 would flip the reliability page off its implicit latest-k
   *  fallback. */
  groupId?: string;
}

/** FDRS-636 — POST /v1/sessions/:id/abandon response. `abandoned: false`
 *  means the session was already terminal and nothing was rewritten (the
 *  idempotent no-op branch); `state` echoes the row's current state. */
export interface AbandonSessionResponse {
  session_id: string;
  state: string;
  error_code: string | null;
  abandoned: boolean;
}

// FDRS-655/656 — `pome eval <run-dir>` capture/eval split. The cloud mints
// a twin-less "eval session" scoped to an agent + task name; the existing
// upload-url routes and /finalize then work unchanged on that session.
export interface CreateEvalSessionInput {
  /** Agent identity — the slug written by `pome register agent` (or the
   *  agt_ id / `--agent` override). Server resolves it under the API key's
   *  team. */
  agent: string;
  /** Human-meaningful task label, e.g. the run's scenario slug. */
  taskName: string;
}

export interface FetchOnTwinInput {
  twinUrl: string;
  agentToken: string;
}

export interface SubmitResultInput {
  scenarioName: string;
  scenarioHash: string;
  durationMs: number;
  agentModel: string;
  satisfactionScore: number;
  criteriaResults: CriterionResult[];
  judgeModel: string;
  judgeTokensIn: number | null;
  judgeTokensOut: number | null;
  // Free-form SDK / framework label persisted to runs.agent_sdk (pome-cloud
  // ADR-013). CLI reads it from `pome.config.json` { agent: { sdk: "..." } };
  // common values: "claude-agent-sdk", "openai-agents", "openclaw", "hermes",
  // "custom". Omit / null when the user has not declared it — control-plane
  // accepts both shapes.
  agentSdk?: string | null;
  // Correlator output (FDRS-326). Empty arrays when no adapter signals were
  // captured AND the heuristic correlator is unavailable.
  lanes: Lane[];
  steps: Step[];
  // Wire field for a CLI-supplied fix prompt (FDRS-323). FDRS-657: the OSS CLI
  // is capture-only and never generates one CLI-side, so runners always submit
  // `null` here — the cloud owns the managed judge/fix-prompt handoff. Kept on
  // the finalize contract for compatibility.
  fixPrompt: string | null;
  // FDRS-357: storage key returned by requestEventsUploadUrl, or null if the
  // upload was skipped / failed. Cloud persists this into runs.events_jsonl_url.
  eventsJsonlUrl: string | null;
  traceJsonl: string;
  stateInitialJson: string;
  stateFinalJson: string;
}

export interface EventsUploadUrlResponse {
  url: string;
  key: string;
}

export interface StateUploadUrlEntry {
  url: string;
  key: string;
}

export interface StateUploadUrlPair {
  state_initial: StateUploadUrlEntry;
  state_final: StateUploadUrlEntry;
}

export interface StateUploadUrlResponse {
  state_initial: StateUploadUrlEntry;
  state_final: StateUploadUrlEntry;
  /** Multi-twin (M3): one initial/final URL+key pair per twin, keyed by twin
   *  id. Absent on single-twin sessions and on an older cloud, where the
   *  top-level pair (= primary twin) is authoritative. */
  per_twin?: Record<string, StateUploadUrlPair>;
}

export interface SignalsUploadUrlResponse {
  url: string;
  key: string;
}

// D18.1 — mint a signed PUT for meta.json (spec_version + twin package
// versions). FEATURE-DETECT: `POST /v1/sessions/:id/meta-upload-url` ships in
// a parallel pome-cloud PR; a control plane that predates it 404s here, and
// the upload orchestration in uploadAndFinalize.ts treats that exactly like
// every other best-effort blob upload — warn and continue with key=null.
export interface MetaUploadUrlResponse {
  url: string;
  key: string;
}

export interface FinalizeInput {
  /** "completed" | "timeout" | "preflight_failed" — free-form for now. */
  stopReason: string;
  exitCode: number;
  durationMs: number;
  agentModel: string;
  agentSdk?: string | null;
  // Criterion *definitions* (not results). Cloud judges these against the
  // recorded trace/state and returns the authoritative score. Writer-side
  // input type (z.input, not z.infer): the CLI may send legacy "D"/"P" kinds
  // during the F-778 compat window; cloud normalizes to "code"/"model" on
  // parse. z.input keeps this compiling against both the published 0.9.x
  // contract (D/P only) and the tolerant 0.10.0 reader.
  criteria: CriterionDefWire[];
  scenarioName: string;
  scenarioHash: string;
  scenarioPrompt: string;
  expectedBehavior: string;
  // Optional storage-key overrides. When omitted, cloud loads from the
  // conventional `team-<>/session-<>/<filename>` paths populated by the
  // corresponding upload-url endpoints (events.jsonl via
  // `requestEventsUploadUrl`; state_{initial,final}.json via
  // `requestStateUploadUrl`). When an override is supplied, cloud loads
  // from that key instead. Best-effort: missing state blobs cause the judge
  // to substitute "{}" rather than failing the run.
  traceStorageKey?: string;
  stateInitialStorageKey?: string;
  stateFinalStorageKey?: string;
  // F0-4 / L7 — when set, cloud's finalize-run switches the correlator to
  // `correlateTraceJsonlWithSignals` so adapter-emitted HookEvent /
  // ToolUseEvent / ToolResultEvent / SubagentSpawnEvent / LlmTurnEvent rows
  // correlate into lanes/steps alongside the twin-HTTP timeline. The CLI
  // uploads signals.jsonl via `requestSignalsUploadUrl` first; the returned
  // storage key flows here.
  signalsStorageKey?: string;
  // Multi-twin (M3): per-twin state storage keys, keyed by twin id. Sent only
  // for multi-twin sessions; each entry carries at least one of
  // state_initial_key / state_final_key. Omitted on single-twin runs, which
  // use the flat state_*StorageKey fields above. An older cloud strips it and
  // scores the primary twin unchanged.
  perTwinStateKeys?: PerTwinStateKeys;
}

export interface FinalizeOptions {
  /** Cancels the finalize POST, any status request, or a pending poll delay. */
  signal?: AbortSignal;
}

export interface HostedClient {
  createSession(input: CreateSessionInput): Promise<CreateSessionResponse>;
  /** FDRS-655/656 — POST /v1/eval-sessions. Mints a twin-less session for
   *  uploading + finalizing an EXISTING raw trace directory (`pome eval`).
   *  Requires a control plane that ships the FDRS-655 route. */
  createEvalSession(
    input: CreateEvalSessionInput,
  ): Promise<CreateEvalSessionResponse>;
  listSessions(opts?: { limit?: number }): Promise<SessionPublic[]>;
  getSession(sessionId: string): Promise<SessionPublic>;
  fetchState(input: FetchOnTwinInput): Promise<unknown>;
  fetchEvents(input: FetchOnTwinInput): Promise<unknown[]>;
  /** ADR-013 — authoritative run finalize. Cloud judges and returns the score. */
  finalize(
    sessionId: string,
    input: FinalizeInput,
    options?: FinalizeOptions,
  ): Promise<FinalizeResponse>;
  /**
   * @deprecated Use `finalize` instead. `/v1/sessions/:id/result` is a shim
   * kept for ≥1 OSS CLI release per ADR-013; cloud ignores the CLI-supplied
   * score and re-judges. Will be removed in the V1.1 CLI cut.
   */
  submitResult(
    sessionId: string,
    input: SubmitResultInput,
  ): Promise<SubmitResultResponse>;
  /** FDRS-636 — mark an errored trial's session failed NOW with a short
   *  machine `error_code` (e.g. "agent_timeout"), instead of letting it sit
   *  open until the expiry sweeper reaps it. Contract: pome-cloud
   *  routes/abandon.ts — auth is the same surface as /finalize; an
   *  already-terminal session is an idempotent no-op (`abandoned: false`);
   *  a finalized run's session is never clobbered. */
  abandonSession(
    sessionId: string,
    input?: { errorCode?: string },
  ): Promise<AbandonSessionResponse>;
  requestEventsUploadUrl(sessionId: string): Promise<EventsUploadUrlResponse>;
  /** Multi-twin (M3): pass `twins` (>1) to receive a per-twin URL+key pair
   *  under `per_twin` in addition to the top-level primary-twin pair. Omit for
   *  single-twin sessions. An older cloud ignores the body and returns only
   *  the top-level pair. */
  requestStateUploadUrl(
    sessionId: string,
    twins?: string[],
  ): Promise<StateUploadUrlResponse>;
  /** F0-4 / L7 — mint a signed PUT for `signals.jsonl` (adapter-emitted
   *  HookEvent / ToolUseEvent / ToolResultEvent / SubagentSpawnEvent /
   *  LlmTurnEvent rows). The returned `key` flows into
   *  `FinalizeInput.signalsStorageKey`. */
  requestSignalsUploadUrl(sessionId: string): Promise<SignalsUploadUrlResponse>;
  /** D18.1 — mint a signed PUT for meta.json. See `MetaUploadUrlResponse`
   *  for the feature-detection contract (a 404 here means an older control
   *  plane; callers must tolerate it silently). */
  requestMetaUploadUrl(sessionId: string): Promise<MetaUploadUrlResponse>;
  /** @param bestEffort default true — hosted runner swallows network errors on teardown */
  deleteSession(sessionId: string, bestEffort?: boolean): Promise<void>;
}

// Keep these readers wire-identical to the additive exports in
// @pome-sh/shared-types 0.6.1. The CLI intentionally remains installable
// against 0.6.0 until that package batch has published.
// Scored finalize responses stay non-strict so additive M7 keys strip.
const finalizeScoredResponseSchema = finalizeResponseSchema.strip();

const finalizeStatusUrlSchema = z
  .string()
  .min(1)
  .refine(
    (value) => {
      if (value.startsWith("/") && !value.startsWith("//")) return true;
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: "Invalid status_url" },
  );

const finalizeAcceptedResponseSchema = z.object({
  evaluation_id: z.string().min(1),
  run_id: z.string().min(1),
  status: z.literal("queued"),
  status_url: finalizeStatusUrlSchema,
}).strict();

const finalizeStatusIdentitySchema = {
  evaluation_id: z.string().min(1),
  run_id: z.string().min(1),
};

const finalizeFailureErrorSchema = z.object({
  type: z.string().min(1),
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
}).strict();

const finalizeStatusResponseSchema = z.discriminatedUnion("status", [
  z.object({
    ...finalizeStatusIdentitySchema,
    status: z.literal("queued"),
  }).strict(),
  z.object({
    ...finalizeStatusIdentitySchema,
    status: z.literal("running"),
  }).strict(),
  z.object({
    ...finalizeStatusIdentitySchema,
    status: z.literal("failed"),
    error: finalizeFailureErrorSchema,
  }).strict(),
  z.object({
    ...finalizeStatusIdentitySchema,
    status: z.literal("completed"),
    result: finalizeScoredResponseSchema,
  }).strict(),
]);

type FinalizeAcceptedResponse = z.infer<typeof finalizeAcceptedResponseSchema>;
type FinalizeStatusResponse = z.infer<typeof finalizeStatusResponseSchema>;

class RetryableFinalizeStatusError extends HostedOrchError {
  constructor(
    error: HostedOrchError,
    public readonly retryAfterMs: number | null,
  ) {
    super(error.message, error.requestId, error.status);
    this.name = "RetryableFinalizeStatusError";
  }
}

export function createHostedClient(config: HostedClientConfig): HostedClient {
  const timeoutMs = config.timeoutMs ?? 30_000;
  const finalizeTimeoutMs = config.finalizeTimeoutMs ?? 5 * 60_000;
  const finalizePollInitialDelayMs = Math.max(
    1,
    config.finalizePollInitialDelayMs ?? 500,
  );
  const finalizePollMaxDelayMs = Math.max(
    finalizePollInitialDelayMs,
    config.finalizePollMaxDelayMs ?? 5_000,
  );
  const authHeaders: Record<string, string> =
    config.authScheme === "bearer"
      ? { authorization: `Bearer ${config.apiKey}` }
      : { "x-api-key": config.apiKey };

  async function readResponse<T>(
    res: Response,
    parse: (raw: unknown, response: Response) => T
  ): Promise<T> {
    const text = await res.text();
    let json: unknown;
    try {
      json = text.length ? JSON.parse(text) : {};
    } catch {
      throw new HostedOrchError(
        `non-JSON response (status ${res.status})`,
        undefined,
        res.status,
      );
    }
    if (!res.ok) {
      // Cloud's REST envelope is `{ error: { type, message, request_id } }`.
      // The twin pod's bearer-auth middleware uses Hono's default 401 shape:
      // `{ message: "Forbidden", documentation_url: "" }`. Handle both.
      const cloudErr = (json as { error?: { type?: string; message?: string; request_id?: string } }).error;
      const twinErr = cloudErr ? null : (json as { message?: string });
      const cloudDetails = (
        cloudErr as { details?: Record<string, unknown> } | undefined
      )?.details;
      const msg = cloudErr?.message ?? twinErr?.message ?? `HTTP ${res.status}`;
      const reqId = cloudErr?.request_id;
      if (res.status === 401 || res.status === 403) {
        throw new HostedAuthError(msg, reqId);
      }
      if (res.status === 402 || res.status === 429) {
        // FDRS-643 — carry the machine-readable envelope details (e.g.
        // `kind: "daily_judge_cap"`) so `pome demo` can render an honest
        // labeled at-capacity state instead of a generic quota message.
        throw new HostedQuotaError(msg, reqId, cloudDetails);
      }
      // Carry the envelope `error.type` (e.g. `multi_twin_unsupported`) so
      // callers can map specific rejections to friendly hints.
      throw new HostedOrchError(msg, reqId, res.status, cloudErr?.type);
    }
    try {
      return parse(json, res);
    } catch (err) {
      throw new HostedOrchError(
        `unexpected response shape: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        res.status,
      );
    }
  }

  async function postJson<T>(
    path: string,
    body: unknown,
    parse: (raw: unknown, response: Response) => T,
    options?: {
      headers?: Record<string, string>;
      signal?: AbortSignal;
      acceptedStatuses?: readonly number[];
      requestTimeoutMs?: number;
    },
  ): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(),
      options?.requestTimeoutMs ?? timeoutMs,
    );
    const abortFromCaller = () => ctrl.abort(options?.signal?.reason);
    options?.signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (options?.signal?.aborted) abortFromCaller();
    try {
      const res = await fetch(`${config.baseUrl}${path}`, {
        method: "POST",
        headers: {
          ...authHeaders,
          "content-type": "application/json",
          ...options?.headers,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (
        res.ok &&
        options?.acceptedStatuses &&
        !options.acceptedStatuses.includes(res.status)
      ) {
        throw new HostedOrchError(
          `unexpected HTTP status ${res.status}`,
          undefined,
          res.status,
        );
      }
      // Keep the timeout and caller cancellation active while consuming the
      // body. fetch() resolves after headers, before a streamed body finishes.
      return await readResponse(res, parse);
    } catch (err) {
      if (
        err instanceof HostedAuthError ||
        err instanceof HostedQuotaError ||
        err instanceof HostedOrchError
      ) {
        throw err;
      }
      throw new HostedOrchError(
        err instanceof Error ? err.message : "network error"
      );
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  async function getJsonBearer<T>(
    url: string,
    bearer: string,
    parse: (raw: unknown, response: Response) => T
  ): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: { authorization: `Bearer ${bearer}` },
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new HostedOrchError(
        err instanceof Error ? err.message : "network error"
      );
    } finally {
      clearTimeout(timer);
    }
    return readResponse(res, parse);
  }

  async function getJsonWithApiKey<T>(
    path: string,
    parse: (raw: unknown, response: Response) => T,
  ): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${config.baseUrl}${path}`, {
        method: "GET",
        headers: authHeaders,
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new HostedOrchError(
        err instanceof Error ? err.message : "network error",
      );
    } finally {
      clearTimeout(timer);
    }
    return readResponse(res, parse);
  }

  function retryAfterMs(value: string | null): number | null {
    if (value === null) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1_000;
    }
    const at = Date.parse(value);
    return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
  }

  function nextFinalizePollDelayMs(
    currentDelayMs: number,
    serverDelayMs: number | null,
  ): number {
    if (serverDelayMs !== null) {
      // Retry-After: 0 is legal, but accepting it literally on every response
      // creates a hot authenticated loop. The configured initial delay is the
      // lower bound for server hints.
      return Math.max(serverDelayMs, finalizePollInitialDelayMs);
    }
    return Math.min(
      Math.max(currentDelayMs * 2, finalizePollInitialDelayMs),
      finalizePollMaxDelayMs,
    );
  }

  async function sleepForPoll(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new HostedOrchError("finalize aborted");
    }
    if (ms <= 0) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(new HostedOrchError("finalize aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      // Re-check after subscribe — abort between the early check and
      // addEventListener would otherwise hang until the delay elapses.
      if (signal?.aborted) onAbort();
    });
  }

  function resolveFinalizeStatusUrl(statusUrl: string): URL {
    const apiOrigin = new URL(config.baseUrl).origin;
    let resolved: URL;
    try {
      resolved = new URL(statusUrl, apiOrigin);
    } catch {
      throw new HostedOrchError("finalize status_url is not a valid URL");
    }
    if (resolved.origin !== apiOrigin) {
      throw new HostedOrchError(
        "finalize status_url must use the configured API origin",
      );
    }
    return resolved;
  }

  async function getFinalizeStatus(
    url: URL,
    signal: AbortSignal | undefined,
    requestTimeoutMs: number,
  ): Promise<{ status: FinalizeStatusResponse; retryAfterMs: number | null }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), requestTimeoutMs);
    const abortFromCaller = () => ctrl.abort(signal?.reason);
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (signal?.aborted) abortFromCaller();
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: authHeaders,
        signal: ctrl.signal,
        // Node fetch preserves custom x-api-key headers across a cross-origin
        // redirect. Refuse redirects so same-origin validation remains true
        // for the server that actually receives tenant credentials.
        redirect: "manual",
      });
      if (res.status >= 300 && res.status < 400) {
        throw new HostedOrchError(
          "finalize status request must not redirect",
          undefined,
          res.status,
        );
      }
      const delay = retryAfterMs(res.headers.get("retry-after"));
      // Keep both timeout signals active until the full body is consumed.
      let status: FinalizeStatusResponse;
      try {
        status = await readResponse(res, (raw) =>
          finalizeStatusResponseSchema.parse(raw),
        );
      } catch (err) {
        if (
          err instanceof HostedOrchError &&
          err.status !== undefined &&
          err.status >= 500
        ) {
          throw new RetryableFinalizeStatusError(err, delay);
        }
        throw err;
      }
      return { status, retryAfterMs: delay };
    } catch (err) {
      if (signal?.aborted) {
        throw new HostedOrchError("finalize aborted");
      }
      if (
        err instanceof HostedAuthError ||
        err instanceof HostedQuotaError ||
        err instanceof HostedOrchError
      ) {
        throw err;
      }
      throw new HostedOrchError(
        err instanceof Error ? err.message : "network error",
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  async function pollFinalize(
    accepted: FinalizeAcceptedResponse,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<FinalizeResponse> {
    const statusUrl = resolveFinalizeStatusUrl(accepted.status_url);

    let delayMs = finalizePollInitialDelayMs;
    while (true) {
      const remainingBeforeDelay = deadline - Date.now();
      if (remainingBeforeDelay <= 0) {
        throw new HostedOrchError("asynchronous finalize timed out");
      }
      await sleepForPoll(Math.min(delayMs, remainingBeforeDelay), signal);

      const remainingBeforeRequest = deadline - Date.now();
      if (remainingBeforeRequest <= 0) {
        throw new HostedOrchError("asynchronous finalize timed out");
      }
      let polled: Awaited<ReturnType<typeof getFinalizeStatus>>;
      try {
        polled = await getFinalizeStatus(
          statusUrl,
          signal,
          Math.min(timeoutMs, remainingBeforeRequest),
        );
      } catch (err) {
        if (signal?.aborted) throw err;
        if (
          err instanceof HostedOrchError &&
          (err.status === undefined || err.status >= 500)
        ) {
          // The evaluation is durable. A transient status transport failure
          // must not turn a still-running evaluation into a CLI failure.
          delayMs = nextFinalizePollDelayMs(
            delayMs,
            err instanceof RetryableFinalizeStatusError
              ? err.retryAfterMs
              : null,
          );
          continue;
        }
        throw err;
      }
      if (
        polled.status.evaluation_id !== accepted.evaluation_id ||
        polled.status.run_id !== accepted.run_id
      ) {
        throw new HostedOrchError(
          "finalize status identifiers do not match the accepted evaluation",
        );
      }

      if (polled.status.status === "completed") {
        if (polled.status.result.run_id !== accepted.run_id) {
          throw new HostedOrchError(
            "finalize result run_id does not match the accepted evaluation",
          );
        }
        return polled.status.result;
      }
      if (polled.status.status === "failed") {
        const { type, message, details } = polled.status.error;
        if (type === "quota_exceeded") {
          throw new HostedQuotaError(message, undefined, details);
        }
        throw new HostedOrchError(`${type}: ${message}`);
      }
      delayMs = nextFinalizePollDelayMs(delayMs, polled.retryAfterMs);
    }
  }

  return {
    async createSession(input) {
      const body: Record<string, unknown> = {
        twins: input.twins,
        scenario_source: Buffer.from(input.scenarioSource, "utf8").toString(
          "base64",
        ),
      };
      if (input.idempotencyKey) {
        body.idempotency_key = input.idempotencyKey;
      }
      if (input.agentId) {
        body.agent_id = input.agentId;
      }
      if (input.seed !== undefined) {
        body.seed = input.seed;
      }
      if (input.groupId) {
        body.group_id = input.groupId;
      }
      return postJson("/v1/sessions", body, (raw) =>
        markPerTwinProvenance(
          createSessionResponseSchema.parse(raw),
          rawBodyHadPerTwin(raw),
        ),
      );
    },

    async abandonSession(sessionId, input) {
      const body: Record<string, unknown> = {};
      if (input?.errorCode) {
        body.error_code = input.errorCode;
      }
      return postJson(
        `/v1/sessions/${encodeURIComponent(sessionId)}/abandon`,
        body,
        (raw) => {
          if (
            typeof raw === "object" &&
            raw !== null &&
            typeof (raw as { session_id?: unknown }).session_id === "string" &&
            typeof (raw as { state?: unknown }).state === "string" &&
            typeof (raw as { abandoned?: unknown }).abandoned === "boolean"
          ) {
            const shaped = raw as {
              session_id: string;
              state: string;
              error_code?: unknown;
              abandoned: boolean;
            };
            return {
              session_id: shaped.session_id,
              state: shaped.state,
              error_code:
                typeof shaped.error_code === "string" ? shaped.error_code : null,
              abandoned: shaped.abandoned,
            } satisfies AbandonSessionResponse;
          }
          throw new HostedOrchError(
            "POST /v1/sessions/:id/abandon returned unexpected shape",
          );
        },
      );
    },

    async createEvalSession(input) {
      // 404 from an older control plane surfaces as HostedOrchError with the
      // cloud's own message; `pome eval` adds the upgrade hint at the CLI
      // layer.
      return postJson(
        "/v1/eval-sessions",
        { agent: input.agent, task_name: input.taskName },
        (raw) => createEvalSessionResponseSchema.parse(raw),
      );
    },

    async listSessions(opts) {
      const lim = opts?.limit ?? 50;
      const q = `?limit=${encodeURIComponent(String(lim))}`;
      return getJsonWithApiKey(`/v1/sessions${q}`, (raw) => {
        if (!Array.isArray(raw)) {
          throw new HostedOrchError("GET /v1/sessions expected a JSON array");
        }
        return raw.map((row) => sessionPublicSchema.parse(row));
      });
    },

    async getSession(sessionId) {
      return getJsonWithApiKey(
        `/v1/sessions/${encodeURIComponent(sessionId)}`,
        (raw) => sessionPublicSchema.parse(raw),
      );
    },

    async fetchState(input) {
      return getJsonBearer(
        `${input.twinUrl}/_pome/state`,
        input.agentToken,
        // domain.exportState() shape varies per twin; pass through.
        (raw) => raw
      );
    },

    async fetchEvents(input) {
      return getJsonBearer(
        `${input.twinUrl}/_pome/events`,
        input.agentToken,
        (raw) => {
          if (!Array.isArray(raw)) {
            throw new HostedOrchError("twin /_pome/events returned non-array");
          }
          return raw;
        }
      );
    },

    async requestEventsUploadUrl(sessionId) {
      return postJson(
        `/v1/sessions/${encodeURIComponent(sessionId)}/result-upload-url`,
        {},
        (raw) => {
          if (
            typeof raw === "object" &&
            raw !== null &&
            typeof (raw as { url?: unknown }).url === "string" &&
            typeof (raw as { key?: unknown }).key === "string"
          ) {
            return raw as EventsUploadUrlResponse;
          }
          throw new HostedOrchError(
            "POST /v1/sessions/:id/result-upload-url returned unexpected shape",
          );
        },
      );
    },

    async requestSignalsUploadUrl(sessionId) {
      return postJson(
        `/v1/sessions/${encodeURIComponent(sessionId)}/signals-upload-url`,
        {},
        (raw) => {
          if (
            typeof raw === "object" &&
            raw !== null &&
            typeof (raw as { url?: unknown }).url === "string" &&
            typeof (raw as { key?: unknown }).key === "string"
          ) {
            return raw as SignalsUploadUrlResponse;
          }
          throw new HostedOrchError(
            "POST /v1/sessions/:id/signals-upload-url returned unexpected shape",
          );
        },
      );
    },

    async requestMetaUploadUrl(sessionId) {
      return postJson(
        `/v1/sessions/${encodeURIComponent(sessionId)}/meta-upload-url`,
        {},
        (raw) => {
          if (
            typeof raw === "object" &&
            raw !== null &&
            typeof (raw as { url?: unknown }).url === "string" &&
            typeof (raw as { key?: unknown }).key === "string"
          ) {
            return raw as MetaUploadUrlResponse;
          }
          throw new HostedOrchError(
            "POST /v1/sessions/:id/meta-upload-url returned unexpected shape",
          );
        },
      );
    },

    async requestStateUploadUrl(sessionId, twins) {
      // Multi-twin (M3): a `{ twins }` body asks the cloud to sign a per-twin
      // pair for each twin (returned under `per_twin`). Single-twin callers
      // pass nothing and the body stays `{}` — byte-identical to pre-M3.
      const body: Record<string, unknown> =
        twins && twins.length > 0 ? { twins } : {};
      return postJson(
        `/v1/sessions/${encodeURIComponent(sessionId)}/state-upload-url`,
        body,
        (raw) => {
          const isEntry = (x: unknown): x is StateUploadUrlEntry =>
            typeof x === "object" &&
            x !== null &&
            typeof (x as { url?: unknown }).url === "string" &&
            typeof (x as { key?: unknown }).key === "string";
          const isPair = (x: unknown): x is StateUploadUrlPair =>
            typeof x === "object" &&
            x !== null &&
            isEntry((x as { state_initial?: unknown }).state_initial) &&
            isEntry((x as { state_final?: unknown }).state_final);
          if (isPair(raw)) {
            // Validate `per_twin` when present; drop it silently if malformed
            // rather than failing the whole request (best-effort, like the
            // rest of the upload surface).
            const perTwinRaw = (raw as { per_twin?: unknown }).per_twin;
            let perTwin: Record<string, StateUploadUrlPair> | undefined;
            if (
              typeof perTwinRaw === "object" &&
              perTwinRaw !== null &&
              !Array.isArray(perTwinRaw) &&
              Object.values(perTwinRaw as Record<string, unknown>).every(isPair)
            ) {
              perTwin = perTwinRaw as Record<string, StateUploadUrlPair>;
            }
            return { ...(raw as StateUploadUrlResponse), per_twin: perTwin };
          }
          throw new HostedOrchError(
            "POST /v1/sessions/:id/state-upload-url returned unexpected shape",
          );
        },
      );
    },

    async finalize(sessionId, input, options) {
      const deadline = Date.now() + finalizeTimeoutMs;
      const body: Record<string, unknown> = {
        stop_reason: input.stopReason,
        exit_code: input.exitCode,
        duration_ms: input.durationMs,
        agent_model: input.agentModel,
        agent_sdk: normalizeAgentSdk(input.agentSdk),
        criteria: input.criteria,
        scenario_name: input.scenarioName,
        scenario_hash: input.scenarioHash,
        scenario_prompt: input.scenarioPrompt,
        expected_behavior: input.expectedBehavior,
      };
      if (input.traceStorageKey !== undefined) {
        body.trace_storage_key = input.traceStorageKey;
      }
      if (input.stateInitialStorageKey !== undefined) {
        body.state_initial_storage_key = input.stateInitialStorageKey;
      }
      if (input.stateFinalStorageKey !== undefined) {
        body.state_final_storage_key = input.stateFinalStorageKey;
      }
      if (input.signalsStorageKey !== undefined) {
        body.signals_storage_key = input.signalsStorageKey;
      }
      if (
        input.perTwinStateKeys !== undefined &&
        Object.keys(input.perTwinStateKeys).length > 0
      ) {
        body.per_twin_state_keys = input.perTwinStateKeys;
      }
      const initial = await postJson(
        `/v1/sessions/${encodeURIComponent(sessionId)}/finalize`,
        body,
        (raw, response) =>
          response.status === 202
            ? finalizeAcceptedResponseSchema.parse(raw)
            : finalizeScoredResponseSchema.parse(raw),
        {
          headers: { prefer: "respond-async" },
          signal: options?.signal,
          acceptedStatuses: [200, 201, 202],
          requestTimeoutMs: Math.min(timeoutMs, finalizeTimeoutMs),
        },
      );
      return "status_url" in initial
        ? pollFinalize(initial, deadline, options?.signal)
        : initial;
    },

    async submitResult(sessionId, input) {
      return postJson(
        `/v1/sessions/${encodeURIComponent(sessionId)}/result`,
        {
          scenario_name: input.scenarioName,
          scenario_hash: input.scenarioHash,
          duration_ms: input.durationMs,
          agent_model: input.agentModel,
          satisfaction_score: input.satisfactionScore,
          criteria_results: input.criteriaResults,
          judge_model: input.judgeModel,
          judge_tokens_in: input.judgeTokensIn,
          judge_tokens_out: input.judgeTokensOut,
          agent_sdk: normalizeAgentSdk(input.agentSdk),
          lanes: input.lanes,
          steps: input.steps,
          fix_prompt: input.fixPrompt,
          events_jsonl_url: input.eventsJsonlUrl,
          trace_jsonl_b64: Buffer.from(input.traceJsonl, "utf8").toString(
            "base64"
          ),
          state_initial_json_b64: Buffer.from(
            input.stateInitialJson,
            "utf8"
          ).toString("base64"),
          state_final_json_b64: Buffer.from(
            input.stateFinalJson,
            "utf8"
          ).toString("base64"),
        },
        (raw) => submitResultResponseSchema.parse(raw)
      );
    },

    async deleteSession(sessionId, bestEffort = true) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(
          `${config.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}`,
          {
            method: "DELETE",
            // authHeaders, not a hardcoded x-api-key: demo teardown carries a
            // bearer demo_token (FDRS-643 live-run finding — the hardcoded
            // header made every demo DELETE an opaque 404, silently swallowed
            // by best-effort).
            headers: authHeaders,
            signal: ctrl.signal,
          }
        );
      } catch (err) {
        if (bestEffort) return;
        throw new HostedOrchError(
          err instanceof Error ? err.message : "network error",
        );
      } finally {
        clearTimeout(timer);
      }
      // Cloud spec (pome-cloud docs/05-api-spec.md): 204 on success. Accept
      // 200 too in case a future control-plane returns a body. 409 keeps
      // best-effort teardown idempotent when a concurrent reaper already
      // closed the row.
      if (res.status === 204 || res.status === 200 || res.status === 409) return;
      if (res.status === 404) {
        if (bestEffort) return;
        throw new HostedOrchError(
          `DELETE /v1/sessions/${sessionId} → 404 (not found)`,
        );
      }
      if (res.status === 401 || res.status === 403) {
        throw new HostedAuthError(
          `DELETE /v1/sessions/${sessionId} → ${res.status}`
        );
      }
      // 404 / 5xx — log via thrown but caller can swallow if mid-teardown.
      throw new HostedOrchError(
        `DELETE /v1/sessions/${sessionId} → ${res.status}`
      );
    },
  };
}

function normalizeAgentSdk(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
