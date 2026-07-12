// SPDX-License-Identifier: Apache-2.0
/**
 * shared-types — public V1 contract barrel.
 *
 * Owns identity/session/task REST contracts plus re-exports for the trace
 * surface in `recorder-events.ts`, completed-run shape in `run.ts`, and the
 * OpenTelemetry extension surface in `otel/`. Release history and migration
 * notes live in CHANGELOG.md.
 *
 * This file is a THIN BARREL (F-754): it re-exports only. The contract clusters
 * live in topical leaf modules — identity/sessions/seed-state/task/rest/
 * finalize-shapes/errors/evaluator-hooks — each re-exported here with identical
 * names so `import { ... } from "@pome-sh/shared-types"` is unchanged.
 */

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

// V1 contract clusters (F-754 split out of this file, zero behavior change):
export * from "./identity.js";          // §1 IDENTITY
export * from "./sessions.js";          // §2 SESSIONS
export * from "./seed-state.js";        // §3 TASKS — provider seed-state schemas
export * from "./task.js";              // §3 TASKS — task config / task / persisted-task
export * from "./rest.js";              // §4 PUBLIC REST API (minus finalize family)
export * from "./finalize-shapes.js";   // §4 PUBLIC REST API — /finalize response family
export * from "./errors.js";            // §5 ERROR ENVELOPE
export * from "./evaluator-hooks.js";   // §6 EvaluatorHooks
