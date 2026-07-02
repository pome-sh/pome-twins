# Contributing to `pome` CLI

Thanks for your interest! This document covers the developer workflow for the `pome-sh/cli` repository. For the broader product, see https://pome.sh.

## Prerequisites

- Node.js **≥ 20** (LTS recommended; CI runs 20 + 22).
- [Bun](https://bun.sh) for dev install / test speed. End-user installs only require npm/Node.

## Setup

```bash
git clone https://github.com/pome-sh/cli.git
cd cli
bun install
bun run build      # produces dist/
```

## Running locally

```bash
bun run dev -- --help            # tsx + source
bun run pome -- --help           # built dist/ output
```

## Test, typecheck, build

```bash
bun run typecheck    # tsc --noEmit
bun run test         # vitest unit tests
bun run test:e2e     # end-to-end tests
bun run build        # full publishable build
```

CI runs typecheck, build, tests, and vendor verification. PRs are gated on green CI.

## Pull requests

- One change per PR. Keep them small.
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`, `build:`, `refactor:`, `test:`).
- Reference the relevant Linear ticket (`FDRS-NNN`) in the title or body when one exists.
- Source files carry the SPDX header `// SPDX-License-Identifier: Apache-2.0`.

## File layout

- `src/cli/`: command surface (Commander.js entry points).
- `src/runner/`: scenario execution (local + hosted).
- `src/hosted/`: control-plane HTTP client.
- `src/evaluator/`: deterministic + probabilistic scoring.
- `src/twin/`: local twin boot harness.
- `src/twin-github/` and `src/twin-slack/`: local twin mirrors not yet consolidated.
- `vendor/`: tarballs bundled into the published CLI, including the packaged Stripe twin. After changing `packages/twin-stripe/**`, rebuild the package tarball, replace `vendor/pome-sh-twin-stripe-0.1.0.tgz`, and update `scripts/verify-vendor.mjs`.
- `scenarios/`: bundled starter scenarios shipped with the package.
- `examples/`: example agent implementations.
- `scripts/`: build-only helpers (not published).

## Security

Found a vulnerability? Email `founders@pome.sh`. Please do not file public issues for security reports.
