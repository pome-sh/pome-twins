---
name: pome-verify-seed
description: Verifies a Pome task's seed is a fair exam before any run — verify_seed plus guard-aware triage of already-passing criteria, a state-diff review, an evaluate_criteria dry-run, and opt-in read-only probes on a live twin session. Use when the user has authored or adapted a task and wants to check the seed, asks "is my seed right / is this a fair exam?", or is about to run a task for the first time.
---

# Pome verify seed (Skill 2)

You are the **coach**: you talk to the builder and to the Pome control MCP
(`mcp.pome.sh`). This skill judges whether a task's seed is a **fair exam**
before anything runs against it. Fair means four things: the seed boots; the
seeded world matches what `## Prompt` / `## Setup` claim; every non-guard
criterion is NOT yet passed on the initial state; and at least one **positive
discriminator** carries the signal. It verifies — it never runs the exam.

## The triage rule: classify criteria, never trust the verdict string

`verify_seed` flags every criterion that already passes on the seed and says
`BROKEN seed` when it finds any. That verdict is **wrong on every healthy
blocking task**, because of one distinction it does not make:

- A **guard** is a do-no-harm criterion, true at seed *by construction* —
  `Pull request #1 is not merged`, `No message containing "sk-prod" appears…`.
  Passing at seed is its job. But it cannot tell a working agent from one that crashed on
  startup, so it must never be the only signal.
- A **positive discriminator** is a criterion only a correctly acting agent can
  flip — a comment appears, a label lands, a message is posted. These MUST be
  `not passed` / `failed` on the seed.

Triage each `already_passing` entry by intent, then judge:

| Finding | Judgment |
| --- | --- |
| Only guards pass at seed, ≥1 positive discriminator does not | **HEALTHY** — override the `BROKEN seed` verdict, say why |
| Any non-guard criterion passes at seed | **BROKEN** — the exam is pre-won; weaken the seed or restate the criterion |
| All criteria pass at seed | **BROKEN** — grades nothing, no matter what the verdict says |
| No positive discriminator exists at all | **BROKEN** — even if nothing pre-passes; a crashed agent scores full marks |
| Any `code` criterion is `unmatched` | **Authoring error** — no registered predicate; route back to `pome-author-task` |

## Fast path (default — in-process, free, no session)

Both `verify_seed` and `evaluate_criteria` boot the twin **in-process from the
seed on every call** — no sandbox, no session, nothing persists between calls,
so there is nothing to reset here. Run on the `task_id` (or inline
`task_source` for a draft):

1. **`verify_seed`** — collect `already_passing`, `unmatched`, `has_seed_state`,
   `notes`, `verdict`. `has_seed_state: false` is a warning to surface: the twin
   default world is in play; confirm the prompt is really about that world.
2. **Triage** every flagged criterion with the rule above.
3. **State-diff review** — read `## Seed State` against the task's claims:
   every actor / repo / channel the prompt names exists; every PR `head` branch
   has a file seeded on it (the twin computes the head SHA from it); counts and
   numbers match the prompt's story.
4. **`evaluate_criteria` dry-run** — every `code` criterion must come back with
   a matched predicate (`passed`/`failed`, never `unmatched`), and only guards
   may be `passed`.

## Deep check (opt-in — one live probe session)

The fast path grades the seed as data. To see the seed **as the examinee will
see it** — through the real twin MCP/REST surface — mint a probe session. This
costs one session slot; offer it, don't default to it.

1. `run_task` on the task — it seeds live twin sandboxes and returns
   `examinee_launch` (it does NOT launch anything). Keep `agent_token`.
2. Probe **read-only** (GET only) via `examinee_launch.rest_urls` or
   `mcp_servers` URLs with `Authorization: Bearer <agent_token>`. Confirm the
   seeded world from the outside: the PR is open, the channel has the message,
   the file is on the branch. A 404 on a probe may be session expiry — check
   `get_session` before blaming the seed.
3. **Mutation hole**: if any probe mutated state (a POST slipped in, a tool had
   side effects), the session no longer shows the seed — `stop_session` and
   re-mint before probing further. The in-process dry-run is immune, but a
   dirtied probe session must never be read as "the seed".
4. **Reset / teardown**: end every probe session with `stop_session`. A probe
   session has no evidence worth keeping — discarding it is the point. Never
   `finalize_run` a probe session; that would score the untouched seed.

## Report

End with: verdict **HEALTHY seed** / **BROKEN seed** (yours, not the tool's —
note when you overrode it and why), then a per-criterion table — text, kind,
at-seed status, classification (`guard` / `discriminator`), judgment — then the
state-diff findings, probe findings if a deep check ran, and the fix list
(seed edits vs criterion restatements) if anything is broken. The full checklist
with output-field semantics and probe recipes lives in
[`references/seed-fidelity-checklist.md`](references/seed-fidelity-checklist.md).
