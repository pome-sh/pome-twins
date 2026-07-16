// SPDX-License-Identifier: Apache-2.0
/**
 * task-vocab — the W3 "scenario → task" wire-vocabulary rename (FDRS-653).
 *
 * W3 decision (binding, 2026-06): everything "scenario" becomes "task" on the
 * wire, and criterion kinds `D` / `P` become `code` / `model`. The cloud DB is
 * already renamed (`tasks` table, `runs.task_name`); this module gives the
 * shared trace format the same vocabulary WITHOUT breaking 0.3.0-era artifacts.
 *
 * Tolerant-reader contract (the 0.3.0 compatibility window):
 *   - Canonical schemas and types use the NEW vocabulary only
 *     (`task_name`, `task_hash`, `task_source`, `task_id`, `promoted_task_id`,
 *     `task_step_id`, criterion kind `code` / `model`).
 *   - Readers accept BOTH the old and the new keys and normalize to the new
 *     vocabulary at parse time. Nothing a 0.3.0-era artifact contains becomes
 *     invalid: shipped CLIs vendor shared-types 0.3.0 and keep sending
 *     `scenario_*` keys and `D` / `P` criterion kinds for at least one more
 *     release train (the CLI vendored-tarball bump rides FDRS-654/657).
 *   - When BOTH keys are present, the new key wins (a 0.5.0-aware writer is
 *     more authoritative about the canonical field than a mirrored legacy key).
 *
 * The window closes with the next major once no supported CLI emits the old
 * vocabulary; removal of the aliases goes through the deprecation policy.
 */

/**
 * Old wire key → canonical wire key for the RENAME-on-read surfaces of the
 * /v1 contract (run / session / result wire objects):
 *   - `scenario_name` / `scenario_hash`   — Run rows + POST /v1/sessions/{id}/result
 *   - `scenario_source` / `scenario_id`   — POST /v1/sessions
 *   - `promoted_scenario_id`              — Run rows (M0.5 replay-loop linkage)
 *
 * DELIBERATELY NOT in this map: `scenario_step_id` on RecorderEvent rows
 * (events.jsonl). The frozen v1 event row has PRESERVE semantics — the legacy
 * key stays as-sent while readers additionally populate `task_step_id` — which
 * is handled by the reader schemas in `./recorder-events.ts`, NOT by this
 * delete-the-legacy-key map.
 */
export const LEGACY_TASK_VOCAB_KEY_MAP = {
  scenario_name: "task_name",
  scenario_hash: "task_hash",
  scenario_source: "task_source",
  scenario_id: "task_id",
  promoted_scenario_id: "promoted_task_id",
} as const;

/**
 * Rename legacy `scenario_*` keys on a raw wire object to their canonical
 * `task_*` names. Non-objects pass through untouched (the wrapped schema then
 * reports the real type error). When both the legacy and the canonical key are
 * present the canonical value wins and the legacy key is dropped.
 *
 * Used as a `z.preprocess` step in front of the canonical object schemas —
 * this is the "tolerant reader" half of the 0.3.0 compatibility window.
 *
 * DO NOT apply this helper to recorder-event rows (events.jsonl). Event rows
 * require `scenario_step_id` preserved as-sent (frozen v1 trace format), and
 * this function's rename-and-delete semantics would strip that step linkage
 * if the key were mapped. `scenario_step_id` is intentionally absent from
 * `LEGACY_TASK_VOCAB_KEY_MAP`, so this function leaves it intact — event-row
 * normalization lives in `recorderEventSchema` / `eventSchema`
 * (`./recorder-events.ts`).
 */
export function normalizeTaskVocabKeys(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const [legacyKey, canonicalKey] of Object.entries(LEGACY_TASK_VOCAB_KEY_MAP)) {
    if (legacyKey in record) {
      out ??= { ...record };
      if (!(canonicalKey in record)) {
        out[canonicalKey] = record[legacyKey];
      }
      delete out[legacyKey];
    }
  }
  return out ?? value;
}

/**
 * Legacy criterion kind → canonical criterion kind (W3: D→code, P→model).
 *
 * SANCTIONED EXCEPTION (F-778). The full D/P→code/model migration removed the
 * legacy spelling everywhere — including the markdown authoring marker, which
 * is now `[code]` / `[model]` — EXCEPT this read-only shim. It exists because:
 *   - 0.3.0-era persisted artifacts (run rows, `criteria_results` jsonb) carry
 *     `D` / `P` and must keep parsing;
 *   - released CLIs keep sending `"D"` / `"P"` on the finalize wire
 *     (`criterionDefSchema` in ./rest.js) for one more release train.
 * It is input-normalization only: no writer may emit `D` / `P`, and no new
 * code may reference the legacy spellings outside this map and the schemas
 * that apply it (`criterionKindInputSchema` in ./run.js, `criterionDefSchema`
 * in ./rest.js). Removal rides the wire-window close-out ticket.
 */
export const LEGACY_CRITERION_KIND_MAP = {
  D: "code",
  P: "model",
} as const;
