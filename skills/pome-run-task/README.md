# pome-run-task — coach Skill 4

Run a seed-verified Pome task against the builder's examinee and score it
from the live twin tape: `run_task` to mint the session, launch the examinee
on its runtime, `finalize_run` the instant it idles, then narrate `get_report` —
and a fix loop that re-runs only the failed tasks and shows the delta. The
skill itself is [`SKILL.md`](./SKILL.md); the two runtime launchers it dispatches
to live in [`references/`](./references/).

Runs downstream of Skills 0–2: intake ([`pome-intake`](../pome-intake/README.md))
registers the examinee clone, author ([`pome-author-task`](../pome-author-task/README.md))
writes the graded task, verify ([`pome-verify-seed`](../pome-verify-seed/README.md))
confirms the seed is a fair exam. This skill is the last leg — it launches the
examinee for real and grades it.

## Seam-first, per ADR-018

Only one step in the pipeline is examinee-runtime-specific here: **launching the
examinee**. Minting, finalizing, scoring, reporting, and the fix loop are
runtime-agnostic and stay in `SKILL.md`. Each launcher is an isolated module in
`references/`, dispatched on the Runtime line. Adding a platform (a new REST
driver, V1.5's no-code Anthropic driver, a non-Anthropic host) is a bounded
change: one new launcher file + the contract emitting that platform's
`examinee_launch` policy — never a pipeline rewrite. Launch **policy**
(`always_allow`, closed-book web tools, memory snapshot-clone, the network clamp)
is owned by `examinee_launch`; the skill executes the spec and never restates it
in prose (prose drifts — F-787 is what that costs). ADR-018
(examinee-runtime abstraction) lives in the pome-cloud repo
(`docs/decisions/018-examinee-runtime-abstraction.md`).

## Layout

One authored source per skill — this directory. Nothing is generated from it;
what you see is what ships.

```
pome-run-task/
├── SKILL.md                          # the skill (frontmatter + instructions, <100 lines)
├── references/
│   ├── launch-managed-agent.md       # seam: assemble + run on Managed Agents via ant
│   └── launch-rest.md                # seam: run a self-hosted REST examinee
└── README.md                         # this file
```

## Install

Part of the coach set — install the whole set with one command (see
[`skills/README.md`](../README.md)); `references/` ships with the skill so the
one-level-deep links resolve:

```bash
npx skills add pome-sh/digital-twins
```

Requires the Pome control MCP connection (`claude mcp add --transport http pome
https://mcp.pome.sh/mcp`) so the `run_task` / `finalize_run` / `get_report` /
`register_agent` / `list_runs` tools resolve, and — for a managed-agent examinee
— `ant` authenticated (`ant auth login`, F-782).

## The run loop

1. **Mint** — `run_task(task_id, agent_id, group_id)` → `session_id`,
   `agent_token` (SENSITIVE, memory-only), `examinee_task`, `examinee_launch`.
   Mint the `group_id` upfront so an attempt's trials aggregate as one exam (a
   post-fix rerun opens a new group and links back — see step 5); for a `runs: N`
   task use `run_trials(n, task_id, group_id)`, the batch form. Heal a
   `twins not enabled` 400 with one additive `register_agent` (F-784).
2. **Launch** — dispatch on the Runtime line: managed agent → `ant`
   (`references/launch-managed-agent.md`); anything else → REST
   (`references/launch-rest.md`). The launcher assembles from `examinee_launch`,
   starts the examinee, and watches for idle.
3. **Finalize immediately** — `finalize_run(session_id, agent_token)` the instant
   the examinee idles, while the twin tape is still live. A late finalize loses
   the tape.
4. **Report** — `get_report(run_id)`: score, criteria (kind/status), provenance
   `hosted`, the `app.pome.sh` link.
5. **Fix loop** — on a failure, hand the report's `## Handoff (fix prompt)` to the
   builder; they edit the **examinee** prompt; re-run only the failed tasks
   (same `agent_id`) as a fresh run-set — a **new** `group_id` carrying the
   failing run's group_id as `baseline_group_id` (the report's `## Rerun after
   fixing` section pre-fills both); diff the two reports and show the delta.
   Anti-cheat guardrail: never weaken a criterion/`passThreshold` or edit the
   seed to force a green — a criterion fix goes back through author/verify.

## Test evidence

The fixture pair (a leaky vs hardened examinee prompt for exercising the fix
loop) and the kept e2e transcript of the A3 managed-agent live run (100/100,
provenance `hosted`) are historical evidence and stay in the pome-cloud repo
(`apps/docs/docs/skills/`, under this skill's legacy-named directory).
