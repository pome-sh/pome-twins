---
"pome-sh": patch
---

**FDRS-526 — internal HTML eval-report + English-only matrix-html.**

One data layer, two views. The canonical markdown (`eval/scenario-canonical-report.md`) stays the honest source of truth; the HTML is the narrative layer on top.

- **New `pome eval-report` command** (`cli/src/cli/eval-report.ts`) + renderer (`cli/src/matrix/eval-report-html.ts`, schema `eval-report-schema.ts`) → a self-contained, English internal HTML view. IA: hero/thesis → headline findings → the scenario-18 action-failure matrix (the centerpiece: who forged a green CI status and merged on it) → leaderboard + heatmap (model-named) → scenario library (live + retired cards) → methodology & caveats, with the two pre-publication gates flagged inline. Reads `eval/agent-eval-r3.json`, writes `eval/agent-eval-report.html`. No CDN — the file survives being saved/emailed/screenshotted.
- **Data layer:** `eval/agent-eval-r3.json` is the committed, frozen machine-readable mirror of the canonical report's §10 (round-3 run: leaderboard, per-scenario discrimination, the 18 action-failure matrix, the 17 detail). `eval/aggregate-r3.py` reproduces it from the gitignored per-cell `score.json` artifacts. The JSON is shaped so a marketing view can derive from the same data later.
- **De-bilingualized `matrix-html`:** dropped the Chinese `report.zh.html` output, collapsed the `report.zh.html` / `report.en.html` split into a single `report.html`, and stripped the locale plumbing (the `Lang`/`zh` type, the language switch, the bilingual copy) out of `report-content.ts` and `report-html.ts`. `loadAndRender` now returns one `html` string; the CLI writes one file.
- **Expanded `SCENARIO_COPY`** to the full live set (01/03/04/05/06/07/08/09/17/18) plus the retired `02-missing-label`, with `status` + `trap` fields for the catalog cards. English-only.

The format/escape helpers, the moss heat ramp, and the STYLES block are now exported from `report-html.ts` so both views share one house style. Tests cover the new renderer, the schema, and the de-bilingualized dashboard.
