# `triage-agent` — bundled Pome example

A small [Claude Agent SDK](https://docs.claude.com/en/agent-sdk/typescript)
agent that triages open issues against a local GitHub-shaped Pome twin. For
each open issue it picks one of `bug` / `feature` / `question`, applies the
label, and posts a one-sentence reasoning comment.

This is the example referenced in the README quickstart and the demo video
(see `tasks/01-triage-acme-issues.md` for the bundled Pome task).

## Prerequisites

- A running Pome twin on `http://127.0.0.1:3333` — start one with
  `npx @pome-sh/cli twin start github` (only Node ≥ 24 required). It prints
  the twin URL and a ready-minted `POME_AUTH_TOKEN` on boot.
- Node.js 24+ and npm 11.5+.
- Claude auth for the agent loop: BYOK via `ANTHROPIC_API_KEY`, or a Claude
  subscription (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, or a
  stored `claude` login).

## Install

```bash
cd examples/triage-agent
npm install
```

This package is intentionally **not** part of the root npm workspace — that
keeps the Claude Agent SDK out of the monorepo install for everyone who isn't
running the example.

## Identity (`pome.json`)

This example ships a committed [`pome.json`](./pome.json) manifest carrying the
portable `agent.slug` (`triage-agent`) and `framework: "claude-agent-sdk"` — no
agent id. On a hosted `pome run` the CLI resolves that slug to an `agt_` id under
**your** team and caches it in the gitignored `.pome/` dir, so a fork
self-onboards onto your own dashboard with nothing sensitive committed. Task
files live under [`tasks/`](./tasks/), referenced by the manifest's `tasks` key.

## Run (standalone, against `pome twin start`)

```bash
# 1. In another terminal — start the GitHub twin:
npx @pome-sh/cli twin start github
# it prints POME_AUTH_TOKEN=… (a ready-minted bearer JWT)

# 2. From this directory:
export POME_AUTH_TOKEN=…            # paste from the twin start output
export ANTHROPIC_API_KEY=sk-ant-...
npm run start
```

The agent's auth comes from **env only** — it never reads the twin's on-disk
state. Instead of pasting the token, you can export the same
`TWIN_AUTH_SECRET` (≥ 32 chars) in both terminals before starting the twin;
the agent then mints its own bearer JWT (`sid: "standalone"`, matching the
`/s/standalone` session `pome twin start` serves):

```bash
# terminal 1
export TWIN_AUTH_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
npx @pome-sh/cli twin start github

# terminal 2 (same TWIN_AUTH_SECRET exported)
export ANTHROPIC_API_KEY=sk-ant-...
npm run start
```

The agent talks to the twin's MCP at `http://127.0.0.1:3333/s/standalone/mcp`.

To re-run cleanly, restart `pome twin start` (each boot serves a fresh copy of
the seeded demo world) or reset in place:

```bash
curl -X POST http://127.0.0.1:3333/admin/reset
```

## Run (under the Pome CLI evaluator)

The CLI evaluator boots its own twin on a random port, seeds it from the
task file, mints its own JWT, and passes the URL + token to the agent
via env (`POME_GITHUB_MCP_URL`, `POME_AUTH_TOKEN`, `POME_TASK`):

```bash
export ANTHROPIC_API_KEY=sk-ant-...

# from this directory, with the CLI at ../../cli
npm run --cwd ../../cli dev -- run \
  ../examples/triage-agent/tasks/01-triage-acme-issues.md \
  --agent "npm run --cwd $(pwd) start"
```

A passing run prints `PASS Triage open issues in acme/api` and writes a
trace under `runs/<task-slug>/<run-id>/`.

## What this example shows

| Concept | Where in the code |
| --- | --- |
| Claude Agent SDK + in-process MCP tools | `src/index.ts` — `createSdkMcpServer`, `tool()` |
| Calling the twin's MCP surface (`POST /s/:sid/mcp/call`) | `src/index.ts` — `TwinMcpClient` |
| Env-only twin auth (token pass-through or local JWT mint) | `src/index.ts` — `resolveAuthToken` |
| Pome CLI compatibility (`POME_TASK`, `POME_GITHUB_MCP_URL`, `POME_AUTH_TOKEN`, `POME_PREFLIGHT`) | `src/index.ts` — env reads + `preflight` |

## Configuration

All optional. Defaults match `npx @pome-sh/cli twin start github`.

| Env var | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | Claude API key for the Agent SDK. Alternatives: `CLAUDE_CODE_OAUTH_TOKEN`, or a stored `claude` subscription login. |
| `POME_GITHUB_MCP_URL` | `http://127.0.0.1:3333/s/standalone/mcp` | Twin MCP endpoint. Pome CLI sets this automatically. |
| `POME_AUTH_TOKEN` | — | Pre-minted bearer JWT. `pome twin start` prints one; Pome CLI sets it automatically. When unset, the agent mints its own from `TWIN_AUTH_SECRET`. |
| `POME_TASK` | bundled triage prompt | Override the agent's task. Pome CLI sets this from the task file. |
| `POME_TWIN_BASE_URL` | `http://127.0.0.1:3333` | Used to derive the MCP URL when `POME_GITHUB_MCP_URL` is unset. |
| `POME_TWIN_SID` | `standalone` | Used to derive the MCP URL when `POME_GITHUB_MCP_URL` is unset. |
| `POME_REPO_OWNER` / `POME_REPO_NAME` | `acme` / `api` | Override the default repo named in the bundled task. |
| `TWIN_AUTH_SECRET` | — | The secret the twin was started with. Used to mint the JWT locally when `POME_AUTH_TOKEN` is unset. |
