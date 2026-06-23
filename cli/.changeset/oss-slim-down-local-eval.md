---
"pome-sh": minor
---

**Evaluation is now a hosted feature; self-host with `pome run --local`.**

- `pome run --local` boots an in-process twin, runs the agent, and records the
  full trace + state, but does NOT score it (no `score.json`, no pass/fail
  verdict). The verdict comes from Pome cloud (`pome login` + `pome run`). The
  default hosted path is unchanged; the internal `POME_LOCAL=1` escape hatch
  (used by `pome matrix`) still scores locally. See ADR-004.
- The not-signed-in error now points at both `pome login` and `pome run --local`.
- Eval research (`eval/`) moved out of the OSS repo to the research workspace,
  so `pome eval-report` requires an explicit data-file argument (no bundled
  default), and `pome matrix` / `pome matrix-html` default `--artifacts-dir` to
  `matrix-results`.
