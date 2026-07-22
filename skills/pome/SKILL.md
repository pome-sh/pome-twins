---
name: pome
description: Entry point for testing an agent with Pome — routes to the right coach skill by context (managed-agent YAML → pome-intake, local repo / self-hosted REST agent → the local-examinee run path, plain task authoring → pome-author-task) and maps CLI-era commands to the hosted MCP tools. Use when the user says "test my agent with pome", "run pome", or "use pome". Supersedes the Gen-1 /pome-test skill.
---

<!--
Naming decision (F-801, 2026-07-22): this router is named `pome`, NOT
`pome-test`. The Gen-1 skill installed by `pome skills install` already
occupies `pome-test` in users' skills directories, so a Gen-2 skill with the
same name would collide at install time for anyone who has Gen-1. Gen-1
(`cli/skills/pome-setup`, `cli/skills/pome-test`) retires at F-859 (M2);
until then this router owns the shared trigger phrases and the two
generations never claim the same entry point.
-->

# Pome (entry router)

You are the **coach**: you talk to the builder and to the Pome control MCP
(`mcp.pome.sh`). The **examinee** is a sandbox clone of their agent, run
against Pome's digital twins and graded from the live twin tape. This skill
does one thing: read the builder's context and hand off to the right coach
skill. Do not improvise a pipeline here.

If the `mcp__pome__*` tools are missing, the MCP isn't connected: ask the user
to connect and authenticate it (interactive OAuth — needs a human in a
browser): `claude mcp add --transport http pome https://mcp.pome.sh/mcp`.

## Route by context

| The builder arrives with… | Route |
| --- | --- |
| A **Claude managed-agent YAML** (pasted, or "test my managed agent") | `pome-intake` — collect the clone scope, register via `intake_clone_scope`, report twin coverage |
| A **local repo agent / self-hosted process** (talks REST, no managed-agent YAML) | The local-examinee path: register once with `register_agent(name, twins)`, then `pome-run-task` — `run_task` mints the session and the launch spec; launch the process yourself via the REST launcher (`pome-run-task/references/launch-rest.md`) |
| "**What should I test?**" / a worry to turn into a graded check | `pome-author-task` — library-first authoring, `[code]`/`[model]` criteria, validate → dry-run → `save_task` |
| A drafted task, first run coming up ("is my seed right?") | `pome-verify-seed` — fair-exam triage before anything runs |
| A verified task to execute ("run my tasks", "how did my agent do?") | `pome-run-task` — mint, launch, `finalize_run` on idle, narrate `get_report` |

When in doubt, ask one question — "is your agent a Claude managed agent, or a
process you run yourself?" — and route on the answer. The full journey is
intake → author → verify → run; enter wherever the builder actually is.

## This is not the CLI

The `pome` CLI records traces locally; evaluation and scoring are hosted. If
the builder arrives with the CLI mental model, map the verbs — tool names are
verbatim from the frozen control MCP contract v1.0:

| CLI-era habit | Hosted (coach) equivalent |
| --- | --- |
| `pome register` | `register_agent` via the control MCP — the **one** "register an agent" verb (the CLI command remains for CLI-era users; both land the same registration) |
| `pome run <task>` | `run_task` (mints the session) → launch the examinee → `finalize_run` the instant it idles → `get_report` |
| `pome run -n 3` (N trials) | `run_task` ×3, all sharing one `group_id`, `finalize_run` each; `list_runs(group_id)` is the cross-run view |
| Local task files on disk | `save_task` into your team catalog on first use; browse with `list_tasks` (no cross-team library) |
| "Where are my results?" | `get_report(run_id)` / `list_runs`, and the dashboard on `app.pome.sh` |

Two standing facts to carry into every route: the examinee runs **closed-book**
(`web_search`/`web_fetch` disabled — seed the world instead of citing the live
internet), and tasks/examples ship as task **source** that gets `save_task`-ed
into the builder's own team on first run.
