// SPDX-License-Identifier: Apache-2.0
//
// shared-types §3 — TASKS. Task config, the parsed task markdown shape, and the
// persisted task row, plus their deprecated `scenario*` aliases. The provider
// seed-state schemas consumed by `taskSchema.seedState` live in `./seed-state.ts`.
// Re-exported through the `@pome-sh/shared-types` barrel (index.ts).

import { z } from "zod";
import { criterionSchema, judgeModelSchema } from "./run.js";
import { seedStateSchema } from "./seed-state.js";

// ─────────────────────────────────────────────────────────────────────────────
// 3. TASKS (formerly "scenarios") — originally adopted verbatim from
//    oslo/pome/src/scenario/scenarioSchema.ts
//
// W3 vocab (FDRS-653): "task" is the canonical name; the `scenario*` exports
// below are deprecated aliases kept for the 0.3.0 window (FDRS-654 swaps the
// consumers).
//
// `criterionSchema` and `judgeModelSchema` were moved to `./run.ts` (2026-05-11
// split) because CriterionResult depends on them; imported here from `./run.js`
// and re-exported to consumers via the index.ts barrel.
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
