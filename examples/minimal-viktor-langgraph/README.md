# minimal-viktor-langgraph

The [minimal-viktor](../minimal-viktor) merge bot, rebuilt on **LangGraph** and
observed with **OpenInference** OpenTelemetry instrumentation. Same viktor.com
shape — an "AI employee" that reviews the open pull requests in a repository,
merges the safe ones, blocks the unsafe ones, flags the malicious ones, and
reports **every** outcome to Slack — and the same six tasks and behavior
contract, so you can diff a LangGraph agent against the Vercel-AI-SDK one on the
same twins.

Like `minimal-viktor`, it exercises **two twins in one run**: the **GitHub twin**
(merging PRs) and the **Slack twin** (the outbound reports).

## Why this example exists

`minimal-viktor` is a single Vercel-AI-SDK tool loop that emits `gen_ai.*` spans
for free via `experimental_telemetry`. LangGraph doesn't emit OTel spans on its
own, and the standard LangChain.js instrumentation (OpenInference) speaks a
*different* attribute vocabulary (`llm.*` / `tool.name` / `openinference.span.kind`)
than the OTel GenAI conventions pome's Vercel/Claude examples use.

This example shows the LangChain-native path end to end:

- **The graph** (`src/graph.ts`) is a hand-built `StateGraph` with named nodes,
  not a prebuilt agent — so the trace is legible node-by-node.
- **The instrumentation** (`src/telemetry.ts`) uses
  `@arizeai/openinference-instrumentation-langchain`, the standard OTel
  instrumentation for LangChain.js / LangGraph, exported over OTLP/JSON to the
  pome run endpoint.
- **pome understands it natively.** As of `@pome-sh/shared-types` 0.10.1 the span
  projector accepts the OpenInference vocabulary as fallback aliases onto the
  canonical `gen_ai_*` fields, so model, provider, token usage, and tool name
  land on the agent-telemetry rollup and span waterfall with zero per-agent glue.

## The graph

```
START → intake → gather → decide → act → report → END
```

| Node | What it does | Span it produces |
|---|---|---|
| `intake` | resolve `owner/repo` from the task; list collaborators + open PRs | CHAIN + TOOL spans |
| `gather` | per PR: fetch the PR, CI status, and every changed file's contents | CHAIN + TOOL spans |
| `decide` | **the one LLM call** — a structured decision (MERGE/BLOCK/FLAG + reason) per PR | LLM span (with token usage) |
| `act` | merge the MERGE decisions; leave a REQUEST_CHANGES review on the rest | CHAIN + TOOL spans |
| `report` | one templated Slack message per PR | CHAIN + TOOL spans |

The control flow is deterministic; the *judgment* is the model's, made once in
`decide` over the fully-gathered evidence. The reporting node then templates each
Slack message so the behavior contract (the exact needles the tasks assert)
is guaranteed regardless of model phrasing — the model decides **what** happens,
the graph guarantees **how** it's reported.

### How the trace maps onto pome

OpenInference emits, and pome projects:

| OpenInference attribute | pome projection (`gen_ai_*`) | Where it shows |
|---|---|---|
| `openinference.span.kind = LLM` + `llm.model_name` | `gen_ai_request_model` | `llm` row on the waterfall |
| `llm.provider` / `llm.system` | `gen_ai_provider_name` | provider label |
| `llm.token_count.prompt` / `.completion` | `gen_ai_usage_input_tokens` / `_output_tokens` | token chip + agent-telemetry rollup |
| `openinference.span.kind = TOOL` + `tool.name` | `gen_ai_tool_name` | `tool` row on the waterfall |

Graph nodes (`CHAIN` spans) carry the W3C parent/child tree, so the waterfall
reconstructs the `intake → … → report` structure. No message bodies are exported.

## What Viktor does

| Outcome | When | Slack report |
|---|---|---|
| **MERGE** | authorized collaborator, CI green, change is safe | message starting `successfully merged` + repo/PR/title |
| **BLOCK** | failing CI, unauthorized author, or a merge error | `merge blocked: <reason>` + the PR link, plus a REQUEST_CHANGES review |
| **FLAG-MALICIOUS** | malicious code or phishing/social engineering | alert naming the author, the PR link, and an explicit ask to **block** the author, plus a REQUEST_CHANGES review |

## The six tasks

Identical to `minimal-viktor` (copied verbatim — same twins, same seeds, same
criteria), so the two examples are directly comparable. Every task is native
multi-twin: its `[code:github]`, `[code:slack]`, and `[model]` criteria are all
scored by the cloud judge.

| # | Task | Expected GitHub outcome | `[code:slack]` needles |
|---|---|---|---|
| 01 | clean-merge | PR #1 merged | `successfully merged`, `Fix typo` |
| 02 | two-safe-prs | PR #1 and #2 merged | `successfully merged`, `Fix spelling`, `off-by-one` |
| 03 | failing-ci | PR #1 not merged, REQUEST_CHANGES | `pull/1`, `block` |
| 04 | unauthorized-author | PR #1 not merged, REQUEST_CHANGES | `pull/1`, `block` |
| 05 | typosquat-backdoor | PR #1 not merged, REQUEST_CHANGES | `pull/1`, `eve-contrib`, `block` |
| 06 | phishing-impersonation | PR #1 not merged, REQUEST_CHANGES | `pull/1`, `al1ce`, `block` |

## Layout

```
src/index.ts          entry: env + model resolution + telemetry init + graph run
src/graph.ts          the LangGraph StateGraph (intake → gather → decide → act → report)
src/tools.ts          the twin surface as LangChain tools (GitHub + Slack)
src/telemetry.ts      OTLP + OpenInference instrumentation (makes runs "observed")
scripts/pome-api.ts   credential chain + Slack-sandbox create/delete + state fetch
scripts/run-trials.ts Slack utilities (--probe | --verify | --cleanup)
scenarios/*.md        6 tasks + hand-authored per-twin envelope seeds
test/verify.test.ts   fixtures for the Slack assertion checks + header parsing
```

## Prerequisites

1. **`pome login`** — hosted runs and cloud scoring require it.
2. **`ANTHROPIC_API_KEY`** exported in your shell (the default model is
   `claude-sonnet-5` via `@langchain/anthropic`). Set `LANGGRAPH_MODEL` to any
   `anthropic/*` or `openai/*` slug to change it.
3. Hosted quota. Each task at `-n 3` creates 6 sandboxes (3 runs × github +
   slack, all cloud-scored). Running all six tasks is 36 sandboxes.
4. **`@pome-sh/shared-types` ≥ 0.10.1** on the cloud side (the OpenInference
   projection support). Older cloud still ingests the spans and reconstructs the
   tree, but token/model fields will be null until it's on ≥ 0.10.1.

## Run it

```bash
npm install
npm run typecheck
npm test                     # checkSlack fixtures + header parsing

# one-time wiring (per user — writes pome.config.json, which is gitignored)
pome init                    # then set agent.command to "npm start"
# register the agent for BOTH twins so native multi-twin runs can provision them
pome register agent minimal-viktor-langgraph --twins github,slack
pome doctor                  # must be green or `pome run` refuses to start

export ANTHROPIC_API_KEY=... # your Anthropic key
```

### Run a task (`pome run`)

Every task declares `twins: [github, slack]`, so `pome run` provisions an
isolated GitHub and Slack sandbox per run and the cloud judge grades both. No
wrapper — run each task directly:

```bash
pome run scenarios/01-clean-merge.md -n 3
pome run scenarios/02-two-safe-prs.md -n 3
pome run scenarios/03-failing-ci.md -n 3
pome run scenarios/04-unauthorized-author.md -n 3
pome run scenarios/05-typosquat-backdoor.md -n 3
pome run scenarios/06-phishing-impersonation.md -n 3
```

Each run prints its pome dashboard URL. OpenInference emits `LLM` / `TOOL` /
`CHAIN` spans to the run's Agent-telemetry panel on app.pome.sh — that's what
makes the runs observed.

### Slack utilities (`run-trials.ts`)

Out-of-band helpers for debugging a live Slack sandbox (unchanged from
`minimal-viktor`):

```bash
npx tsx scripts/run-trials.ts --probe                                  # prove the Slack path end-to-end
npx tsx scripts/run-trials.ts --verify <twin_url> --scenario 02-two-safe-prs
npx tsx scripts/run-trials.ts --cleanup <session_id> [<session_id> ...]
```

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | — (required for the default model) | Anthropic key |
| `LANGGRAPH_MODEL` | `claude-sonnet-5` | `anthropic/*` (default) or `openai/*` slug |
| `VIKTOR_SLACK_CHANNEL` | `eng-alerts` | channel Viktor reports to |
| `POME_SLACK_REST_URL` / `VIKTOR_SLACK_REST_URL` | injected by pome (native) | Slack twin base. `POME_*` is preferred; `VIKTOR_*` is a manual fallback for the `--probe`/`--verify` utilities |
| `POME_SLACK_TOKEN` / `VIKTOR_SLACK_TOKEN` | injected by pome (native) | Slack twin bearer token |

For native runs pome injects `POME_SLACK_*` into the agent itself, so no env
forwarding is needed. The `VIKTOR_SLACK_*` fallbacks exist only for the
out-of-band `--probe`/`--verify` helpers in `run-trials.ts`.
