---
"pome-sh": minor
---

`pome run <task> -n k` — real trial groups end-to-end (FDRS-636). `-n` (integer
1-20, hosted only) runs k isolated trials of one task as a single group;
the default k comes from the scenario config's `runs` field (capped at 20).
k>1 mints all k sessions upfront on `POST /v1/sessions` with one shared
`grp_`+nanoid21 `group_id` and a fresh idempotency key per mint, then runs
the trials sequentially through the existing hosted runner (explicit 60s
finalize timeout). The terminal prints the moment-04 verdict table — numeric
cloud-judge scores per trial (capture-only CLI, no local scoring), errored
trials excluded from the summary fraction — and hands off to the task's
reliability page (`{dashboard}/runs/task/<taskName>`). A trial that fails
preflight, times out, or crashes is abandoned via
`POST /v1/sessions/:id/abandon` with a machine `error_code`
(`preflight_failed` / `agent_timeout` / `agent_exit_nonzero` /
`trial_crashed`) and the remaining trials continue. Group exit code
(documented in `src/hosted/errors.ts`): 0 iff at least one trial completed
AND every completed trial passed; 1 when a completed trial failed; 2 when
nothing completed. k=1 keeps today's single-run behavior exactly — no group
is ever stamped.
