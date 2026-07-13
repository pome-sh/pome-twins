// SPDX-License-Identifier: Apache-2.0
//
// shared-types — /v1/sessions/:id/finalize response family (part of §4 PUBLIC
// REST API). ADR-013 managed-judge synchronous result plus the F-700 async
// `Prefer: respond-async` accepted/status/union shapes. Re-exported through the
// `@pome-sh/shared-types` barrel (index.ts).

import { z } from "zod";
import { criterionResultSchema } from "./run.js";
import { criterionDefSchema, perTwinStateKeysSchema } from "./rest.js";

// POST /v1/sessions/:id/finalize — ADR-013 managed-judge REQUEST. This is the
// LIVE scoring wire: the CLI (cli/src/hosted/client.ts `finalize`) uploads trace
// / state / signals blobs via the presigned upload-url routes, then POSTs the
// criterion *definitions* plus the storage KEYS here; the cloud runs the managed
// judge and returns `finalizeInitialResponseSchema`. (The sibling
// `submitResultRequestSchema` in rest.ts is the DEPRECATED BYOK shim that scores
// CLI-side and uploads inline state_*_json_b64.)
//
// Not `.strict()`: a tolerant reader that strips unknown additive keys, matching
// the rest of the §4 request/response family. Field set mirrors the CLI body
// exactly — `scenario_*` vocab (finalize does not take the W3 `task_*` aliases),
// storage keys optional (cloud falls back to conventional paths when omitted).
export const finalizeRequestSchema = z.object({
  stop_reason: z.string(),                       // "completed" | "timeout" | "preflight_failed" | …
  exit_code: z.number().int(),
  duration_ms: z.number().int(),
  agent_model: z.string(),
  agent_sdk: z.string().nullable(),              // normalizeAgentSdk() output: trimmed string or null
  // Criterion DEFINITIONS (not results): cloud judges these against the recorded
  // trace/state and returns the authoritative score. Carries optional per-criterion
  // twin attribution (multi-twin M3).
  criteria: z.array(criterionDefSchema),
  scenario_name: z.string(),
  scenario_hash: z.string(),
  scenario_prompt: z.string(),
  expected_behavior: z.string(),
  // Optional storage-key overrides; omitted keys fall back to the conventional
  // team-<>/session-<>/<filename> paths written by the *-upload-url routes.
  trace_storage_key: z.string().optional(),
  state_initial_storage_key: z.string().optional(),
  state_final_storage_key: z.string().optional(),
  signals_storage_key: z.string().optional(),
  // Multi-twin (M3): additive per-twin state storage keys, keyed by twin id.
  // Absent on single-twin sessions, which use the flat state_*_storage_key fields
  // above. Unknown to an older cloud, which strips it and scores the primary twin
  // unchanged (new CLI × old cloud degrades gracefully).
  per_twin_state_keys: perTwinStateKeysSchema.optional(),
});
export type FinalizeRequest = z.infer<typeof finalizeRequestSchema>;

// /v1/sessions/:id/finalize — ADR-013 managed-judge response.
// Not `.strict()`: cloud may emit additive M7 keys (`evaluator_version`,
// `criteria_breakdown`, `all_skipped`, `provenance`) that older/newer CLIs
// strip rather than reject.
export const finalizeResponseSchema = z.object({
  run_id: z.string(),
  score: z.number().int().min(0).max(100),
  judge_model: z.string().nullable().optional(),
  dashboard_url: z.string().url(),
  criteria_results: z.array(criterionResultSchema).optional(),
});
export type FinalizeResponse = z.infer<typeof finalizeResponseSchema>;

// F-700: `status_url` is a same-origin absolute URL *or* an absolute-path
// relative URL (cloud returns `/v1/sessions/:id/evaluation`).
export const finalizeStatusUrlSchema = z
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
export type FinalizeStatusUrl = z.infer<typeof finalizeStatusUrlSchema>;

// POST /v1/sessions/:id/finalize with `Prefer: respond-async`.
// The legacy scored response remains in the initial-response union for the
// synchronous N-1 compatibility window.
export const finalizeAcceptedResponseSchema = z.object({
  evaluation_id: z.string().min(1),
  run_id: z.string().min(1),
  status: z.literal("queued"),
  status_url: finalizeStatusUrlSchema,
}).strict();
export type FinalizeAcceptedResponse = z.infer<
  typeof finalizeAcceptedResponseSchema
>;

const finalizeStatusIdentitySchema = {
  evaluation_id: z.string().min(1),
  run_id: z.string().min(1),
};

export const finalizeQueuedStatusResponseSchema = z.object({
  ...finalizeStatusIdentitySchema,
  status: z.literal("queued"),
}).strict();
export type FinalizeQueuedStatusResponse = z.infer<
  typeof finalizeQueuedStatusResponseSchema
>;

export const finalizeRunningStatusResponseSchema = z.object({
  ...finalizeStatusIdentitySchema,
  status: z.literal("running"),
}).strict();
export type FinalizeRunningStatusResponse = z.infer<
  typeof finalizeRunningStatusResponseSchema
>;

// F-700 wire error on GET .../evaluation failed status.
export const finalizeFailureErrorSchema = z.object({
  type: z.string().min(1),
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type FinalizeFailureError = z.infer<
  typeof finalizeFailureErrorSchema
>;

export const finalizeFailedStatusResponseSchema = z.object({
  ...finalizeStatusIdentitySchema,
  status: z.literal("failed"),
  error: finalizeFailureErrorSchema,
}).strict();
export type FinalizeFailedStatusResponse = z.infer<
  typeof finalizeFailedStatusResponseSchema
>;

export const finalizeCompletedStatusResponseSchema = z.object({
  ...finalizeStatusIdentitySchema,
  status: z.literal("completed"),
  result: finalizeResponseSchema,
}).strict();
export type FinalizeCompletedStatusResponse = z.infer<
  typeof finalizeCompletedStatusResponseSchema
>;

export const finalizeStatusResponseSchema = z.discriminatedUnion("status", [
  finalizeQueuedStatusResponseSchema,
  finalizeRunningStatusResponseSchema,
  finalizeFailedStatusResponseSchema,
  finalizeCompletedStatusResponseSchema,
]);
export type FinalizeStatusResponse = z.infer<
  typeof finalizeStatusResponseSchema
>;

export const finalizeInitialResponseSchema = z.union([
  finalizeResponseSchema,
  finalizeAcceptedResponseSchema,
]);
export type FinalizeInitialResponse = z.infer<
  typeof finalizeInitialResponseSchema
>;
