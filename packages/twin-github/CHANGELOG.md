# @pome-sh/twin-github — CHANGELOG

All notable changes to the GitHub twin are documented here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the package follows [Semantic Versioning](https://semver.org/).

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
