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

## Invariants ↔ CI checks (P8)

Docs are contracts. Any PR that changes an invariant below must update this
section in the same PR.

| Invariant | Enforced by |
| --- | --- |
| bun only | root `preinstall` (`only-allow bun`) |
| CLI capture-only (no local eval/scoring) | `cli/scripts/no-eval-in-oss.mjs` in [`.github/workflows/cli-ci.yml`](.github/workflows/cli-ci.yml) |
| No cloud imports in OSS packages | [`scripts/lint-no-cloud-imports.sh`](scripts/lint-no-cloud-imports.sh) |
| Mirror byte parity (until M6) | [`scripts/check-redaction-mirrors.mjs`](scripts/check-redaction-mirrors.mjs), [`scripts/check-admin-gate-mirrors.mjs`](scripts/check-admin-gate-mirrors.mjs) |
| No new cross-package file copies | [`scripts/check-copy-markers.mjs`](scripts/check-copy-markers.mjs) (allowlist shrinks in M6) |
| Dead code / orphan packages = 0 | [`knip.json`](knip.json) via `bun run lint:dead-code` in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) |
| Package barrels + file-size hygiene | [`scripts/lint-code-health.mjs`](scripts/lint-code-health.mjs) |

Everything else — architecture, per-package details, and the CI gotchas
(changeset gate, no-cloud-imports, twin Docker build) — is documented at
https://docs.pome.sh.
