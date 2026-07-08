// SPDX-License-Identifier: Apache-2.0
/**
 * shared-types — public V1 contract barrel.
 *
 * Owns identity/session/task REST contracts plus re-exports for the trace
 * surface in `recorder-events.ts`, completed-run shape in `run.ts`, and the
 * OpenTelemetry extension surface in `otel/`. Release history and migration
 * notes live in CHANGELOG.md.
 */

import { z } from "zod";
import {
  criterionResultSchema,
  criterionSchema,
  judgeModelSchema,
  laneSchema,
  stepSchema,
} from "./run.js";
import { normalizeTaskVocabKeys } from "./task-vocab.js";

// Barrel re-exports — consumers `import { ... } from "@pome-sh/shared-types"`
// regardless of which leaf file owns the type.
export * from "./recorder-events.js";
export * from "./run.js";
export * from "./task-vocab.js";
export * from "./github-access-control.js";
export * from "./redaction.js";
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
// 3. TASKS (formerly "scenarios") — originally adopted verbatim from
//    oslo/pome/src/scenario/scenarioSchema.ts
//
// W3 vocab (FDRS-653): "task" is the canonical name; the `scenario*` exports
// below are deprecated aliases kept for the 0.3.0 window (FDRS-654 swaps the
// consumers).
//
// `criterionSchema` and `judgeModelSchema` were moved to `./run.ts` (2026-05-11
// split) because CriterionResult depends on them; re-exported above via barrel.
// ─────────────────────────────────────────────────────────────────────────────

export const taskConfigSchema = z.object({
  twins: z.array(z.string()).default(["github"]),
  timeout: z.number().int().positive().default(60),         // seconds
  runs: z.number().int().positive().default(1),
  passThreshold: z.number().min(0).max(100).default(100),
  judge: judgeModelSchema.default("claude-haiku-4-5"),       // CLI's BYOK config decides which endpoint serves this
});
export type TaskConfig = z.infer<typeof taskConfigSchema>;

/** @deprecated FDRS-653 — use `taskConfigSchema`. Removed after the 0.3.0 window. */
export const scenarioConfigSchema = taskConfigSchema;
/** @deprecated FDRS-653 — use `TaskConfig`. */
export type ScenarioConfig = TaskConfig;

// SeedState — adopted as-is from oslo (nested shape; matches OSS code).
// Future twins (Linear, Slack) will add their own seed shapes; we union those
// in here as the family grows.
//
// FDRS-653 (ported from pome-cloud): this schema used to model only the
// issue-triage subset (repositories[].{issues,labels,collaborators}). Anywhere
// it is used as a narrowing boundary, a field MISSING here is silently
// zod-stripped before it reaches the twin pod's own parseSeed — which is
// exactly how PR-based scenarios lost their `users`, `pull_requests`, and
// `files` and booted into an empty repo (the agent saw `GET /pulls → []`).
// The full GitHub world (top-level users, default_branch, files,
// pull_requests with reviews/statuses) is modeled below, matching the
// canonical twin-github seed shape.
export const githubSeedStateSchema = z.object({
  users: z
    .array(
      z.object({
        login: z.string().min(1),
        type: z.enum(["User", "Organization"]).default("User"),
        name: z.string().default(""),
      })
    )
    .optional(),
  repositories: z
    .array(
      z.object({
        owner: z.string().min(1),
        name: z.string().min(1),
        description: z.string().optional(),
        default_branch: z.string().min(1).optional(),
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
        files: z
          .array(
            z.object({
              path: z.string().min(1),
              content: z.string(),
              branch: z.string().optional(),
            })
          )
          .optional(),
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
        pull_requests: z
          .array(
            z.object({
              number: z.number().int().positive().optional(),
              title: z.string().min(1),
              body: z.string().default(""),
              head: z.string().min(1),
              base: z.string().min(1).default("main"),
              state: z.enum(["open", "closed"]).default("open"),
              author: z.string().min(1).optional(),
              // Reviews seeded on this PR. State mirrors GitHub's review state
              // enum; author must exist in users or collaborators.
              reviews: z
                .array(
                  z.object({
                    author: z.string().min(1),
                    state: z
                      .enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED"])
                      .default("APPROVED"),
                    body: z.string().default(""),
                  })
                )
                .default([]),
              // Commit statuses on the PR head SHA, wired into commit_statuses
              // so get_pull_request_status and merge_pull_request see them.
              statuses: z
                .array(
                  z.object({
                    context: z.string().min(1).default("ci/build"),
                    state: z
                      .enum(["error", "failure", "pending", "success"])
                      .default("success"),
                    description: z.string().default(""),
                  })
                )
                .default([]),
            })
          )
          .optional(),
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

// The parsed task (formerly "scenario") markdown shape. Criterion kinds inside
// `criteria` normalize D→code, P→model (tolerant reader, FDRS-653).
export const taskSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  setup: z.string().default(""),               // human-readable prose; ignored at runtime
  prompt: z.string().min(1),
  expectedBehavior: z.string().default(""),    // evaluator-only, NEVER sent to agent
  criteria: z.array(criterionSchema).min(1),
  config: taskConfigSchema,
  seedState: seedStateSchema,
});
export type Task = z.infer<typeof taskSchema>;

/** @deprecated FDRS-653 — use `taskSchema`. Removed after the 0.3.0 window. */
export const scenarioSchema = taskSchema;
/** @deprecated FDRS-653 — use `Task`. */
export type Scenario = Task;

// Persisted Task row (dashboard upload path; cloud DB `tasks` table). Per
// 04-data-model.md. Row ids keep the historical `scn_` prefix (persisted data;
// renaming ids is a data migration, deliberately NOT part of FDRS-653).
export const persistedTaskSchema = z.object({
  id: z.string(),                              // scn_<nanoid>
  team_id: z.string(),
  name: z.string(),
  source: z.string(),                          // raw markdown
  source_hash: z.string(),                     // sha256(source)
  uploaded_by: z.string(),                     // user_id
  created_at: z.string().datetime(),
  archived_at: z.string().datetime().nullable(),
});
export type PersistedTask = z.infer<typeof persistedTaskSchema>;

/** @deprecated FDRS-653 — use `persistedTaskSchema`. Removed after the 0.3.0 window. */
export const persistedScenarioSchema = persistedTaskSchema;
/** @deprecated FDRS-653 — use `PersistedTask`. */
export type PersistedScenario = PersistedTask;

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

// /v1/sessions/:id/finalize — ADR-013 managed-judge response.
export const finalizeResponseSchema = z.object({
  run_id: z.string(),
  score: z.number().int().min(0).max(100),
  judge_model: z.string().nullable().optional(),
  dashboard_url: z.string().url(),
  criteria_results: z.array(criterionResultSchema).optional(),
});
export type FinalizeResponse = z.infer<typeof finalizeResponseSchema>;

export const criterionDefSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  kind: z.enum(["D", "P"]),
});
export type CriterionDef = z.infer<typeof criterionDefSchema>;

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

