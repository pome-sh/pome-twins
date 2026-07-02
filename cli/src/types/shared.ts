// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

export const stateDeltaSchema = z
  .object({
    before: z.record(z.string(), z.unknown()).nullable(),
    after: z.record(z.string(), z.unknown()).nullable(),
  })
  .nullable();
export type StateDelta = z.infer<typeof stateDeltaSchema>;

export const recorderEventSchema = z.object({
  ts: z.string().datetime(),
  run_id: z.string().min(1),
  twin: z.string().min(1),
  request_id: z.string().min(1),
  correlation_id: z.string().min(1).optional(),
  scenario_step_id: z.string().min(1).nullable().optional(),
  step_id: z.string().nullable(),
  tool_call_id: z.string().nullable(),
  method: z.string().min(1),
  path: z.string(),
  request_body: z.unknown(),
  status: z.number().int(),
  response_body: z.unknown(),
  latency_ms: z.number().int().min(0),
  fidelity: z.enum(["semantic", "unsupported"]),
  state_mutation: z.boolean(),
  state_delta: stateDeltaSchema,
  idempotency_dedupe: z.boolean().optional(),
  error: z.string().nullable(),
});
export type RecorderEvent = z.infer<typeof recorderEventSchema>;

// FDRS-398 — unified events.jsonl discriminated-union schema (v1).
// Mirrors @pome-sh/shared-types `eventSchema`; kept local so the CLI's vendored
// shared-types pin doesn't gate the inspect reader migration. When the vendor
// tarball is refreshed past 0.3.0, swap this for the barrel re-export.

const eventBaseShape = {
  ts: z.string().datetime(),
  event_id: z.string().min(1),
  parent_id: z.string().min(1).nullable(),
} as const;

export const twinHttpEventSchema = recorderEventSchema.extend({
  kind: z.literal("TwinHttpEvent"),
  event_id: z.string().min(1),
  parent_id: z.string().min(1).nullable(),
});
export type TwinHttpEvent = z.infer<typeof twinHttpEventSchema>;

export const llmCallEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal("LlmCallEvent"),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  latency_ms: z.number().int().min(0),
  bytes_in: z.number().int().min(0),
  bytes_out: z.number().int().min(0),
  url: z.string().nullable(),
  method: z.string().nullable(),
  status: z.number().int().nullable(),
  model: z.string().nullable(),
  prompt_tokens: z.number().int().min(0).nullable(),
  completion_tokens: z.number().int().min(0).nullable(),
  cost_usd: z.number().nullable(),
});
export type LlmCallEvent = z.infer<typeof llmCallEventSchema>;

export const toolUseEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal("ToolUseEvent"),
  tool_use_id: z.string().min(1),
  tool_name: z.string().min(1),
  input: z.unknown(),
});
export type ToolUseEvent = z.infer<typeof toolUseEventSchema>;

export const toolResultEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal("ToolResultEvent"),
  tool_use_id: z.string().min(1),
  output: z.unknown(),
  is_error: z.boolean(),
});
export type ToolResultEvent = z.infer<typeof toolResultEventSchema>;

export const subagentSpawnEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal("SubagentSpawnEvent"),
  parent_tool_use_id: z.string().min(1),
});
export type SubagentSpawnEvent = z.infer<typeof subagentSpawnEventSchema>;

export const hookEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal("HookEvent"),
  hook_name: z.string().min(1),
  tool_name: z.string().min(1).nullable(),
});
export type HookEvent = z.infer<typeof hookEventSchema>;

export const eventSchema = z.discriminatedUnion("kind", [
  twinHttpEventSchema,
  llmCallEventSchema,
  toolUseEventSchema,
  toolResultEventSchema,
  subagentSpawnEventSchema,
  hookEventSchema,
]);
export type Event = z.infer<typeof eventSchema>;

// A new-shape row always carries a string `kind` discriminator. Non-object
// rows, or rows missing `kind`, route through the legacy path so the caller
// can surface a clearer error than the discriminated union's parse failure.
export function isLegacyEventRow(row: unknown): boolean {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    return false;
  }
  return typeof (row as Record<string, unknown>).kind !== "string";
}

export const criterionSchema = z.object({
  type: z.enum(["D", "P"]),
  text: z.string().min(1),
});

const baseCriterionResultSchema = z.object({
  criterion: criterionSchema,
  // FDRS-591/611: additive four-state outcome. OPTIONAL for wire compat —
  // older producers omit it and consumers derive it from passed/skipped.
  // `skipped` stays true for both skipped + errored outcomes.
  outcome: z.enum(["passed", "failed", "skipped", "errored"]).optional(),
  passed: z.boolean(),
  skipped: z.boolean(),
  reason: z.string(),
});

export const criterionResultSchema = z.union([
  baseCriterionResultSchema.extend({
    confidence: z.number().min(0).max(1),
    judge_model: z.string().min(1),
  }),
  baseCriterionResultSchema,
]);
export type CriterionResult = z.infer<typeof criterionResultSchema>;

export const stepSchema = z.object({
  id: z.string(),
  started_at: z.string().datetime(),
  ended_at: z.string().datetime(),
  label: z.string().nullable(),
  lane_ids: z.array(z.string()),
});
export type Step = z.infer<typeof stepSchema>;

export const laneSchema = z.object({
  id: z.string(),
  step_id: z.string(),
  twin: z.string().min(1),
  label: z.string().nullable(),
  request_ids: z.array(z.string()),
});
export type Lane = z.infer<typeof laneSchema>;

export const perTwinUrlsSchema = z.object({
  api_url: z.string().url(),
  mcp_url: z.string().url(),
  openapi_url: z.string().url(),
});
export type PerTwinUrls = z.infer<typeof perTwinUrlsSchema>;

export const createSessionResponseSchema = z.object({
  session_id: z.string(),
  /** Present on current control plane; same as session_id in V1 when absent. */
  session_token: z.string().optional(),
  twin_url: z.string().url(),
  expires_at: z.string().datetime(),
  agent_token: z.string(),
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
    })
    .default({}),
  openapi_url: z.string().url(),
  per_twin: z.record(z.string(), perTwinUrlsSchema).optional(),
});
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;

export const sessionPublicSchema = z.object({
  id: z.string(),
  team_id: z.string(),
  twin_type: z.string(),
  twins: z.array(z.string()),
  state: z.string(),
  twin_url: z.string().nullable(),
  created_at: z.string(),
  ready_at: z.string().nullable(),
  expires_at: z.string(),
  closed_at: z.string().nullable(),
  // F26 — when a session terminates, the dashboard wants to distinguish
  // "user stopped" from "TTL elapsed" from "cloud revoked". Cloud will
  // populate this on terminal states; older cloud builds omit it, hence
  // optional. Free-form for forward compat.
  expired_reason: z.string().optional(),
});
export type SessionPublic = z.infer<typeof sessionPublicSchema>;

export const submitResultResponseSchema = z.object({
  run_id: z.string(),
  dashboard_url: z.string().url(),
});
export type SubmitResultResponse = z.infer<typeof submitResultResponseSchema>;

// /v1/sessions/:id/finalize — ADR-013 successor to /result. Cloud judges
// authoritatively via AI Gateway and returns the score the dashboard
// records. Mirrors pome-cloud's `buildResponse()` in
// apps/control-plane/src/routes/finalize.ts. `judge_model` is nullable so
// the idempotent-replay path (which surfaces whatever the existing run row
// stored) doesn't reject.
export const finalizeResponseSchema = z.object({
  run_id: z.string(),
  score: z.number().int().min(0).max(100),
  judge_model: z.string().nullable().optional(),
  dashboard_url: z.string().url(),
  // F0-3 / L5 — Session A added `criteria_results[]` to `/finalize`'s
  // response body so `pome fix-prompt` and `pome inspect` can render the
  // per-criterion verdicts for hosted runs without a follow-up GET.
  // Optional during the rollout window where older cloud builds don't
  // emit it yet; presence-detect at the call site.
  criteria_results: z.array(criterionResultSchema).optional(),
});
export type FinalizeResponse = z.infer<typeof finalizeResponseSchema>;

export const criterionDefSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  kind: z.enum(["D", "P"]),
});
export type CriterionDef = z.infer<typeof criterionDefSchema>;
