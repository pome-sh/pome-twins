# @pome-sh/twin-github — CHANGELOG

All notable changes to the GitHub twin are documented here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the package follows [Semantic Versioning](https://semver.org/).

## 0.2.0 — 2026-07-16

Batches everything landed on main since 0.1.2 whose versions were never cut
(the publish workflow skips already-published versions, so npm 0.1.2 had gone
stale against the repo):

- #122 — FIDELITY.md re-cut by the heat rubric and the M5 hot gaps filled; the
  packaged MCP tool surface grows 62 → 65 (`pome twin start github` now serves
  the consolidated FDRS-648 surface from npm, matching the repo).
- #116 — structured fidelity inventory (`fidelity.inventory.json`) shipped as
  the machine-readable seam source of truth.
- #128 / #109 — `@pome-sh/sdk` pinned to 0.4.0: the twin self-generates
  `TWIN_AUTH_SECRET` on first non-loopback boot (`ensureTwinAuthSecret`).

Minor: the served REST/MCP fidelity surface changed shape.

## 0.1.2 — 2026-07-10

Dependency-only release for the node:sqlite driver swap (F-703):
`@pome-sh/sdk` pinned to 0.3.1 and the direct `better-sqlite3` dependency
dropped — the twin's install closure now has zero native modules. No twin
behavior changes.

## 0.1.1 — 2026-07-10

Dependency-only release: `@pome-sh/sdk` pinned to 0.3.0 (durable write-through
recorder) so the CLI bundle resolves a single sdk copy. No twin behavior
changes.

## 0.1.0 — 2026-07-09

First npm-published release (F-714).

A deterministic GitHub twin for agent testing — REST + MCP surfaces (repos,
issues, pull requests, reviews, collaborators, checks) over SQLite-backed
state, gated by the same push-access rules as the live API. Built as a thin
`@pome-sh/sdk` plugin (F-682): the twin declares its domain, tools, and
GitHub's frozen wire shapes; the engine owns HTTP mounting, bearer auth, the
recorder, MCP dispatch, and the admin gate.

### Added

- `twin-github` bin: boots via `node dist/src/server.js` per the twin runtime
  contract (`/CONTRACT.md`, v1.0.0) — `GET /healthz` within 3 s, refuses
  non-loopback binds without `TWIN_AUTH_SECRET`.
- GitHub REST + MCP tool surface with push-access-gated mutations and
  fidelity-annotated behavior (see `FIDELITY.md`).
- Seed control: built-in default seed, `POME_SEED_JSON` override,
  `GITHUB_CLONE_NO_SEED=1`, and `POST /admin/reset|seed`.
- Library entry point `createGitHubCloneApp` for in-process embedding (used
  by the `pome` CLI's `--local` harness).
