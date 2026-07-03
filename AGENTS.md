# AGENTS.md

> Operational notes for anyone — human or AI agent — working in this repo.

## What this repo is

The open-source Pome twins and the `pome` CLI. The twins are local, resettable
services that answer the same REST and MCP calls your agent makes in production
(GitHub, Stripe x402, Slack), each backed by real SQLite state. The CLI boots a
twin, runs an agent against it, and records the trace for you to inspect.
Evaluation and scoring are hosted features — `pome run --local` records a trace
only, no local scoring. The Pome platform (evaluation, simulation,
observability) is at https://pome.sh. Apache-2.0.

## Docs

Repo layout, full build/test workflow, conventions, and the contributor guide
live at **https://docs.pome.sh**.

## Before you build

- **bun only** — one `bun.lock` at root; an `npm install` guard fails the build.
- **The CLI (`cli/`) is not a root workspace** — use `cd cli && bun ...`, not
  `bun run --filter '*'`.

Everything else — architecture, per-package details, and the CI gotchas
(changeset gate, no-cloud-imports, twin Docker build) — is documented at
https://docs.pome.sh.
