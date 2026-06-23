---
"pome-sh": patch
---

**F0-3 / L5 (CLI half) — populate `score.results` from `/finalize`'s `criteria_results[]`.**

Consumes the cloud-side change shipped in Session A (Linear FDRS-423): `POST /v1/sessions/:id/finalize` now returns `criteria_results: CriterionResult[]` so the dashboard's per-criterion verdicts are available CLI-side too. Without this, `pome fix-prompt` and `pome inspect` could only render the summary score on hosted runs.

Changes:
- Extended `finalizeResponseSchema` with optional `criteria_results: z.array(criterionResultSchema).optional()`. Optional so the CLI keeps parsing /finalize responses from older cloud builds that don't emit the field during the rollout window.
- `runScenarioHosted.ts` populates `score.results` (plus `passed` / `failed` / `skipped` / `total_required` counts) from `finalized.criteria_results` instead of always writing `results: []`.
- Softened the `pome fix-prompt` empty-results guard added by commit `f595392`. The hard exit is gone; the soft hint stays so users on the rollout window (CLI shipped, cloud not yet deployed) still get a useful pointer instead of the misleading "no failures" boilerplate.
