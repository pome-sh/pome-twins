---
"pome-sh": minor
---

**The OSS CLI is now CAPTURE-ONLY — no local evaluation, judge, or correlation (FDRS-657).**

A verdict comes only from the cloud (a hosted `pome run`, or `pome eval <run-dir>`); local artifacts are trace/audit only.

- Removed the local evaluator entirely: the deterministic `[D]` matchers (`src/evaluator/deterministic.ts`, `src/evaluator/twin-plugins/*`), the BYOK local LLM judge (`src/evaluator/probabilistic/*`), local scoring (`scoreResults`, `scoreAndWriteRun`), and local correlation (`src/runner/correlateRun.ts` + the `@pome-sh/correlator` dependency and its vendored tarball).
- The `matrix` / `matrix-html` / `eval-report` commands were removed — they were a pure local-scoring orchestrator that cannot produce a verdict under capture-only.
- `pome run --local` (and `POME_LOCAL=1`) now capture a raw trace only — an audit log with no score, no verdict, no judge. It prints a pointer to `pome eval <run-dir>`.
- No path writes `score.json` anymore (hosted `pome run` and `pome eval` print the cloud verdict to the terminal ephemerally). `pome inspect` shows only trace/audit content.
- `pome fix-prompt <events> <scenario>` no longer calls an LLM: it assembles a self-contained paste-into-IDE prompt from the raw trace + the scenario's criteria for your own coding assistant. (Signature dropped the `<score>` argument.)
- The pure cloud-verdict display model (`Score`/`CriterionResult` types, `scoreStatus`, `outcomeOf`, `markerFor`, count summaries) was relocated to `src/score/view.ts`.
- Added a `no-eval-in-oss` CI gate (`scripts/no-eval-in-oss.mjs`, wired into `cli-ci`) that fails if local evaluation is reintroduced.

RELEASE GATE: publish this CLI only AFTER pome-cloud's `POST /v1/eval-sessions` is deployed to prod, so self-host users are never left with neither a local nor a cloud verdict.
