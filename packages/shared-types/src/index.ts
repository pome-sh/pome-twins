// SPDX-License-Identifier: Apache-2.0
/**
 * shared-types — V1 contract barrel
 *
 * Shape contract between WS-A (cloud control plane + dashboard) and WS-B
 * (twin runtime + evaluator + CLI). After 2026-05-11, the file is split:
 *   - `./recorder-events.ts` — RecorderEvent + supporting types
 *   - `./run.ts`             — Run + Lane + Step + CriterionResult
 *   - this file (`./index.ts`) — identity, sessions, scenarios, REST API,
 *     error envelope, EvaluatorHooks, plus barrel re-exports of the above
 *
 * Pre-2026-05-11 v2 (2026-04-30) folded in the BYOK-Flavor-#1 +
 * OpenAI-compatible-endpoint pivot:
 *   - LLM judge runs CLI-side using the customer's LLM provider key (any
 *     OpenAI-compatible endpoint — OpenRouter / Vercel AI Gateway /
 *     LiteLLM / OpenAI / Anthropic via gateway / Ollama / etc.).
 *   - Cloud never holds, sees, or invokes the LLM provider key.
 *   - `POST /v1/sessions/{id}/result` is synchronous: CLI submits a
 *     pre-scored result + trace blobs; cloud writes a row.
 *   - `runs.judge_cost_cents` REMOVED → replaced with token telemetry
 *     (`judge_tokens_in/out`). Cloud does not maintain provider pricing.
 *   - `EvaluatorHooks.onJudgeCall` REMOVED → only `onTraceUpload` remains.
 *   - `agent_stdout` is NEVER uploaded to cloud (privacy posture: "cloud
 *     never sees your prompts or agent output").
 *
 * Source documents this draft is faithful to:
 *   - product/04-data-model.md (Postgres + SQLite schemas, post-BYOK)
 *   - product/05-api-spec.md (CLI / REST / tRPC surfaces, post-BYOK)
 *   - pome-cloud/docs/decisions/002-open-core-boundary.md (EvaluatorHooks pattern)
 *   - pome-cloud/docs/decisions/008-multi-tenant-pods.md (per-session connection model)
 *
 * Already-existing schemas absorbed from oslo workspace:
 *   - pome/src/scenario/scenarioSchema.ts (Criterion, ScenarioConfig, Scenario)
 *   - pome/src/twin/github/domain/seed.ts (SeedState — nested shape)
 *   - pome/src/evaluator/score.ts (CriterionResult shape: criterion+passed+skipped+reason)
 *
 * Naming conventions:
 *   - Persisted IDs are typed strings: `usr_*`, `tm_*`, `ses_*`, `run_*`,
 *     `scn_*`, `pme_*`, `edt_*`, `inv_*` (per 04-data-model.md).
 *   - Timestamps are ISO 8601 strings on the wire. (Postgres-side they
 *     are `timestamptz`; we stringify at the API boundary.)
 *   - `nullable()` = "the field is always present, sometimes null"
 *     `optional()` = "the field may be absent entirely"
 *
 * Change policy after sign-off:
 *   - Either founder changing a shape requires a PR + both signoffs.
 *   - npm version pinned in both repos; CI alerts on bump mismatch.
 *   - 4-week lock target before any breaking change.
 */

import { z } from "zod";
import {
  criterionResultSchema,
  criterionSchema,
  judgeModelSchema,
  laneSchema,
  stepSchema,
} from "./run.js";

// Barrel re-exports — consumers `import { ... } from "@pome-sh/shared-types"`
// regardless of which leaf file owns the type.
export * from "./recorder-events.js";
export * from "./run.js";
export * from "./github-access-control.js";
// OpenTelemetry-native trace surface (M1 / FDRS-480-482): OtelSpanEvent schema,
// GenAI/HTTP span mapper, legacy→span shim, pinned semconv, otelEventSchema.
export * from "./otel/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1. IDENTITY
// ─────────────────────────────────────────────────────────────────────────────

export const userSchema = z.object({
  id: z.string(),                              // usr_<nanoid> (text, not uuid; per /plan-eng-review L7)
  clerk_user_id: z.string(),                   // Clerk user ID (`user_*`)
  email: z.string().email(),
  display_name: z.string().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type User = z.infer<typeof userSchema>;

// FDRS-613: reconciled to pome-cloud /v1 wire truth — `hobby` and `team` were
// added cloud-side for the launch pricing tiers; adopted here so a cloud-issued
// MeResponse / UsageResponse (plan_tier) parses under the twins schema.
export const planTierSchema = z.enum([
  "free",
  "hobby",
  "pro",
  "team",
  "self_host_annual",
  "enterprise",
]);
export type PlanTier = z.infer<typeof planTierSchema>;

export const teamSchema = z.object({
  id: z.string(),                              // tm_<nanoid>
  slug: z.string(),                            // /dashboard/[teamSlug]/...
  name: z.string(),
  plan_tier: planTierSchema,
  stripe_customer_id: z.string().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type Team = z.infer<typeof teamSchema>;

export const teamRoleSchema = z.enum(["owner", "admin", "member"]);
export type TeamRole = z.infer<typeof teamRoleSchema>;

export const teamMemberSchema = z.object({
  team_id: z.string(),
  user_id: z.string(),
  role: teamRoleSchema,
  invited_at: z.string().datetime(),
  accepted_at: z.string().datetime().nullable(),
});
export type TeamMember = z.infer<typeof teamMemberSchema>;

// Public invite shape — token is NEVER returned in API responses. The plaintext
// token is delivered exactly once via `createInviteResponseSchema.invite_url`
// (which embeds it as a path segment). Server stores only sha256(token) in
// `team_invites.token_hash`.
export const teamInviteSchema = z.object({
  id: z.string(),                              // inv_<nanoid>
  team_id: z.string(),
  email: z.string().email(),
  role: teamRoleSchema,
  invited_by: z.string(),                      // user_id
  expires_at: z.string().datetime(),
  accepted_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
});
export type TeamInvite = z.infer<typeof teamInviteSchema>;

export const apiKeySchema = z.object({
  id: z.string(),                              // pme_<short> public prefix; hashed_key NEVER appears in API responses (kept server-side only)
  team_id: z.string(),
  name: z.string(),
  created_by: z.string(),                      // user_id
  last_used_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  revoked_at: z.string().datetime().nullable(),
});
export type ApiKey = z.infer<typeof apiKeySchema>;

// One-time response shape — full key string is only in the create-response, never persisted.
export const apiKeyCreatedSchema = apiKeySchema.extend({
  full_key: z.string(),                        // pme_<full> — show once, then redact
});
export type ApiKeyCreated = z.infer<typeof apiKeyCreatedSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// 2. SESSIONS
// ─────────────────────────────────────────────────────────────────────────────

// Mounted twin set — the cloud control plane's allowlist for create-session.
// V1 ships GitHub only end-to-end; Stripe/Slack are scaffolded in the OSS repo
// and reachable through the multi-twin runtime. Distinct from `KNOWN_TWIN_IDS`
// (re-exported from `./recorder-events.ts`) which serves dashboard-rendering
// pattern-matching for arbitrary `RecorderEvent.twin` values. Mirrored from
// pome-cloud shared-types (FDRS-613).
export const MOUNTED_TWINS = ["github", "stripe", "slack"] as const;

export const sessionStateSchema = z.enum([
  "provisioning",
  "ready",
  "running",
  "done",
  "expired",
  "failed",
]);
export type SessionState = z.infer<typeof sessionStateSchema>;

// Internal DB row shape — includes pod_id and api_key_id which are NOT exposed publicly.
//
// Multi-twin (M3): `twins[]` is the new authoritative field. `twin_type` is kept
// populated as legacy = `twins[0]` for ≥1 OSS CLI release. FDRS-613: `twins`
// adopted from pome-cloud so a cloud-issued Session / SessionPublic parses here.
export const sessionSchema = z.object({
  id: z.string(),                              // ses_<nanoid>
  team_id: z.string(),
  api_key_id: z.string().nullable(),           // null if dashboard-launched
  twin_type: z.string(),                       // legacy: equals twins[0] in M3+; kept for one CLI release
  twins: z.array(z.string()).min(1),           // M3: authoritative list of mounted twins for this session
  state: sessionStateSchema,
  twin_url: z.string().url().nullable(),       // populated when state='ready'
  pod_id: z.string().nullable(),               // INTERNAL: which pool pod served — never on public API responses
  created_at: z.string().datetime(),
  ready_at: z.string().datetime().nullable(),
  expires_at: z.string().datetime(),           // TTL, default created_at + 30min
  closed_at: z.string().datetime().nullable(),
});
export type Session = z.infer<typeof sessionSchema>;

// Public API response shape — strips internal infrastructure fields per /plan-eng-review.
// `GET /v1/sessions/{id}` and `GET /v1/sessions` return SessionPublic.
// Internal orchestrator endpoints use the full Session shape.
export const sessionPublicSchema = sessionSchema.omit({
  pod_id: true,
  api_key_id: true,
});
export type SessionPublic = z.infer<typeof sessionPublicSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// 3. SCENARIOS — adopted verbatim from oslo/pome/src/scenario/scenarioSchema.ts
//
// `criterionSchema` and `judgeModelSchema` were moved to `./run.ts` (2026-05-11
// split) because CriterionResult depends on them; re-exported above via barrel.
// ─────────────────────────────────────────────────────────────────────────────

export const scenarioConfigSchema = z.object({
  twins: z.array(z.string()).default(["github"]),
  timeout: z.number().int().positive().default(60),         // seconds
  runs: z.number().int().positive().default(1),
  passThreshold: z.number().min(0).max(100).default(100),
  judge: judgeModelSchema.default("claude-haiku-4-5"),       // CLI's BYOK config decides which endpoint serves this
});
export type ScenarioConfig = z.infer<typeof scenarioConfigSchema>;

// SeedState — adopted as-is from oslo (nested shape; matches OSS code).
// Future twins (Linear, Slack) will add their own seed shapes; we union those
// in here as the family grows.
export const githubSeedStateSchema = z.object({
  repositories: z
    .array(
      z.object({
        owner: z.string().min(1),
        name: z.string().min(1),
        description: z.string().optional(),
        labels: z
          .array(
            z.object({
              name: z.string().min(1),
              color: z.string().default("ededed"),
              description: z.string().default(""),
            })
          )
          .default([]),
        collaborators: z.array(z.string().min(1)).default([]),
        issues: z
          .array(
            z.object({
              number: z.number().int().positive(),
              title: z.string().min(1),
              body: z.string().default(""),
              state: z.enum(["open", "closed"]).default("open"),
              labels: z.array(z.string().min(1)).default([]),
              assignee: z.string().nullable().default(null),
            })
          )
          .default([]),
      })
    )
    .min(1),
});
export type GithubSeedState = z.infer<typeof githubSeedStateSchema>;

export const stripeSeedStateSchema = z.object({
  api_keys: z
    .array(
      z.object({
        key: z.string().min(1).default("sk_test_pome_default"),
        sid: z.string().min(1).default("default"),
        account_id: z.string().min(1).optional(),
      })
    )
    .default([]),
  customers: z.array(z.record(z.string(), z.unknown())).default([]),
  products: z.array(z.record(z.string(), z.unknown())).default([]),
  prices: z.array(z.record(z.string(), z.unknown())).default([]),
  payment_intents: z.array(z.record(z.string(), z.unknown())).default([]),
  charges: z.array(z.record(z.string(), z.unknown())).default([]),
  events: z.array(z.record(z.string(), z.unknown())).default([]),
  balances: z.array(z.record(z.string(), z.unknown())).default([]),
});
export type StripeSeedState = z.infer<typeof stripeSeedStateSchema>;

export const slackSeedStateSchema = z.object({
  team: z
    .object({
      id: z.string().regex(/^T[A-Z0-9_]+$/).optional(),
      name: z.string().default("Pome Twin Workspace"),
      domain: z.string().default("pome-twin"),
    })
    .prefault({}),
  users: z
    .array(
      z.object({
        id: z.string().regex(/^[UB][A-Z0-9_]+$/).optional(),
        name: z.string().min(1),
        real_name: z.string().default(""),
        email: z.string().email().optional(),
        is_bot: z.boolean().default(false),
        is_admin: z.boolean().default(false),
        tz: z.string().default("America/Los_Angeles"),
        profile: z.record(z.string(), z.unknown()).default({}),
      })
    )
    .default([]),
  channels: z
    .array(
      z.object({
        id: z.string().regex(/^[CGDM][A-Z0-9_]+$/).optional(),
        name: z.string().regex(/^[a-z0-9_-]{1,80}$/),
        is_private: z.boolean().default(false),
        topic: z.string().default(""),
        purpose: z.string().default(""),
        creator: z.string().optional(),
        members: z.array(z.string()).default([]),
        messages: z
          .array(
            z.object({
              ts: z.string().optional(),
              user: z.string(),
              text: z.string(),
              thread_ts: z.string().optional(),
              reactions: z
                .array(z.object({ name: z.string(), user: z.string() }))
                .default([]),
            })
          )
          .default([]),
      })
    )
    .default([]),
});
export type SlackSeedState = z.infer<typeof slackSeedStateSchema>;

export const providerScopedSeedStateSchema = z
  .object({
    github: z.object({ seed: githubSeedStateSchema }).optional(),
    stripe: z.object({ seed: stripeSeedStateSchema }).optional(),
    slack: z.object({ seed: slackSeedStateSchema }).optional(),
  })
  .refine((value) => Boolean(value.github || value.stripe || value.slack), {
    message: "seedState must include github.seed, stripe.seed, slack.seed, or the legacy GitHub seed shape",
  });

// SeedState accepts the legacy GitHub shape and the provider-scoped shape
// used by GitHub + Stripe scenario templates.
export const seedStateSchema = z.union([githubSeedStateSchema, providerScopedSeedStateSchema]);
export type SeedState = z.infer<typeof seedStateSchema>;

export const scenarioSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  setup: z.string().default(""),               // human-readable prose; ignored at runtime
  prompt: z.string().min(1),
  expectedBehavior: z.string().default(""),    // evaluator-only, NEVER sent to agent
  criteria: z.array(criterionSchema).min(1),
  config: scenarioConfigSchema,
  seedState: seedStateSchema,
});
export type Scenario = z.infer<typeof scenarioSchema>;

// Persisted Scenario row (dashboard upload path). Per 04-data-model.md.
export const persistedScenarioSchema = z.object({
  id: z.string(),                              // scn_<nanoid>
  team_id: z.string(),
  name: z.string(),
  source: z.string(),                          // raw markdown
  source_hash: z.string(),                     // sha256(source)
  uploaded_by: z.string(),                     // user_id
  created_at: z.string().datetime(),
  archived_at: z.string().datetime().nullable(),
});
export type PersistedScenario = z.infer<typeof persistedScenarioSchema>;

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
export const createSessionRequestSchema = z
  .object({
    twins: z.array(z.string()).min(1).default(["github"]),
    scenario_source: z.string().optional(),    // base64-encoded UTF-8 markdown
    scenario_id: z.string().optional(),        // alternative: stored scenario
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
  })
  .refine(
    (v) => Boolean(v.scenario_source) !== Boolean(v.scenario_id),
    { message: "Provide exactly one of scenario_source or scenario_id" }
  );
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

// M3 response shape: one session, N twins, one set of URLs per twin under
// `per_twin{}`. Legacy single-twin fields `twin_url` + `openapi_url` continue
// to be populated as `per_twin[twins[0]].api_url` / `.openapi_url` for ≥1 OSS
// CLI release. `session_token` is the public token used in URLs — same value as
// `session_id` in V1, but named separately so URL-shaped consumers stop reading
// internal-id-shaped fields. Both `session_token` and `per_twin` reconciled
// from pome-cloud /v1 wire truth (FDRS-613).
export const createSessionResponseSchema = z.object({
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
});
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;

// POST /v1/sessions/{id}/result — SYNCHRONOUS. CLI scores locally (BYOK Flavor #1) then POSTs.
//
// Cloud never sees the customer's LLM key, never invokes any LLM provider,
// never holds `agent_stdout` (which would contain the agent's prompts and
// completions). Trace blobs (twin's HTTP request/response captures) ARE
// uploaded — those are the agent's tool calls against the twin, not LLM data.
export const submitResultRequestSchema = z.object({
  scenario_name: z.string(),
  scenario_hash: z.string(),
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
  // locally for [P] judge then discards it.
});
export type SubmitResultRequest = z.infer<typeof submitResultRequestSchema>;

export const submitResultResponseSchema = z.object({
  run_id: z.string(),
  dashboard_url: z.string().url(),
});
export type SubmitResultResponse = z.infer<typeof submitResultResponseSchema>;

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

// ─────────────────────────────────────────────────────────────────────────────
// 5. ERROR ENVELOPE (public REST)
// ─────────────────────────────────────────────────────────────────────────────

export const apiErrorTypeSchema = z.enum([
  "invalid_auth",
  "revoked_key",
  "forbidden",                                 // 403 non-auth permission denial
  "quota_exceeded",
  "validation_failed",
  "not_found",
  "session_expired",                           // distinct from not_found for CLI UX
  "conflict",                                  // 409 (uniqueness, etc.)
  "rate_limited",
  "internal_error",
  "endpoint_not_implemented",
  "downstream_unavailable",
]);
export type ApiErrorType = z.infer<typeof apiErrorTypeSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    type: apiErrorTypeSchema,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    documentation_url: z.string().url().optional(),
    request_id: z.string(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// 6. EvaluatorHooks — cross-boundary instrumentation pattern (per ADR-002)
// ─────────────────────────────────────────────────────────────────────────────
//
// Defined in OSS (`cli/src/evaluator/`). The OSS module never imports
// cloud — the hook is a callback the runtime wires up at construction time.
//
// BYOK Flavor #1 means the LLM judge runs CLI-side using the customer's own
// key, so there is NO cloud-side evaluator service in V1 and NO judge-cost
// metering. The only surviving hook is for trace upload, which lets
// hosted-mode CLI POST trace blobs to the cloud API while self-host writes
// them to local disk. Same evaluator code path; different sink.

export interface TraceUploadContext {
  session_id: string;
  trace_jsonl: string;                         // raw jsonl bytes (HTTP calls between agent and twin; NOT LLM prompts)
  state_initial_json: string;
  state_final_json: string;
}

export interface EvaluatorHooks {
  // Returns the storage keys the cloud assigned (or filesystem paths in self-host).
  onTraceUpload?: (ctx: TraceUploadContext) => Promise<{
    trace_s3_key: string;
    state_initial_s3_key: string;
    state_final_s3_key: string;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// END
// ─────────────────────────────────────────────────────────────────────────────
//
// LOCKED DECISIONS (post 2026-04-30 review + BYOK pivot):
//
// • BYOK Flavor #1: judge runs CLI-side; cloud holds no LLM keys.
// • OpenAI-compatible endpoint is the universal LLM contract; CLI accepts
//   {base_url, api_key, model_name} via env or `~/.pome/config`. judge_model
//   is therefore a free-form string, not an enum. Recommended endpoints
//   (OpenRouter, Vercel AI Gateway, LiteLLM, Ollama, raw OpenAI/Anthropic) are
//   listed in docs, not constrained at the schema level.
// • SubmitResult is synchronous (no scoringStatus / poll_url / 202).
// • No /v1/runs/{id}/replay endpoint in V1 — replay is a CLI command
//   (`pome replay <run-id>`) that re-fetches the trace and re-judges locally.
// • No team_integrations table; cloud never stores customer LLM keys.
// • runs.judge_cost_cents removed; runs.judge_tokens_in/out replace it.
// • EvaluatorHooks.onJudgeCall + JudgeCallContext removed.
// • agent_stdout is never uploaded to cloud (privacy posture).
// • DB ID columns: users.id and teams.id use text prefixed nanoids.
// • users.deleted_at and teams.deleted_at dropped (no soft-delete in V1).
// • Quota unit: sessions/month, not session-minutes.
// • API error enum: drop judge_cap_exceeded; add forbidden, conflict,
//   session_expired.
//
// LOCKED DECISIONS (2026-05-11 split — FDRS-318):
//
// • File split: index.ts → index.ts + recorder-events.ts + run.ts.
//   index.ts becomes the barrel + identity/sessions/scenarios/REST/error/hooks.
// • RecorderEvent.twin kept as `z.string().min(1)` for SDK community-twin
//   compatibility (revised mid-implementation from a closed enum after the
//   SDK ergonomics blocker surfaced — see [DECISION] amendment on FDRS-318).
//   `KNOWN_TWIN_IDS = ["github", "stripe"] as const` is exported as the
//   canonical pattern-match set for dashboard rendering. Twin growth no
//   longer requires a shared-types bump.
// • RecorderEvent.state_delta added: { before, after } | null at each leaf.
//   Per-twin row shape NOT enforced (twin owns its row).
// • RecorderEvent.step_id added — correlator-assigned (vs scenario_step_id
//   which is scenario-author-set).
// • RecorderEvent.tool_call_id added — adapter-emitted (null in heuristic path).
// • Run.lanes / Run.steps added — correlator output. Flat parallel arrays.
// • Run.fix_prompt added — CLI-generated (BYOK Flavor #1). Nullable.
// • Run.events_jsonl_url added — S3 URL for V1.5 re-correlate. Nullable
//   (aligns with FDRS-327's `events_jsonl_url text NULL` DB shape; supersedes
//   the FDRS-318 description's `string` typo).
// • submitResultRequestSchema gets lanes/steps/fix_prompt with defaults for
//   pre-M3i CLI backward compat during rollout.
