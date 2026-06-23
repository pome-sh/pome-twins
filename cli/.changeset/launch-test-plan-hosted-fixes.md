---
"pome-sh": patch
---

Two hosted-run fixes surfaced during the 2026-05-27 launch test plan walkthrough.

**Hosted upload schema (`cli/src/runner/runScenarioHosted.ts`, `cli/src/recorder/artifacts.ts`)** — every hosted `pome run` was failing the cloud schema gate with `events.jsonl uses the legacy single-shape RecorderEvent schema (pre-FDRS-398). Upgrade your pome CLI to upload the v1 discriminated-union schema.` Root cause: the local artifact writer wrapped each twin-pod event via `toTwinHttpEvent()` before writing `events.jsonl`, but the hosted upload path serialized the raw events array directly. Export `toTwinHttpEvent` from `artifacts.ts` and wrap on the upload side too.

**`pome fix-prompt` empty-results guard (`cli/src/cli/main.ts`)** — hosted runs persist `score.json` with `results: []` because `/finalize` only returns the summary satisfaction number; per-criterion verdicts live on the dashboard. Feeding the empty array into the fix-prompt LLM template caused it to dutifully emit `## No failures. All criteria passed; no fix needed.` — the exact false negative for a failed run. Bail early with exit 2 and a 3-line stderr hint pointing users at the cloud run URL or `POME_LOCAL=1` for the local judge path.

Cloud-side `/finalize` change to return `criteria_results[]` is tracked separately; it will let us remove the early-exit guard.
