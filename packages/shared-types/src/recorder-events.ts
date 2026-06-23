// SPDX-License-Identifier: Apache-2.0
/**
 * recorder-events — twin runtime trace format
 *
 * Single source of truth for the per-request event a twin runtime emits into
 * its recorder ring buffer. Consumed by:
 *   - twin runtimes (`@pome-sh/twin-github`, `@pome-sh/twin-stripe`) — emit shape
 *   - `@pome-sh/sdk` — read shape for post-run analysis
 *   - `@pome-sh/correlator` — input to `correlateAdapterRich` / `correlateHeuristic`
 *   - `pome-cloud` recorder writers — persisted shape for events.jsonl S3 blob
 *
 * v1.0 freeze of the twin runtime trace format. Breaking changes go through a
 * documented deprecation policy.
 */

import { z } from "zod";

// `twin` is an open string at the schema level so SDK-based community twins
// can set their own id without forcing a shared-types schema bump. Dashboard
// rendering pattern-matches against `KNOWN_TWIN_IDS` and falls back to
// generic rendering for unknown values — losing a recording to parse failure
// would be worse than rendering it generically. First-party twins SHOULD use
// the canonical values for type-aware UI.
export const KNOWN_TWIN_IDS = ["github", "stripe", "slack"] as const;
export type KnownTwinId = (typeof KNOWN_TWIN_IDS)[number];

export const twinIdSchema = z.string().min(1);
export type TwinId = z.infer<typeof twinIdSchema>;

export const recorderFidelitySchema = z.enum(["semantic", "unsupported"]);
export type RecorderFidelity = z.infer<typeof recorderFidelitySchema>;

// stateDelta captures the row-level before/after for a mutation. State-inspector
// renders these as a key/value diff. `before: null` = row was inserted (no prior
// state); `after: null` = row was deleted. Parent `null` = no mutation (read-only
// call — should also have `state_mutation: false`). Per-twin types are NOT
// enforced — each twin owns its row shape, and forcing a strong type here would
// couple shared-types to twin schemas.
export const stateDeltaSchema = z
  .object({
    before: z.record(z.string(), z.unknown()).nullable(),
    after: z.record(z.string(), z.unknown()).nullable(),
  })
  .nullable();
export type StateDelta = z.infer<typeof stateDeltaSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Legacy single-shape recorder event (pre-FDRS-398).
//
// Kept exported as-is for the 58 callers across twin runtimes, SDK, correlator,
// CLI, and cloud control plane that still emit/consume this shape on disk.
// Their migration to the unified discriminated-union `eventSchema` below is
// owned by downstream M0 tickets (FDRS-402 / 403 / 412 / 415 / 417).
// `isLegacyEventRow` lets readers detect this shape during the rollout.
// ─────────────────────────────────────────────────────────────────────────────

export const recorderEventSchema = z.object({
  ts: z.string().datetime(),
  run_id: z.string().min(1),
  twin: twinIdSchema,
  request_id: z.string().min(1),
  correlation_id: z.string().min(1).optional(),
  // scenario_step_id is set by the scenario author in .yaml (static expectation:
  // "this HTTP call is expected at step 2"). step_id below is set post-hoc by
  // the correlator (dynamic grouping: "this event landed in Step stp_xyz").
  // 90% of events use only one; both can coexist.
  scenario_step_id: z.string().min(1).nullable().optional(),
  step_id: z.string().nullable(),
  // tool_call_id is set by the `@pome-sh/adapter-claude-sdk` adapter when active.
  // Null for the heuristic-correlator path (no adapter signal available).
  tool_call_id: z.string().nullable(),
  method: z.string().min(1),
  path: z.string(),
  request_body: z.unknown(),
  status: z.number().int(),
  response_body: z.unknown(),
  latency_ms: z.number().int().min(0),
  fidelity: recorderFidelitySchema,
  state_mutation: z.boolean(),
  state_delta: stateDeltaSchema,
  // True iff the twin's idempotency layer replayed a cached response without
  // re-invoking the handler. Optional + additive so existing recordings parse
  // unchanged; dashboards/SDKs can render dedupe hits distinctly without
  // inferring from request_body. Absent on the original mutation, present and
  // true on the replayed event.
  idempotency_dedupe: z.boolean().optional(),
  error: z.string().nullable(),
});
export type RecorderEvent = z.infer<typeof recorderEventSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// FDRS-398 — unified events.jsonl discriminated-union schema (v1).
//
// Hard-cut from the legacy single-shape `RecorderEvent`. The on-disk row is
// now a tagged union over `kind`. Every variant carries:
//   - `event_id`  — unique row id (uuid/nanoid, set by emitter)
//   - `parent_id` — points at the spawning row's `event_id`, or null at the
//                   root of a parent chain (e.g. top-level twin HTTP calls,
//                   the first LLM call in a turn).
//   - `kind`      — the discriminator literal (see each schema below)
//
// Provenance:
//   - PR/FAQ: linear.app/pome-sh/project/agent-trace-v1-af8924d607f0
//   - Milestone M0 "Universal Floor"
//   - /plan-eng-review 2026-05-26 amendments:
//       • Dropped OtelSpanEvent from this frozen v1 union (FDRS-400 cancelled).
//         It later shipped additively (FDRS-480): the schema + mapper live in
//         `./otel/` and are composed into `otelEventSchema` (= eventSchema ∪
//         OtelSpanEvent). This v1 union is intentionally left unchanged.
//       • LlmCallEvent per-call token/model/cost reclassified
//         "TLS-terminate-only" — they are `nullable()` across both baseline
//         CONNECT-tunnel mode AND CAS adapter mode in v1. CAS surfaces those
//         at the per-turn aggregate level on the run summary, NOT here.
// ─────────────────────────────────────────────────────────────────────────────

// Common fields on every event variant. Spread (not extend) so the resulting
// Zod object types stay readable.
const eventBaseShape = {
  ts: z.string().datetime(),
  event_id: z.string().min(1),
  parent_id: z.string().min(1).nullable(),
} as const;

// `TwinHttpEvent` is the legacy RecorderEvent shape extended with the union
// discriminator + parent-chain fields. `extend` keeps it in lockstep with
// `recorderEventSchema` so updates to the underlying HTTP-call shape flow
// through automatically.
export const twinHttpEventSchema = recorderEventSchema.extend({
  kind: z.literal("TwinHttpEvent"),
  event_id: z.string().min(1),
  parent_id: z.string().min(1).nullable(),
});
export type TwinHttpEvent = z.infer<typeof twinHttpEventSchema>;

// `LlmCallEvent` baseline fields are populated by the HTTP_PROXY CONNECT
// tunnel `pome capture-server` (M0). TLS-terminate-only fields stay null in
// baseline mode and in CAS adapter mode; they get populated only by the v2
// opt-in TLS-terminate proxy. Per-turn aggregate cost/model from CAS lives
// on the run summary, not on individual LlmCallEvent rows.
export const llmCallEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal("LlmCallEvent"),
  // Baseline (always populated)
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  latency_ms: z.number().int().min(0),
  bytes_in: z.number().int().min(0),
  bytes_out: z.number().int().min(0),
  // TLS-terminate-only — nullable, not optional. Writers must emit explicit
  // null in baseline/CAS mode so the on-disk JSON shape is stable.
  url: z.string().nullable(),
  method: z.string().nullable(),
  status: z.number().int().nullable(),
  model: z.string().nullable(),
  prompt_tokens: z.number().int().min(0).nullable(),
  completion_tokens: z.number().int().min(0).nullable(),
  cost_usd: z.number().nullable(),
});
export type LlmCallEvent = z.infer<typeof llmCallEventSchema>;

// `ToolUseEvent` — emitted by the CAS adapter (FDRS-408) for each tool_use
// content block in an `SDKAssistantMessage`. `input` is opaque (already
// redactor-scrubbed by the writer) so we type it as `unknown`.
export const toolUseEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal("ToolUseEvent"),
  tool_use_id: z.string().min(1),
  tool_name: z.string().min(1),
  input: z.unknown(),
});
export type ToolUseEvent = z.infer<typeof toolUseEventSchema>;

// `ToolResultEvent` — emitted by the CAS adapter (FDRS-408) for each
// tool_result content block in a user message. `tool_use_id` matches the
// originating `ToolUseEvent.tool_use_id`; `parent_id` typically points at
// that ToolUseEvent's `event_id`.
export const toolResultEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal("ToolResultEvent"),
  tool_use_id: z.string().min(1),
  output: z.unknown(),
  is_error: z.boolean(),
});
export type ToolResultEvent = z.infer<typeof toolResultEventSchema>;

// `SubagentSpawnEvent` — emitted once per sub-agent (FDRS-409), the first
// time the adapter sees a non-null `parent_tool_use_id` on an
// `SDKAssistantMessage`.
export const subagentSpawnEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal("SubagentSpawnEvent"),
  parent_tool_use_id: z.string().min(1),
});
export type SubagentSpawnEvent = z.infer<typeof subagentSpawnEventSchema>;

// `HookEvent` — thin audit-trail row written by the adapter for each of the
// SDK's 25 hook invocations (FDRS-407). `tool_name` is null when the hook
// isn't tool-scoped (e.g. SessionStarted, PreCompact, PermissionGranted on a
// non-tool resource).
export const hookEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal("HookEvent"),
  hook_name: z.string().min(1),
  tool_name: z.string().min(1).nullable(),
});
export type HookEvent = z.infer<typeof hookEventSchema>;

// The unified event row. Discriminated on `kind` — adding a future variant
// (e.g. `OtelSpanEvent` in v2) is a non-breaking extension.
export const eventSchema = z.discriminatedUnion("kind", [
  twinHttpEventSchema,
  llmCallEventSchema,
  toolUseEventSchema,
  toolResultEventSchema,
  subagentSpawnEventSchema,
  hookEventSchema,
]);
export type Event = z.infer<typeof eventSchema>;

// Detect a pre-FDRS-398 legacy row on disk. A new-shape row always carries a
// string `kind` discriminator; a legacy row does not. Non-object inputs
// (`null`, arrays, primitives) are not event rows at all — return false so
// the caller surfaces the underlying type error rather than treating them as
// legacy.
//
// A row whose `kind` is present but not a string also routes through the
// legacy path: the discriminated union will reject it with a clear error,
// which is more useful than silently treating it as new-shape.
export function isLegacyEventRow(row: unknown): boolean {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    return false;
  }
  return typeof (row as Record<string, unknown>).kind !== "string";
}
