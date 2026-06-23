# AGENTS.md

> Operational notes for anyone — human or AI agent — working in this repo.
> `CLAUDE.md` is a symlink to this file.

## What this repo is

This repository is the open-source twins and the `pome` CLI. The twins are
local, resettable services that answer the same REST and MCP calls your agent
makes in production: GitHub, Stripe (x402), and Slack, each backed by real
SQLite state. The CLI boots a twin, runs an agent against it, and records the
trace for you to inspect.

The Pome platform builds on these with evaluation, simulation, and
observability, at https://pome.sh. Apache-2.0.

## Layout

```
packages/twin-github/        GitHub twin (Hono + SQLite; REST + MCP)
packages/twin-stripe/        Stripe x402 twin (REST + MCP)
packages/twin-slack/         Slack twin (Web API + MCP)
                             Image: ghcr.io/pome-sh/twins, tag per twin (:github/:stripe/:slack)
packages/shared-types/       Zod schemas + trace contracts (workspace dep)
packages/sdk/                Library for building your own twin
packages/correlator/         Trace events -> run lanes/steps
packages/adapter-claude-sdk/ Claude Agent SDK adapter
cli/                         The `pome` CLI (published as pome-sh). NOT a root workspace.
examples/triage-agent/       Worked agent example (Claude Agent SDK + MCP)
examples/merge-agent/        Worked agent example (Vercel AI SDK + REST)
```

## Build / test

```bash
bun install                       # one-time / after deps change
bun run --filter '*' typecheck    # type-check all workspaces
bun run --filter '*' test         # all workspace tests (vitest)
bun run --filter '*' build

cd packages/twin-github && bun run dev    # boot a twin locally (stripe :3334, slack :3335)
cd cli && bun run test                    # the CLI is separate — see Gotchas
```

You're done when `typecheck` + `test` are clean.

## Conventions

- **bun only.** One `bun.lock` at root; a `preinstall` guard fails `npm install`.
- **No `pome-cloud` imports** in any source — the OSS repo never depends on the
  hosted control plane (enforced by `scripts/lint-no-cloud-imports.sh`).
- Import `@pome-sh/shared-types`, not bare `pome` (that's the CLI binary, not a lib).
- TypeScript ESM everywhere; targets node ≥20 / bun ≥1.3.
- Evaluation/scoring is a hosted feature; `pome run --local` records a trace
  without scoring.

## Gotchas

- **GHCR images are private until launch** — `docker login ghcr.io` before
  `docker compose up`.
- **The CLI (`cli/`) is not a root workspace** — use `cd cli && bun ...`, not
  `bun run --filter '*'`.
- **Changes under `cli/src/**` need a changeset** (`cd cli && bun changeset`) or a
  version bump — enforced by the `cli-version-gate` CI check.
- **Twin Docker build context is `packages/twin-<name>/`** (not repo root); each
  vendors `shared-types` via the workflow's `build-contexts`, and `better-sqlite3`
  needs python3 + make + g++ in the build stage.
