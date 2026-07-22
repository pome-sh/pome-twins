# `pr-summary-review` — bundled Pome example

A [Claude Agent SDK](https://docs.claude.com/en/agent-sdk/typescript) agent that
both **summarizes** and **reviews** pull requests against a local GitHub-shaped
Pome twin. For each open PR it reads the title, body, changed files, and unified
diff, then:

1. Posts a structured summary comment (**what changed / why / risk / review
   checklist**).
2. Submits a formal review verdict — **APPROVE**, **COMMENT**, or
   **REQUEST_CHANGES** — grounded in the diff.

It approves only clearly-safe changes, requests changes when the diff contains a
real defect (a bug, a removed safety check, a hardcoded secret), and never
merges or modifies code.

This builds on `pr-summary-agent` (summary only) by adding a formal review
verdict via the twin's `create_pull_request_review` surface. The Claude API key
is sourced from **Infisical or your local environment**.

## Prerequisites

- A running Pome twin (the Pome CLI boots its own per run; for standalone use,
  start one with `npx @pome-sh/cli twin start github` — it prints a
  ready-minted `POME_AUTH_TOKEN` on boot).
- Node.js 24+ and npm 11.5+.
- An Anthropic API key — from your environment **or** Infisical (see below).

## Install

```bash
cd examples/pr-summary-review
npm install
```

## Claude API key — Infisical or local

The agent resolves `ANTHROPIC_API_KEY` in this order:

1. **Local env** — `ANTHROPIC_API_KEY` if it is already set.
2. **Infisical** — otherwise it runs `infisical secrets get ANTHROPIC_API_KEY
   --plain` via the CLI.

```bash
# Local
export ANTHROPIC_API_KEY=sk-ant-...

# Infisical — store the key in your project, then either:
infisical run -- pome run tasks/01-clean-prs.md   # injects all secrets as env vars
# ...or let the agent fetch it via the CLI (needs `infisical init` / login)
```

Infisical lookups honor `INFISICAL_ENV` (default `dev`), `INFISICAL_PROJECT_ID`,
and `POME_INFISICAL_SECRET_NAME` (default `ANTHROPIC_API_KEY`).

## Identity (`pome.json`) and hosted registration

Identity ships in the repo — the committed [`pome.json`](./pome.json) manifest
carries the portable `agent.slug` (`pr-summary-review`) and
`framework: "claude-agent-sdk"`, with **no** agent id. On the first hosted
`pome run` the CLI resolves that slug to an `agt_` id under **your** team and
caches it in gitignored `.pome/link.json`, so a fork self-onboards onto your own
dashboard with nothing sensitive committed.

To resolve it ahead of time (or re-resolve after a team switch):

```bash
# after `pome login`
pome register agent pr-summary-review
```

This resolves the committed slug to a cloud agent under your team and caches the
id in gitignored `.pome/link.json`; runs are then attributed to it on the
dashboard.

## Scenarios

Three hand-authored tasks live under [`tasks/`](./tasks/), each with a full
`.seed.json` fixture:

| Scenario | What it exercises | Expected verdict(s) |
| --- | --- | --- |
| `01-clean-prs.md` | Two benign PRs (a backwards-compatible feature + a docs change) | APPROVE / COMMENT — never REQUEST_CHANGES |
| `02-buggy-pr.md` | A PR that breaks `total()` by replacing `+=` with `=` (mislabeled "no behavior change") | REQUEST_CHANGES, naming the accumulation bug |
| `03-risky-pr.md` | A PR that hardcodes a live-looking secret and removes empty-token validation | REQUEST_CHANGES, flagging both |

## Run

```bash
# one task
pome run tasks/01-clean-prs.md

# all three (directory)
pome run tasks
```

`pome run` boots its own twin on a random port, seeds it from the scenario's
`.seed.json`, mints the JWT, and injects `POME_GITHUB_MCP_URL` /
`POME_AUTH_TOKEN` / `POME_TASK`. Hosted scoring requires `pome login`; add
`--local` to capture a trace without scoring.

## What this example shows

| Concept | Where in the code |
| --- | --- |
| Claude Agent SDK + in-process MCP tools | `src/index.ts` — `createSdkMcpServer`, `tool()` |
| Summarize + formal review verdict (`create_pull_request_review`) | `src/index.ts` — `buildTwinTools` (`submit_pull_request_review`) |
| Reconstructing the diff from file contents (`get_file_contents` on base + head) | `src/index.ts` — `buildTwinTools` |
| Claude key from Infisical or local env | `src/index.ts` — `resolveAnthropicKey` |
| Pome CLI compatibility (`POME_TASK`, `POME_GITHUB_MCP_URL`, `POME_AUTH_TOKEN`, `POME_PREFLIGHT`) | `src/index.ts` — env reads + `preflight` |

## Configuration

All optional. Defaults match `npx @pome-sh/cli twin start github`.

| Env var | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | resolved from Infisical if unset | Used by the Claude Agent SDK. |
| `INFISICAL_ENV` | `dev` | Infisical environment slug for the key lookup. |
| `INFISICAL_PROJECT_ID` | — | Infisical project ID (if not inferred from `.infisical.json`). |
| `POME_INFISICAL_SECRET_NAME` | `ANTHROPIC_API_KEY` | Secret name to fetch from Infisical. |
| `POME_OTEL_EXPORTER_OTLP_ENDPOINT` | — | Session-scoped OTLP/JSON traces endpoint for agent telemetry (per-task tokens/latency/errors on the dashboard). Set by hosted `pome run`; `withPome()` emits `gen_ai` spans here. When unset, telemetry stays off. |
| `POME_OTEL_EXPORTER_OTLP_HEADERS` | — | OTLP request headers (the `x-api-key=<team key>` auth that the session traces endpoint accepts), `key=value,…` format. Set by hosted `pome run`. |
| `POME_GITHUB_MCP_URL` | `http://127.0.0.1:3333/s/standalone/mcp` | Twin MCP endpoint. Pome CLI sets this automatically. |
| `POME_AUTH_TOKEN` | — | Pre-minted bearer JWT. `pome twin start` prints one; Pome CLI sets it automatically. When unset, the agent mints its own from `TWIN_AUTH_SECRET`. |
| `POME_TASK` | bundled summarize+review prompt | Override the agent's task. Pome CLI sets this from the scenario file. |
| `POME_REPO_OWNER` / `POME_REPO_NAME` | `acme` / `api` | Override the default repo named in the bundled task. |
| `TWIN_AUTH_SECRET` | — | The secret the twin was started with. Used to mint the JWT locally when `POME_AUTH_TOKEN` is unset. |
