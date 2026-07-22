# Contributing to `pome` CLI

Thanks for your interest! This document covers the developer workflow for the `pome` CLI in the [pome-twins](https://github.com/pome-sh/pome-twins) monorepo. For the broader product, see https://pome.sh.

## Prerequisites

- Node.js **≥ 24** (CI runs Node 24).
- npm **≥ 11.5.1** (matches the Trusted Publishing pin used by release workflows).

## Setup

```bash
git clone https://github.com/pome-sh/pome-twins.git
cd pome-twins/cli
npm install
npm run build      # produces dist/
```

## Running locally

```bash
npm run dev -- --help            # tsx + source
npm run pome -- --help           # built dist/ output
```

## Test, typecheck, build

```bash
npm run typecheck    # tsc --noEmit
npm test             # vitest unit tests
npm run test:e2e     # end-to-end tests
npm run build        # full publishable build
```

CI runs typecheck, build, tests, and capture-only gates. PRs are gated on green CI.

## Pull requests

- One change per PR. Keep them small.
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`, `build:`, `refactor:`, `test:`).
- Reference the relevant Linear ticket (`FDRS-NNN`) in the title or body when one exists.
- Source files carry the SPDX header `// SPDX-License-Identifier: Apache-2.0`.

## File layout

- `src/cli/`: command surface (Commander.js entry points).
- `src/runner/`: task execution (local + hosted).
- `src/hosted/`: control-plane HTTP client, plus the pure cloud-verdict
  display/cache models (`evalResultView.ts`, `evalResultCache.ts`).
- `src/twin/`: local twin boot harness (`githubCloneAdapter.ts` wraps published twin packages).
- `package.json`: pins exact `@pome-sh/*` package versions consumed by the published CLI.
- `scenarios/`: bundled starter tasks shipped with the package.
- `examples/`: example agent implementations.
- `scripts/`: build-only helpers (not published).

## Capture is open, evaluation is the product

pome-twins (this repo — the twins + the `pome` CLI) is **capture-only**: it
boots a twin, runs an agent against it, and records the raw trace (events,
before/after state, stdout/stderr). It never computes a score, never calls a
judge, and never correlates events into a verdict locally. That logic —
deterministic predicate matching, the LLM judge, correlation, scoring — is
the product, and it lives entirely in pome-cloud. A verdict only ever comes
back from the cloud, whether via a hosted `pome run` or an upload through
`pome eval`.

This boundary is enforced mechanically, repo-wide, by
[`scripts/no-eval-in-oss.mjs`](../scripts/no-eval-in-oss.mjs) (`npm run
gate:no-eval` from the repo root; `cd cli && npm run gate:no-eval` also
works). The gate denies three things across `cli/src/**`, `cli/scripts/**`,
and `packages/**`:

1. **Known deleted paths reappearing** — `src/evaluator/`, `src/matrix/`,
   `src/score/`, `packages/correlator/`, and the retired local-scoring CLI
   entrypoints must stay gone.
2. **File names that look like an evaluator** — any file whose name starts
   with `correlate`, `score`, `judge`, or `verdict` (case-insensitive), no
   matter where it lives. If your change legitimately needs a name like
   that, it almost certainly belongs in pome-cloud instead.
3. **Forbidden imports** — the local correlator/judge/matcher packages, or
   any import that reintroduces local scoring into the OSS CLI.
