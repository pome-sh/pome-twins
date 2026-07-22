// SPDX-License-Identifier: Apache-2.0
//
// shared-types §4 — PUBLIC REST API (api.pome.sh/v1) request/response shapes,
// excluding the /finalize response family (see `./finalize-shapes.ts`). The two
// module-private helpers (`normalizeCreateSessionResponse` and the
// `*ObjectSchema` consts wrapped by z.preprocess) stay co-located with their
// exported consumers here. Re-exported through the `@pome-sh/shared-types` barrel.

import { z } from "zod";
import {
  apiKeySchema,
  planTierSchema,
  teamInviteSchema,
  teamRoleSchema,
  teamSchema,
  userSchema,
} from "./identity.js";
import { criterionResultSchema, judgeModelSchema, laneSchema, stepSchema } from "./run.js";
import { LEGACY_CRITERION_KIND_MAP, normalizeTaskVocabKeys } from "./task-vocab.js";

// ─────────────────────────────────────────────────────────────────────────────
// 4. PUBLIC REST API (api.pome.sh/v1) request/response shapes
// ─────────────────────────────────────────────────────────────────────────────

// GET /v1/me
export const meResponseSchema = z.object({
  user: userSchema.pick({ id: true, email: true }),
  team: teamSchema.pick({ id: true, slug: true, plan_tier: true }),
  api_key: apiKeySchema.pick({ id: true, name: true }),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

// POST /v1/sessions
//
// W3 vocab (FDRS-653): `task_source` / `task_id` are canonical; the exported
// schema wraps this object in the tolerant-reader preprocess so 0.3.0 CLIs
// sending `scenario_source` / `scenario_id` keep working unchanged.
const createSessionRequestObjectSchema = z
  .object({
    // Multi-twin (M3): multi-twin arrays are now honored — the cloud provisions
    // one isolated sandbox per twin. Max 3 twins per session; the cap is
    // enforced cloud-side, so we deliberately do NOT add a `.max()` here (the
    // boundary stays permissive and the cloud owns the quota rule). `twins[0]`
    // is the session's primary twin — the default attribution for criteria and
    // state that omit an explicit twin.
    //
    // Back-compat (the whole M3 contract): a single-twin `twins` array plus none
    // of the new optional fields below is byte-identical to pre-M3 behavior, so
    // (old CLI × new cloud) is unchanged. (new CLI × old cloud) with >1 twin is
    // rejected by the cloud with 422 `multi_twin_unsupported`; a single-twin
    // request degrades gracefully because every new field is optional and
    // non-strict readers strip unknown keys rather than erroring.
    twins: z.array(z.string()).min(1).default(["github"]),
    task_source: z.string().optional(),        // base64-encoded UTF-8 markdown; 0.3.0 alias: scenario_source
    task_id: z.string().optional(),            // alternative: stored task; 0.3.0 alias: scenario_id
    // FDRS-580 / ADR-015 (adopted from pome-cloud, FDRS-613): the seed override
    // is a PERMISSIVE, shape-blind boundary. The twin pod's own `parseSeed` is
    // the sole authority on the seed's domain shape; the cloud forwards it
    // verbatim. `z.record` keeps the one invariant that is the boundary's
    // business — "the seed is a JSON object" — while forwarding every domain
    // field, known or not, untouched. Do NOT re-narrow to `seedStateSchema`
    // here: a narrow `.object()` strips unknown keys, which is how PR-based
    // scenarios lost their `users` / `pull_requests` / `files`.
    seed: z.record(z.string(), z.unknown()).optional(), // optional override
    // M3: client-supplied UUID v4 used for 30s server-side dedupe of
    // POST /v1/sessions. The dashboard generates one per Start-button click;
    // legacy clients work without it.
    idempotency_key: z.string().uuid().optional(),
    // M3 / FDRS-636: client-minted trial-group identity — `pome run -n k`
    // (and `pome demo`) stamp one id per invocation, shared by all k trial
    // sessions. The cloud copies it onto sessions.group_id at mint and onto
    // runs.group_id at finalize; the demo/eval mints already accept the same
    // field. Format mirrors the cloud's GROUP_ID_RE. Legacy clients omit it.
    group_id: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/).optional(),
    // F-818 (spec F-804): per-run override of the manifest's agent.version —
    // an opaque user-declared label stamped onto the session/run rows (F-820).
    // Absent = the agent's registered version. Additive; older clients omit it
    // and an older cloud strips it.
    agent_version: z.string().optional(),
  })
  .refine(
    (v) => Boolean(v.task_source) !== Boolean(v.task_id),
    { message: "Provide exactly one of task_source or task_id (scenario_source / scenario_id are accepted 0.3.0 aliases)" }
  );

// Tolerant reader (FDRS-653): accepts both vocabularies, normalizes to task_*.
export const createSessionRequestSchema = z.preprocess(
  normalizeTaskVocabKeys,
  createSessionRequestObjectSchema,
);
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

function normalizeCreateSessionResponse(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.session_id !== "string" ||
    typeof record.twin_url !== "string" ||
    typeof record.openapi_url !== "string"
  ) {
    return value;
  }

  let twin = "github";
  try {
    const [, parsedTwin] = new URL(record.twin_url).pathname.split("/");
    if (parsedTwin !== undefined && parsedTwin.length > 0) twin = parsedTwin;
  } catch {
    // Schema validation below will report the invalid URL.
  }

  const apiUrl = record.twin_url;
  const mcpUrl =
    typeof apiUrl === "string" && apiUrl.startsWith("https://api.pome.sh/")
      ? apiUrl.replace("https://api.pome.sh/", "https://mcp.pome.sh/")
      : apiUrl;

  return {
    ...record,
    session_token: record.session_token ?? record.session_id,
    per_twin:
      record.per_twin ??
      {
        [twin]: {
          api_url: apiUrl,
          mcp_url: mcpUrl,
          openapi_url: record.openapi_url,
        },
      },
  };
}

// M3 response shape: one session, N twins, one set of URLs per twin under
// `per_twin{}`. Legacy single-twin fields `twin_url` + `openapi_url` continue
// to be populated as `per_twin[twins[0]].api_url` / `.openapi_url` for ≥1 OSS
// CLI release. `session_token` is the public token used in URLs — same value as
// `session_id` in V1, but named separately so URL-shaped consumers stop reading
// internal-id-shaped fields. Both `session_token` and `per_twin` reconciled
// from pome-cloud /v1 wire truth (FDRS-613).
export const createSessionResponseSchema = z.preprocess(normalizeCreateSessionResponse, z.object({
  session_id: z.string(),
  session_token: z.string(),                   // = session_id in V1; public URL token
  twin_url: z.string().url(),                  // legacy: = per_twin[twins[0]].api_url
  expires_at: z.string().datetime(),
  agent_token: z.string(),                     // edt_<jwt>; SENSITIVE — never log; CLI memory only; bearer scoped to session TTL
  provider_credentials: z
    .object({
      github: z
        .object({
          token: z.string(),
          header: z.literal("Authorization"),
          scheme: z.literal("Bearer"),
        })
        .optional(),
      stripe: z
        .object({
          api_key: z.string(),
          header: z.literal("Authorization"),
          scheme: z.literal("Bearer"),
        })
        .optional(),
      slack: z
        .object({
          token: z.string(),
          header: z.literal("Authorization"),
          scheme: z.literal("Bearer"),
        })
        .optional(),
    })
    .default({}),
  openapi_url: z.string().url(),               // legacy: = per_twin[twins[0]].openapi_url
  per_twin: z.record(
    z.string(),
    z.object({
      api_url: z.string().url(),               // api.pome.sh/<twin>/<session_token>
      mcp_url: z.string().url(),               // mcp.pome.sh/<twin>/<session_token> (501 stub in V1)
      openapi_url: z.string().url(),
    }),
  ),
}));
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;

// POST /v1/sessions/{id}/result — SYNCHRONOUS. CLI scores locally (BYOK Flavor #1) then POSTs.
//
// Cloud never sees the customer's LLM key, never invokes any LLM provider,
// never holds `agent_stdout` (which would contain the agent's prompts and
// completions). Trace blobs (twin's HTTP request/response captures) ARE
// uploaded — those are the agent's tool calls against the twin, not LLM data.
//
// (Cloud-side note: cloud V1 treats /result as a legacy shim — new CLIs upload
// blobs via presigned URLs and call /finalize with ADR-013's managed judge.
// The shape below stays the wire contract either way.)
//
// Multi-twin (M3): per-twin state storage keys, keyed by twin id. Each entry
// carries the storage KEYS (not URLs) the CLI uploaded that twin's initial /
// final state blobs to. One entry per twin the session provisioned. Single-twin
// sessions omit this and keep using the flat top-level state fields. Additive:
// an older cloud that does not read this field strips it and scores the primary
// twin unchanged. Consumed by `finalizeRequestSchema` (finalize-shapes.ts) — the
// LIVE scoring wire — as the optional `per_twin_state_keys` field; defined here
// alongside the other §4 state-storage-key shapes.
export const perTwinStateKeysSchema = z.record(
  z.string(),
  z
    .object({
      state_initial_key: z.string().min(1).optional(),
      state_final_key: z.string().min(1).optional(),
    })
    // A twin entry must carry AT LEAST ONE storage key — an empty `{}` conveys
    // nothing and is almost always a serialization bug. Both keys stay
    // individually optional: final-only is legal (initial state is optional in
    // the single-twin contract too — `state_initial_json_b64` can be an empty
    // snapshot), and initial-only is legal symmetrically.
    .refine(
      (v) => v.state_initial_key !== undefined || v.state_final_key !== undefined,
      { message: "Each twin entry must carry at least one of state_initial_key or state_final_key" },
    ),
);
export type PerTwinStateKeys = z.infer<typeof perTwinStateKeysSchema>;

// W3 vocab (FDRS-653): `task_name` / `task_hash` canonical; the exported
// schema accepts 0.3.0 CLIs' `scenario_name` / `scenario_hash` and criterion
// kinds D/P inside `criteria_results`, normalizing both.
const submitResultRequestObjectSchema = z.object({
  task_name: z.string(),                       // 0.3.0 alias: scenario_name
  task_hash: z.string(),                       // 0.3.0 alias: scenario_hash
  duration_ms: z.number().int(),
  agent_model: z.string(),
  // CLI-computed scoring fields (server-trusted; under BYOK there's nothing
  // billing-sensitive to spoof — we don't bill on judge cost):
  satisfaction_score: z.number().int().min(0).max(100),
  criteria_results: z.array(criterionResultSchema),
  judge_model: judgeModelSchema,
  judge_tokens_in: z.number().int().min(0).nullable(),
  judge_tokens_out: z.number().int().min(0).nullable(),
  // Correlator output + fix-prompt from CLI (post-M3i). Defaults supplied for
  // backward compat during the M3i rollout — older CLIs that omit these still
  // submit successfully and the run lands as a "legacy" row (empty lanes/steps,
  // null fix_prompt). When all CLIs are M3i+, tighten by removing defaults.
  lanes: z.array(laneSchema).default([]),
  steps: z.array(stepSchema).default([]),
  fix_prompt: z.string().nullable().default(null),
  // FDRS-357 (adopted from pome-cloud, FDRS-613): storage key (NOT URL) returned
  // by POST /v1/sessions/:id/result-upload-url. Null on upload failure
  // (best-effort), --no-upload opt-out, or pre-FDRS-357 CLI.
  events_jsonl_url: z.string().nullable().default(null),
  // Trace blobs — safe to upload (HTTP between agent and twin, not LLM prompts):
  trace_jsonl_b64: z.string(),
  state_initial_json_b64: z.string(),
  state_final_json_b64: z.string(),
  // NOTE: agent_stdout is intentionally NOT in this request. Cloud never
  // receives the agent's prompts or completions. The CLI uses agent_stdout
  // locally for the [model] judge then discards it.
});

// Tolerant reader (FDRS-653): accepts both vocabularies, normalizes to task_*.
export const submitResultRequestSchema = z.preprocess(
  normalizeTaskVocabKeys,
  submitResultRequestObjectSchema,
);
export type SubmitResultRequest = z.infer<typeof submitResultRequestSchema>;

export const submitResultResponseSchema = z.object({
  run_id: z.string(),
  dashboard_url: z.string().url(),
});
export type SubmitResultResponse = z.infer<typeof submitResultResponseSchema>;

// POST /v1/eval-sessions — mints a twin-less session for `pome eval <run-dir>`.
export const createEvalSessionResponseSchema = z.object({
  session_id: z.string(),
  expires_at: z.string(),
});
export type CreateEvalSessionResponse = z.infer<typeof createEvalSessionResponseSchema>;

export const criterionDefSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  // Tolerant reader (F-778): released CLIs still send the legacy "D"/"P"
  // spellings; parsed output is always the canonical "code"/"model". Single
  // source of truth for the rename is LEGACY_CRITERION_KIND_MAP.
  kind: z
    .enum(["D", "P", "code", "model"])
    .transform((kind) =>
      kind === "D" || kind === "P" ? LEGACY_CRITERION_KIND_MAP[kind] : kind,
    ),
  // Multi-twin (M3): the twin a [code:<twin>]/[model:<twin>] task criterion
  // attributes to. Absent = the session's primary twin (twins[0]). Additive —
  // single-twin tasks omit it and score against the sole twin as before.
  twin: z.string().min(1).optional(),
});
export type CriterionDef = z.infer<typeof criterionDefSchema>;
// Writer-side shape of the finalize wire during the F-778 compat window: a
// producer may still send the legacy "D"/"P" spellings (released CLIs do);
// readers always see the canonical CriterionDef after parse.
export type CriterionDefInput = z.input<typeof criterionDefSchema>;

// POST /v1/agents — register an agent (vercel-link shape). The server is
// canonical for the slug; the CLI persists whatever id/slug it returns.
export const createAgentRequestSchema = z.object({
  name: z.string().min(1),
  // Manifest identity (F-818, spec F-804): human-ish slug input — the server
  // derives the canonical kebab slug with the same deriveAgentSlug exported
  // from `./manifest.js`, then validates it against SLUG_RE. Cap mirrors the
  // control-plane edge; shape is deliberately NOT enforced here.
  slug: z.string().min(1).max(64).optional(),
  description: z.string().optional(),
  // User-declared version label from the manifest's agent.version — an opaque
  // string, never auto-bumped, never semver-interpreted.
  version: z.string().optional(),
  // Open enum by design (F-804): unknown frameworks get a did-you-mean warning
  // server-side, never a validation error.
  framework: z.string().min(1).optional(),
  // Multi-twin (M3): the twins this agent is allowed to exercise. Absent = the
  // server's default enablement. The cloud intersects a session's requested
  // twins with the agent's enabled services. Additive; older clients omit it.
  twins: z.array(z.string()).min(1).optional(),
});
export type CreateAgentRequest = z.infer<typeof createAgentRequestSchema>;

// POST /v1/agents response. Not `.strict()`: the cloud may emit additive fields
// that older/newer CLIs strip rather than reject (tolerant reader).
export const agentResponseSchema = z.object({
  id: z.string(),                              // agt_<nanoid>
  slug: z.string(),
  display_name: z.string(),
  judge_model: z.string(),
  // Manifest identity (F-818): registered agent.framework / agent.description /
  // agent.version, nullable where the server has nothing stored. Optional for
  // the pre-F-820 cloud, which omits them.
  framework: z.string().optional(),
  description: z.string().nullable().optional(),
  version: z.string().nullable().optional(),
  // F-818 resolver semantics: true when POST /v1/agents auto-registered a new
  // agent for this slug, false when it resolved an existing one. Optional for
  // the pre-F-820 cloud; absence means "unknown", not "resolved".
  created: z.boolean().optional(),
  // F-861 slug-rename hint (cloud-emitted since v0.4.18): how the resolver
  // matched this slug — "slug" (live match), "alias" (an old slug that was
  // renamed; the returned `slug` is the new canonical), or "created" (fresh
  // auto-register). The CLI surfaces a rename notice only on the "alias" branch.
  // `hint` is an optional human-readable nudge to print verbatim. Both optional
  // for the pre-v0.4.18 cloud; absence means "unknown".
  resolved_via: z.enum(["slug", "alias", "created"]).optional(),
  hint: z.string().optional(),
  // Multi-twin (M3): the services (twins) this agent may exercise. Absent on an
  // older cloud; new CLIs treat absence as "unconstrained / server default".
  enabled_services: z.array(z.string()).optional(),
});
export type AgentResponse = z.infer<typeof agentResponseSchema>;

// POST /v1/sessions/:id/state-upload-url response — a presigned PUT URL + the
// storage KEY (not a URL) for each of the initial and final state blobs. Mirrors
// the sibling *-upload-url routes' `{ url, key }` entry, but returns the
// initial/final pair in a single call.
export const stateUploadUrlEntrySchema = z.object({
  url: z.string().url(),
  key: z.string().min(1),
});
export type StateUploadUrlEntry = z.infer<typeof stateUploadUrlEntrySchema>;

export const stateUploadUrlResponseSchema = z.object({
  state_initial: stateUploadUrlEntrySchema,
  state_final: stateUploadUrlEntrySchema,
  // Multi-twin (M3): one initial/final URL+key pair per twin, keyed by twin id,
  // so each twin's state blobs land under its own storage prefix. Absent on
  // single-twin sessions and on an older cloud, where the top-level pair is
  // authoritative (new CLI × old cloud degrades gracefully).
  per_twin: z
    .record(
      z.string(),
      z.object({
        state_initial: stateUploadUrlEntrySchema,
        state_final: stateUploadUrlEntrySchema,
      }),
    )
    .optional(),
});
export type StateUploadUrlResponse = z.infer<typeof stateUploadUrlResponseSchema>;

// GET /v1/usage — live concurrent-session quota snapshot.
// FDRS-613: `sessions_remaining` tightened to `.int().min(0)` to match the
// pome-cloud /v1 wire truth (cloud clamps remaining at 0 rather than exposing
// negative overage on this live snapshot).
export const usageResponseSchema = z.object({
  period_start: z.string().datetime(),
  period_end: z.string().datetime(),
  sessions_used: z.number().int().min(0),
  sessions_quota: z.number().int().min(0),
  sessions_remaining: z.number().int().min(0),
  plan_tier: planTierSchema,
});
export type UsageResponse = z.infer<typeof usageResponseSchema>;

// POST /v1/teams/{id}/invites
export const createInviteRequestSchema = z.object({
  email: z.string().email(),
  role: teamRoleSchema.default("member"),
});
export type CreateInviteRequest = z.infer<typeof createInviteRequestSchema>;

export const createInviteResponseSchema = z.object({
  invite: teamInviteSchema,
  invite_url: z.string().url(),                // "https://pome.sh/invites/<token>"
});
export type CreateInviteResponse = z.infer<typeof createInviteResponseSchema>;

// POST /v1/invites/{token}/accept (cloud surface: dashboard tRPC invites.accept)
export const acceptInviteRequestSchema = z.object({
  token: z.string().min(16),
});
export type AcceptInviteRequest = z.infer<typeof acceptInviteRequestSchema>;

export const acceptInviteResponseSchema = z.object({
  team_id: z.string(),
  role: teamRoleSchema,
});
export type AcceptInviteResponse = z.infer<typeof acceptInviteResponseSchema>;
