# `pr-summary-agent` — bundled Pome example

A small [Claude Agent SDK](https://docs.claude.com/en/agent-sdk/typescript)
agent that summarizes pull requests against a local GitHub-shaped Pome twin. For
each open PR it reads the title, body, changed files, and unified diff, then
posts a single structured comment: **what changed**, **why**, **risk**, and a
short **review checklist**.

Where `triage-agent` triages issues, this shows the same Claude Agent SDK + MCP
shape applied to pull requests — and how to source the Claude API key from
**Infisical or your local environment**.

## Prerequisites

- A running Pome twin on `http://127.0.0.1:3333` — the easiest way is the
  repo-root `docker compose up`. The twin auto-generates a bearer secret at
  `<repo-root>/.pome-data/secret` on first run.
- `bun >= 1.3.0` and `node >= 20`.
- An Anthropic API key for the agent loop — from your environment **or**
  Infisical (see below).

## Install

```bash
cd examples/pr-summary-agent
bun install
```

This package is intentionally **not** part of the root bun workspace — that
keeps the Claude Agent SDK out of the monorepo install for everyone who isn't
running the example.

## Claude API key — Infisical or local

The agent resolves `ANTHROPIC_API_KEY` in this order:

1. **Local env** — `ANTHROPIC_API_KEY` if it is already set.
2. **Infisical** — otherwise it runs `infisical secrets get ANTHROPIC_API_KEY
   --plain` via the CLI.

So either of these works:

```bash
# Local
export ANTHROPIC_API_KEY=sk-ant-...
bun run start

# Infisical — store ANTHROPIC_API_KEY in your project, then either:
infisical run -- bun run start          # injects all secrets as env vars
bun run start                           # agent fetches the secret via the CLI
```

Infisical lookups honor `INFISICAL_ENV` (default `dev`),
`INFISICAL_PROJECT_ID`, and `POME_INFISICAL_SECRET_NAME` (default
`ANTHROPIC_API_KEY`).

## Run (standalone, against `docker compose up`)

```bash
# 1. From the repo root, in another terminal:
docker compose up

# 2. From this directory (key from env or Infisical, see above):
bun run start
```

The agent reads the secret from `<repo-root>/.pome-data/secret`, mints its own
bearer JWT (`sid: "demo"`, matching the docker-compose `/s/demo` URL), then
talks to the twin's MCP at `http://127.0.0.1:3333/s/demo/mcp`.

By default it summarizes open PRs in `acme/api`. Point it at another repo with
`POME_REPO_OWNER` / `POME_REPO_NAME`, or override the whole task with
`POME_TASK`.

## Run (under the Pome CLI evaluator)

The CLI evaluator boots its own twin on a random port, seeds it from the
scenario file, mints its own JWT, and passes the URL + token to the agent via
env (`POME_GITHUB_MCP_URL`, `POME_AUTH_TOKEN`, `POME_TASK`):

```bash
export ANTHROPIC_API_KEY=sk-ant-...    # or run under `infisical run -- ...`

# from this directory, with the CLI repo checked out beside `pome`
bun run --cwd ../../../cli dev -- run \
  ../pome/examples/pr-summary-agent/01-summarize-prs.md \
  --agent "bun run --cwd $(pwd) start"
```

A passing run prints `PASS Summarize open pull requests (widgets)` and writes a
trace under `runs/<scenario-slug>/<run-id>/`.

## What this example shows

| Concept | Where in the code |
| --- | --- |
| Claude Agent SDK + in-process MCP tools | `src/index.ts` — `createSdkMcpServer`, `tool()` |
| Wrapping PR endpoints (`list_pull_requests`, `get_pull_request_files`, `get_file_contents`, …) | `src/index.ts` — `buildTwinTools` |
| Calling the twin's MCP surface (`POST /s/:sid/mcp/call`) | `src/index.ts` — `TwinMcpClient` |
| Claude key from Infisical or local env | `src/index.ts` — `resolveAnthropicKey` |
| Local JWT mint compatible with the docker-compose entrypoint | `src/index.ts` — `resolveAuthToken` |
| Pome CLI compatibility (`POME_TASK`, `POME_GITHUB_MCP_URL`, `POME_AUTH_TOKEN`, `POME_PREFLIGHT`) | `src/index.ts` — env reads + `preflight` |

## Configuration

All optional. Defaults match the repo-root `docker compose up`.

| Env var | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | resolved from Infisical if unset | Used by the Claude Agent SDK. |
| `INFISICAL_ENV` | `dev` | Infisical environment slug for the key lookup. |
| `INFISICAL_PROJECT_ID` | — | Infisical project ID (if not inferred from `.infisical.json`). |
| `POME_INFISICAL_SECRET_NAME` | `ANTHROPIC_API_KEY` | Secret name to fetch from Infisical. |
| `POME_GITHUB_MCP_URL` | `http://127.0.0.1:3333/s/demo/mcp` | Twin MCP endpoint. Pome CLI sets this automatically. |
| `POME_AUTH_TOKEN` | — | Pre-minted bearer JWT. Pome CLI sets this; otherwise the agent mints its own. |
| `POME_TASK` | bundled PR-summary prompt | Override the agent's task. Pome CLI sets this from the scenario file. |
| `POME_TWIN_BASE_URL` | `http://127.0.0.1:3333` | Used to derive the MCP URL when `POME_GITHUB_MCP_URL` is unset. |
| `POME_TWIN_SID` | `demo` | Used to derive the MCP URL when `POME_GITHUB_MCP_URL` is unset. |
| `POME_REPO_OWNER` / `POME_REPO_NAME` | `acme` / `api` | Override the default repo named in the bundled task. |
| `TWIN_AUTH_SECRET` | — | Override the on-disk secret when minting the JWT locally. |
| `POME_DATA_SECRET_PATH` | `<repo-root>/.pome-data/secret` | Override where the agent looks for the on-disk secret. |
