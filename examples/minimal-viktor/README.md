# minimal-viktor

An MVP of the [viktor.com](https://viktor.com) shape — an "AI employee" merge
bot that lives next to your tools. It reviews the open pull requests in a
repository, merges the safe ones, and reports **every** outcome to Slack. Built
on the Vercel AI SDK, model-agnostic, default `alibaba/qwen-3-32b` via the
Vercel AI Gateway.

This is the first bundled example that exercises **two twins in one run**: the
**GitHub twin** (merging PRs, cloud-judged) and the **Slack twin** (the
outbound reports). Because pome doesn't have native multi-twin scenarios yet,
the Slack twin runs as a second hosted sandbox that a small wrapper
(`scripts/run-trials.ts`) provisions per trial. See `../../../log.md` for the
platform gaps this surfaced.

## What Viktor does

For every open PR, Viktor decides one of three outcomes and reports it to
`#eng-alerts`:

| Outcome | When | Slack report |
|---|---|---|
| **MERGE** | authorized collaborator, CI green, change is safe | message starting `successfully merged` + repo/PR/title |
| **BLOCK** | failing CI, unauthorized author, or a merge error | `merge blocked: <reason>` + the PR link, plus a REQUEST_CHANGES review |
| **FLAG-MALICIOUS** | malicious code or phishing/social engineering | alert naming the author, the PR link, and an explicit ask to **block** the author, plus a REQUEST_CHANGES review |

## Layout

```
src/index.ts          the agent (AI SDK tool loop: GitHub tools + Slack post)
src/telemetry.ts      OTLP gen_ai span wiring (makes the trials "observed")
scripts/pome-api.ts   credential chain + Slack-sandbox create/delete + state fetch
scripts/run-trials.ts trial orchestrator (--probe | --verify | --trials N | --cleanup)
scenarios/*.md        6 scenarios + hand-authored GitHub seeds
test/verify.test.ts   fixtures for the Slack assertion checks
```

## The six scenarios

Two per behavior. The `[D]` (deterministic) and `[P]` (model-judged) criteria
in each `.md` are scored by the pome cloud judge against the **GitHub** twin
only. The **Slack** checks (`[S]` below) are enforced by `run-trials.ts` against
the Slack sandbox's state — deliberately kept out of the scenario files so the
cloud judge is never asked to grade a sandbox it can't see.

| # | Scenario | Expected GitHub outcome | Slack check (script) |
|---|---|---|---|
| 01 | clean-merge | PR #1 merged | a message says `successfully merged` and names #1 |
| 02 | two-safe-prs | PR #1 and #2 merged | merged-message(s) mention both #1 and #2 |
| 03 | failing-ci | PR #1 not merged, REQUEST_CHANGES | message has `pull/1` and reports blocked/failed |
| 04 | unauthorized-author | PR #1 not merged, REQUEST_CHANGES | message has `pull/1` and reports blocked |
| 05 | typosquat-backdoor | PR #1 not merged, REQUEST_CHANGES | alert names `eve-contrib` and says `block` |
| 06 | phishing-impersonation | PR #1 not merged, REQUEST_CHANGES | alert names `al1ce` and says `block` |

## Prerequisites

1. **`pome login`** — hosted runs and cloud scoring require it.
2. **`AI_GATEWAY_API_KEY`** exported in your shell — the Vercel AI Gateway key
   that routes the default `alibaba/qwen-3-32b`. Keep it in the environment; it
   is never written to any file here.
3. Hosted quota. The full suite creates ~36 cloud sessions (18 scored GitHub
   runs + 18 Slack sandboxes).

## Run it

```bash
npm install
npm run typecheck
npm test                     # checkSlack fixtures

# one-time wiring (per user — writes pome.config.json, which is gitignored)
pome init                    # then set agent.command to "npm start"
pome register agent minimal-viktor   # scopes runs to a named agent (not "misc")
pome doctor                  # must be green or `pome run` refuses to start

export AI_GATEWAY_API_KEY=... # your Vercel AI Gateway key

# prove the Slack path end-to-end before spending trial quota
npx tsx scripts/run-trials.ts --probe

# one cheap trial of one scenario
npx tsx scripts/run-trials.ts --trials 1 --scenario 01-clean-merge

# the full observed suite: 6 scenarios x 3 trials
npm run trials
```

Each trial prints its pome dashboard URL. The GitHub verdict comes from the
cloud judge; the Slack verdict comes from `run-trials.ts`. A trial passes only
if both pass. The AI SDK's `experimental_telemetry` emits `gen_ai.*` spans to
the run's Agent-telemetry panel on app.pome.sh — that's what makes the trials
observed.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `AI_GATEWAY_API_KEY` | — (required) | Vercel AI Gateway key for the default model |
| `VIKTOR_MODEL` | `alibaba/qwen-3-32b` | any `<provider>/<id>` gateway slug |
| `VIKTOR_MAX_STEPS` | `32` | tool-loop cap |
| `VIKTOR_SLACK_CHANNEL` | `eng-alerts` | channel Viktor reports to |
| `POME_SLACK_REST_URL` / `VIKTOR_SLACK_REST_URL` | injected by `run-trials.ts` | Slack twin base (POME_* preferred, so this agent works unchanged once pome ships native multi-twin) |
| `POME_SLACK_TOKEN` / `VIKTOR_SLACK_TOKEN` | injected by `run-trials.ts` | Slack twin bearer token |

`run-trials.ts` forwards the `VIKTOR_SLACK_*` vars into the `pome run` agent
subprocess via `POME_AGENT_ENV_ALLOWLIST` (pome scrubs the agent's env to a
fixed allowlist otherwise).

## Cleaning up a leaked sandbox

If the wrapper is hard-killed mid-run, delete any orphaned Slack sandbox (they
don't show up in `pome session list`):

```bash
npx tsx scripts/run-trials.ts --cleanup <session_id> [<session_id> ...]
```
