---
name: pome-setup
description: Use when the user wants to wire a coding agent up to pome for the first time (so pome can test it against deterministic SaaS twins), or after they've changed which third-party services their agent integrates with. Triggers on phrases like "set up pome", "register my agent with pome", "test my agent with pome", or "use /pome-setup". Identifies the agent and its services, registers it on the pome dashboard, and writes a starter TESTS.md.
---

# pome-setup

One-shot wire-up for an existing coding agent so the user can test it with pome (`https://pome.sh`). The pome CLI runs agents against deterministic SaaS twins (GitHub, Stripe, …), records every tool call, and scores the result.

This skill makes the project pome-ready. It does **not** modify how the agent runs in production — pome only captures tool calls during a `pome run` invocation.

The skill pauses for explicit user confirmation between every state-changing step. Do not skip the pauses — first-time users need to see what's about to happen before it happens.

## Prerequisites — check first

```bash
pome version
```

If the command is missing, install:

```bash
npm install -g pome-sh
```

If `pome version` works, continue.

## Steps

### 1. Identify the agent and its services

Establish two things by reading the repo (look at `package.json`, `Cargo.toml`, `pyproject.toml`, agent source files, env files, README):

- **Agent type**: Claude Code, Codex, Cursor, an SDK-built agent (Anthropic SDK / OpenAI SDK), or a custom Node/Python/Bash script that drives an LLM.
- **Services the agent talks to**: which third-party APIs does it call? GitHub? Stripe? Others?

Pome currently ships twins for these services (run `pome scenarios` to see the live list):

| Service | Twin id |
| --- | --- |
| GitHub | `github` |

**Pause and confirm with the user in one short message** — name the agent, name the services, and ask if anything's missing. Wait for the user to confirm before continuing. Misidentified services lead to irrelevant scenarios.

### 2. Verify auth — log in if needed

Any of these passing is sufficient — macOS Keychain is preferred over the file fallback, and a `POME_API_KEY` env var beats both for CI / direnv setups:

```bash
security find-generic-password -s "pome-sh" -w >/dev/null 2>&1 \
  || test -f ~/.pome/credentials.json \
  || [ -n "$POME_API_KEY" ] \
  && echo ok
```

If this does not print `ok`, run:

```bash
pome login
```

This opens the browser and stores a `pme_…` API key in the **macOS Keychain** (preferred on macOS) or `~/.pome/credentials.json` (other OSes / Keychain unavailable).

### 3. Scaffold the project if it's not already pome-ready

Check first:

```bash
test -f pome.config.json && echo ready || echo "needs scaffolding"
```

If the file is absent, **tell the user what's about to happen and wait for confirmation**:

> `pome.config.json` is missing — I'll run `pome init` to scaffold `scenarios/`, `examples/agents/`, and the config file. Continue?

After the user confirms, run:

```bash
pome init
```

This creates `scenarios/`, `examples/agents/`, and a `pome.config.json` with `agent.command` and `passThreshold`.

If `pome init` just ran, **open `pome.config.json` and set `agent.command`** to how the user's actual agent is invoked (the default is a placeholder). Examples:

- Claude Code: `"claude -p \"$POME_TASK\""`
- Anthropic SDK agent: `"node dist/agent.js"` (or `"npx tsx src/agent.ts"`)
- Python agent: `"python -m my_agent"`

The agent reads its task from the `POME_TASK` env var and tool-call URLs from `POME_GITHUB_REST_URL`, `POME_GITHUB_TOKEN`, etc. (see `pome docs cli-reference` for the full env-var list). The agent should **not** require any other source change — pome injects these env vars at run time.

Show the user the line you set and ask them to confirm it's right before moving on.

### 4. Register the agent on the dashboard

Pick a short, lowercase, hyphenated name based on the repo. Default to the repo directory name; ask the user if you're unsure.

**Wait for the user to confirm the name before registering**:

> I'll register this agent on app.pome.sh as `<name>`. Continue?

After confirmation, run:

```bash
pome register agent <name>
```

This creates the agent on `app.pome.sh` under the user's team and writes `agentId` and `agentSlug` into `pome.config.json`. Both keys are load-bearing — do not hand-edit them out.

Compose the dashboard URL from the slug for step 6:

```
https://app.pome.sh/agents/<slug>
```

The slug is whatever the command printed (typically a slugified version of the name). If you missed it, read it back with:

```bash
node -e 'console.log(JSON.parse(require("fs").readFileSync("pome.config.json","utf8")).agentSlug)'
```

### 5. Write a starter `TESTS.md`

For an agent that talks to GitHub, suggest **all five bundled runnable scenarios** — they cover the canonical triage / labeling / context / identity-safety cases and give a meaningful first signal. Start narrower only if the user explicitly asks.

**Pause and confirm with the user** before writing the file:

> I'll create `TESTS.md` with these 5 scenarios so the first `/pome-test` run gives a useful breadth:
>
> - `scenarios/01-bug-happy-path.md` — clear bug triage (apply label, assign owner)
> - `scenarios/02-missing-label.md` — create-and-retry recovery
> - `scenarios/03-already-triaged.md` — don't pile on a finished issue
> - `scenarios/04-judge-context.md` — exercises the LLM-judge evaluator
> - `scenarios/05-github-identity-spoof.md` — refuse unauthorized PR merge
>
> Or pick a subset — five is the breadth suggestion, not a hard requirement. What do you want?

After the user picks a list, write `TESTS.md` in the repo root:

```markdown
# Pome tests

Run with `/pome-test`.

## Scenarios

- scenarios/01-bug-happy-path.md
- scenarios/02-missing-label.md
- scenarios/03-already-triaged.md
- scenarios/04-judge-context.md
- scenarios/05-github-identity-spoof.md
```

For services other than GitHub, list whichever bundled scenarios for that twin make sense — run `pome scenarios <twin>` to see the catalog.

Copy the scenario files into the local repo so the user can read and edit them:

```bash
pome scenarios github --copy
```

Substitute the right twin id if not GitHub. Re-prompt the user if they need a different twin.

### 6. Print the dashboard URL and offer to run /pome-test

Print, in this exact shape (substitute values):

```
Agent registered: <agent-name>
Dashboard:        https://app.pome.sh/agents/<slug>
Tests:            TESTS.md (N scenarios)

Ready to run? Invoke /pome-test, or say "yes" and I'll run it now.
```

If the user says yes, invoke the `pome-test` skill.

## Output contract

When this skill finishes successfully:

- `pome.config.json` exists with `agentId`, `agentSlug`, and a real `agent.command`.
- `TESTS.md` exists in the repo root with at least one scenario path (default: all 5 GitHub scenarios).
- The bundled scenario files live under `scenarios/` in the repo.
- The agent appears on `app.pome.sh` under the user's account at `app.pome.sh/agents/<slug>`.
- The chat ends with the dashboard URL and an offer to invoke `/pome-test`.

## Common pitfalls

| Symptom | Fix |
| --- | --- |
| `pome register agent` fails with 401/403 | Re-run `pome login` (or set `POME_API_KEY`). |
| `pome.config.json` exists but `agent.command` is the default `npx tsx examples/agents/scripted-triage-agent.ts` | Replace with how the user's real agent is invoked. The default is for the bundled example only. |
| User's agent talks to a service pome doesn't have a twin for yet | Note it explicitly in the confirmation message. Skip that service's scenarios for now; the user can request it from pome. |
| Repo isn't a Node/git project | `pome init` still works — it only writes files. Skip steps that depend on `package.json`. |
| User edited `pome.config.json` and the dashboard stopped grouping runs by agent | Re-add the `agentId` and `agentSlug` keys; both are written by `pome register agent` and the dashboard needs both. |

## Reference

- Skill contract: `pome docs skills`
- Dashboard layout: `pome docs dashboard`
- CLI flags and env vars: `pome docs cli-reference`
- Scenario catalog: `pome scenarios`
