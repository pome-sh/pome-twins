# `triage-agent` — bundled Pome example

A small [Claude Agent SDK](https://docs.claude.com/en/agent-sdk/typescript)
agent that triages open issues against a local GitHub-shaped Pome twin. For
each open issue it picks one of `bug` / `feature` / `question`, applies the
label, and posts a one-sentence reasoning comment.

This is the example referenced in the README quickstart and the demo video
(see `01-triage-acme-issues.md` for the bundled Pome scenario).

## Prerequisites

- A running Pome twin on `http://127.0.0.1:3333` — the easiest way is
  `docker compose up` from the repo root. The twin auto-generates a
  bearer secret at `<repo-root>/.pome-data/github/secret` on first run.
- `bun >= 1.3.0` and `node >= 20`.
- Claude auth for the agent loop: BYOK via `ANTHROPIC_API_KEY`, or a Claude
  subscription (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, or a
  stored `claude` login).

## Install

```bash
cd examples/triage-agent
bun install
```

This package is intentionally **not** part of the root bun workspace — that
keeps the Claude Agent SDK out of the monorepo install for everyone who isn't
running the example.

## Run (standalone, against `docker compose up`)

```bash
# 1. From the repo root, in another terminal:
docker compose up

# 2. From this directory:
export ANTHROPIC_API_KEY=sk-ant-...
bun run start
```

The agent reads the secret from `<repo-root>/.pome-data/github/secret`, mints its
own bearer JWT (`sid: "demo"`, matching the docker-compose `/s/demo` URL),
then talks to the twin's MCP at `http://127.0.0.1:3333/s/demo/mcp`.

To re-run cleanly (the twin's SQLite is persisted under `./.pome-data/`):

```bash
docker compose exec twin-github sh -c \
  "node -e \"fetch('http://127.0.0.1:3333/admin/reset', {method:'POST'})\""
```

## Run (under the Pome CLI evaluator)

The CLI evaluator boots its own twin on a random port, seeds it from the
scenario file, mints its own JWT, and passes the URL + token to the agent
via env (`POME_GITHUB_MCP_URL`, `POME_AUTH_TOKEN`, `POME_TASK`):

```bash
export ANTHROPIC_API_KEY=sk-ant-...

# from this directory, with the CLI at ../../cli
bun run --cwd ../../cli dev -- run \
  ../examples/triage-agent/01-triage-acme-issues.md \
  --agent "bun run --cwd $(pwd) start"
```

A passing run prints `PASS Triage open issues in acme/api` and writes a
trace under `runs/<scenario-slug>/<run-id>/`.

## What this example shows

| Concept | Where in the code |
| --- | --- |
| Claude Agent SDK + in-process MCP tools | `src/index.ts` — `createSdkMcpServer`, `tool()` |
| Calling the twin's MCP surface (`POST /s/:sid/mcp/call`) | `src/index.ts` — `TwinMcpClient` |
| Local JWT mint compatible with the docker-compose entrypoint | `src/index.ts` — `resolveAuthToken` |
| Pome CLI compatibility (`POME_TASK`, `POME_GITHUB_MCP_URL`, `POME_AUTH_TOKEN`, `POME_PREFLIGHT`) | `src/index.ts` — env reads + `preflight` |

## Configuration

All optional. Defaults match the repo-root `docker compose up`.

| Env var | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | Claude API key for the Agent SDK. Alternatives: `CLAUDE_CODE_OAUTH_TOKEN`, or a stored `claude` subscription login. |
| `POME_GITHUB_MCP_URL` | `http://127.0.0.1:3333/s/demo/mcp` | Twin MCP endpoint. Pome CLI sets this automatically. |
| `POME_AUTH_TOKEN` | — | Pre-minted bearer JWT. Pome CLI sets this; otherwise the agent mints its own. |
| `POME_TASK` | bundled triage prompt | Override the agent's task. Pome CLI sets this from the scenario file. |
| `POME_TWIN_BASE_URL` | `http://127.0.0.1:3333` | Used to derive the MCP URL when `POME_GITHUB_MCP_URL` is unset. |
| `POME_TWIN_SID` | `demo` | Used to derive the MCP URL when `POME_GITHUB_MCP_URL` is unset. |
| `POME_REPO_OWNER` / `POME_REPO_NAME` | `acme` / `api` | Override the default repo named in the bundled task. |
| `TWIN_AUTH_SECRET` | — | Override the on-disk secret when minting the JWT locally. |
| `POME_DATA_SECRET_PATH` | `<repo-root>/.pome-data/github/secret` | Override where the agent looks for the on-disk secret. |
