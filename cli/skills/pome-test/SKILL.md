---
name: pome-test
description: Use when the user wants to test an already-registered coding agent against pome's deterministic SaaS twins, run their TESTS.md, or re-run scenarios after changing the agent. Triggers on phrases like "test my agent with pome", "run pome", "use /pome-test", or "run the pome tests". Reads TESTS.md, runs each scenario against the hosted twin, and reports pass/fail plus a dashboard URL.
---

# pome-test

Runs the scenarios listed in the repo's `TESTS.md` against pome's hosted twins, reports pass/fail per scenario, and points the user at the dashboard for the trace and the LLM-judge handoff on any failures.

This skill assumes the agent is already wired up. If `pome.config.json` or `TESTS.md` is missing, invoke `pome-setup` first.

## Prerequisites — check first

```bash
test -f pome.config.json && test -f TESTS.md && echo ok
```

If this does not print `ok`, stop and invoke `pome-setup` — the project isn't pome-ready yet.

Also verify auth (any of these passes is sufficient — Keychain on macOS is preferred):

```bash
security find-generic-password -s "pome-sh" -w >/dev/null 2>&1 \
  || test -f ~/.pome/credentials.json \
  || [ -n "$POME_API_KEY" ] \
  && echo ok
```

If not, run `pome login` (or ask the user to).

## Steps

### 1. Read TESTS.md

Parse the file as Markdown. Collect every line that looks like a relative path to a scenario file — typically bullets under a `## Scenarios` heading. Example:

```markdown
## Scenarios

- scenarios/01-bug-happy-path.md
- scenarios/02-missing-label.md
```

Yields the list `["scenarios/01-bug-happy-path.md", "scenarios/02-missing-label.md"]`. Ignore commented-out lines (`<!-- … -->`) and anything that doesn't end with `.md`.

If the list is empty, stop and report: "TESTS.md has no scenarios. Run `pome scenarios <twin> --copy` to add some, then list them under `## Scenarios`."

### 2. Confirm scope with the user

Print the planned runs in one short message:

```
About to run 2 scenarios (hosted):
  - scenarios/01-bug-happy-path.md
  - scenarios/02-missing-label.md
```

Wait for the user to confirm before spending hosted credits. If they want to skip a scenario or add one, edit TESTS.md and re-read.

### 3. Run each scenario

For every scenario path, run:

```bash
pome run <path>
```

Pome handles agent spawning, twin routing, recording, and scoring. A `--local`
run is not scored, so its exit code only reflects whether the agent ran
cleanly (`0`) or errored/timed out (`3`); exit `0` from `--local` means "trace
captured," not "scenario passed." Do not gate CI on a `--local` exit code.

The exit code tells you the result:

| Exit code | Meaning |
| --- | --- |
| 0 | All scenarios passed (hosted/scored run), or trace captured (`--local`, not scored) |
| 1 | At least one scenario scored below threshold |
| 2 | Twin or runner error (network, 5xx, twin spawn failed) |
| 3 | Auth error — `pome login` again; also a `--local` agent that failed to start or timed out |
| 4 | Quota exceeded |
| 5 | Usage error (bad flags, missing files) |

Capture stderr from each run — `pome` prints `PASS`/`FAIL`, the score, the local run dir, and the cloud dashboard URL on a successful invocation.

### 4. Report inline

After all runs finish, print a single summary block:

```
Pome results — 2 scenarios

  ✓ scenarios/01-bug-happy-path.md   score 100/100   <cloud-url>
  ✗ scenarios/02-missing-label.md    score 60/100    <cloud-url>

1 failed. Open the dashboard for the trace and the LLM-judge handoff:
  https://app.pome.sh
```

Use the cloud URL pome printed on stderr for each run. For scenarios with a non-zero exit code from the runner (codes 2-5), surface the error verbatim — don't try to recover.

### 5. On failures, surface the judge handoff

The dashboard's run page shows an LLM-judge handoff: a one-paragraph diagnosis and a concrete next step to fix the agent. **Do not invent your own fix suggestion** — the judge has the full trace and the agent's tool calls; you don't.

Tell the user, once, at the end:

```
For each failed run, open the dashboard URL above and copy the "judge handoff" section
into a new prompt. That's the most reliable next step.
```

## Output contract

When this skill finishes:

- Each scenario has been attempted (or skipped explicitly with a reason).
- A pass/fail summary is in the chat.
- Each run has a `cloud` URL in the summary (hosted runs always land on the dashboard).
- For failed runs, the user knows how to retrieve the judge handoff.

## Common pitfalls

| Symptom | Fix |
| --- | --- |
| Every scenario exits 3 (auth) | `pome login` and re-run. |
| Scenarios exit 2 with "agent command failed" | The `agent.command` in `pome.config.json` is wrong. Open it, fix, retry one scenario. |
| `pome run` blocks waiting for input | The agent is reading stdin. Make sure the agent reads its task from `POME_TASK`, not stdin. |
| User asks "what changed since last run?" | Pome stores per-run artifacts under `runs/<scenario>/<run-id>/` locally, and the dashboard page diffs clone state between runs. |
| User asks for an automatic fix | Decline — surface the dashboard handoff instead. The handoff is grounded in the full trace; an unguided fix attempt usually regresses. |

## Reference

- Dashboard layout: `pome docs dashboard`
- Scenarios catalog: `pome scenarios`
- CLI flags and exit codes: `pome docs cli-reference`
- Re-wire from scratch: invoke `pome-setup`
