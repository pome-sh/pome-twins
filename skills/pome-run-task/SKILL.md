---
name: pome-run-task
description: Runs a verified Pome task against the builder's examinee and scores it from the live twin tape — run_task to mint the session, launch the examinee on its runtime (Managed Agents via ant, or REST), finalize_run the instant it idles while the tape is still live, then narrate get_report; re-runs only the failed tasks after a prompt fix and shows the delta. Use when the user's task passed seed verification and they want to run the exam, asks "run my tasks / how did my agent do?", or wants to re-test after a prompt fix.
---

# Pome run task (Skill 4)

You are the **coach**: you talk to the builder and to the Pome control MCP
(`mcp.pome.sh`). The **examinee** is the sandbox clone Skill 0 (`pome-intake`)
registered, launched here for real against live twins. This skill runs one
already-verified task and scores it from the twin tape. Verify the seed
first (`pome-verify-seed`) — this skill does not re-check fairness.

Only **one** step here is examinee-runtime-specific: launching the examinee.
Minting, finalizing, scoring, reporting, and the fix loop are runtime-agnostic
(ADR-018). The launch **policy** — `always_allow`, closed-book web tools, memory
snapshot-clone, the network clamp — is owned by the `examinee_launch` spec, not
by this prose: you *execute* the spec, you do not restate it.

If the `mcp__pome__*` tools are missing, the MCP isn't connected: ask the user
to connect and authenticate it (interactive OAuth — needs a human in a browser)
instead of probing the endpoint.

**SENSITIVE — the bearer.** `run_task` returns `agent_token`, a
session-scoped JWT that is the bearer for every twin URL — a live credential.
Hold it in memory for this run only: never write it to disk, into a task, or
a log. It dies at `expires_at`; `finalize_run` is the last thing that needs it.

## 1. Mint the run

Call `run_task(task_id, agent_id)` (the `agent_id` from intake). It seeds
live twin sandboxes and returns `session_id`, `expires_at`, `agent_token`,
`examinee_task` (the prompt + twins the examinee sees — no criteria), and
`examinee_launch` (the full launch spec).

- **`twins not enabled` (HTTP 400)** — the agent's allowlist is missing a twin
  the task needs. Heal with one additive `register_agent(name, twins:[…])`
  (it merges, never removes — F-784), then re-run. Do not re-intake the scope.
- Everything the examinee needs is inside `examinee_launch`. Read the **Runtime**
  line from the intake report (or `examinee_launch.transport`) to pick the
  launcher below.

## 2. Launch the examinee (the one runtime-specific step)

Dispatch on the runtime and hand off to the matching launcher, which assembles
the examinee **faithfully from `examinee_launch`**, starts it on the kickoff
task, and watches for idle:

- **Claude managed agent** (`transport: "mcp"`) → Anthropic's Managed Agents
  cloud via the `ant` CLI. Recipe:
  [`references/launch-managed-agent.md`](references/launch-managed-agent.md).
- **Anything else** (`transport: "rest"`) → the REST path (`rest_urls` + `env`).
  Recipe: [`references/launch-rest.md`](references/launch-rest.md). Dispatch
  honestly — a non-Claude examinee on Managed Agents runs as Claude, testing
  nothing.

## 3. Finalize the instant it idles

The twin tape lives in the running session's sandbox. `finalize_run` captures
final state + events off the **still-live** twins; once the session leaves
`ready`/`running` the sandbox is torn down and the tape is gone — it errors, and
the run is unrecoverable. So the moment the launcher reports the examinee idle
(done / awaiting-input with no more tool calls coming), call
`finalize_run(session_id, agent_token)` **immediately** — before any cleanup,
before narrating anything. It scores synchronously against the pulled tape and
returns `{ run_id, score, judge_model, dashboard_url }`. One evaluation per run.

## 4. Narrate the report

`get_report(run_id)` returns the run markdown. Narrate, don't dump: the
**Score /100**, the criteria table (each row's **Kind** = `code`/`model`,
**Status** = passed/failed/unmatched, **Reason**), **Provenance** (a live
twin-pull run is `hosted` — say so, it means Pome watched the work, not the
agent self-reporting), and the dashboard link on `app.pome.sh`. An `unmatched`
criterion is an unregistered predicate, not a failing grade — route it back to
`pome-author-task`.

## 5. Fix loop (re-run only what failed, show the delta)

A green run is done. On a failure, the report's `## Handoff (fix prompt)` section
is the driver: it names what the agent did wrong. Hand it to the builder, they
edit the **examinee's** prompt (never the task — that would move the goal
posts), then:

1. Re-run **only the failed tasks** — one `run_task` each against the
   same `agent_id`, sharing a `group_id` with the first attempt so they line up
   as one exam on the dashboard.
2. There is no delta field in the report — compute it: pull `get_report` for the
   prior run and the new one, diff the Status column per criterion, and report
   the flips (`"leaked to #general: failed → passed"`). `list_runs(group_id)`
   gives the cross-run view.
3. Repeat until every re-run is green (or the builder accepts the behavior).
   Only failed tasks re-run; the green ones are not re-billed.

## Report

End with: the task name and `run_id`, **Score /100**, the criteria table
(criterion · kind · status · reason), provenance, and the `app.pome.sh` link. On
a fix-loop run, add the per-criterion delta and name the prompt edit that moved it.
