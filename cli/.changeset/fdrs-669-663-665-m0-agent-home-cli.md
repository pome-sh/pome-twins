---
"pome-sh": minor
---

Reliability IA v1 M0, the CLI half (FDRS-669 / FDRS-663 / FDRS-665).

`pome install` registers the agent, idempotently (FDRS-669): after the
wiring session (and on the no-agent fallback when a config already exists),
install calls the existing `POST /v1/agents` machinery with the repo
directory's name and writes `agentId` + `agentSlug` into `pome.config.json`.
An already-registered repo is a no-op — no duplicate agents, no error, same
slug. Registration failing never fails the install; it prints the cause and
the `pome register agent <name>` recovery path. "Default agent" becomes a
migration-era state only.

Free-tier concurrent quota no longer breaks the k=5 default (FDRS-663,
[DECISION] option A — bounded/lazy minting): a quota push-back mid-mint
discovers the plan's concurrent-twin bound instead of aborting the group
with exit 4. The group runs its trials at that concurrency (resolving
FDRS-636's deferred "bounded trial parallelism" thread — the bound IS the
plan quota), and trials past the bound mint lazily as finished trials'
session DELETEs free slots (quota retries with a 2s pause, 5 attempts, then
that trial renders as an errored row and the rest continue). The
provisioning line names the bound honestly ("plan concurrency 3 — 5 trials
reuse slots as they finish"); trial rows still render in trial order. A
quota error before the first mint still aborts with exit 4, and non-quota
mint failures still roll the half-group back.

The `pome run` handoff link lands on the run set, never the agent-less
empty state (FDRS-665): with a registered slug in `pome.config.json` the
group summary prints `/agents/<slug>/tasks/<taskName>?group=grp_…`
(Reliability IA v1 decision 1 — the URL carries the agent by construction;
`?group` is honored by the page from M1). Legacy fallbacks ride FDRS-668's
cloud-side redirects: `agentId` without a slug keeps
`/runs/task/<name>?agent=<id>`, and an unregistered repo prints the bare
task URL, which auto-selects when exactly one agent has runs for the task.
