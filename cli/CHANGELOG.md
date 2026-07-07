# Changelog

All notable changes to the `pome` CLI are documented here. The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/).

The full product changelog lives at https://docs.pome.sh/changelog. This file tracks CLI-package releases specifically.

## [Unreleased]

## [0.7.0] — 2026-07-XX

First public release of the `pome` CLI — a capture-only tool for testing AI
agents against resettable digital twins. `pome run` records what your agent
does; the verdict comes from Pome's hosted evaluation.

### Added
- **`pome run`** records your agent against a digital twin. Runs hosted by
  default; `--local` (or `POME_LOCAL=1`) boots an in-process twin and records a
  raw trace offline.
- **`pome run <task> -n <k>`** runs `k` isolated trials of one task as a group
  and reports per-trial results plus a reliability summary.
- **`pome init`** scaffolds a starter agent and `pome.config.json`; `--sdk claude`
  scaffolds a Claude Agent SDK starter.
- **`pome register agent <name>`** registers an agent so runs group under it.
- **`pome demo`** — zero-signup cold start: boots a local GitHub twin, runs a
  bundled demo agent, and prints a shareable preview link. No login required.
- **`pome eval <run-dir>`** uploads an existing trace directory for scoring and
  prints the result.
- **`pome install`** wires Pome into your repo through your coding agent, showing
  a full diff for approval before writing anything, then verifies the setup with
  `pome doctor`.
- **`pome doctor`** checks your wiring — config, twin reachability, request
  routing, and the egress allowlist — and prints one named cause plus one
  concrete fix on failure.
- **`pome capture-server`** — a CONNECT-tunnel proxy that records one event per
  outbound LLM call. No CA install; `pome run` starts it automatically.
- **`pome inspect`** renders a recorded run — twin HTTP, LLM calls, tool calls,
  subagents, and hooks — with a per-layer trace-health summary.
- **`pome session`** — `create`, `list` (with a `--state` filter, default
  `running`), and `stop`, with copy-pasteable URLs in the text output.
- **`pome scenarios`** lists the bundled GitHub, Stripe, and Slack scenarios;
  `--copy` writes them into your project.
- **Agent telemetry** — hosted runs emit OpenTelemetry spans per LLM turn
  (model, tokens, latency).

### Changed
- **Capture-only.** The CLI records traces; it no longer scores runs locally.
  `pome fix-prompt` now assembles a ready-to-paste prompt from a recorded trace
  instead of calling an LLM.
- **Bundled twins.** The GitHub, Slack, and Stripe twins ship as packaged
  dependencies, so local and Docker runs behave identically.
- **Exit codes** follow a documented `0–5` contract across pre-flight and
  post-run paths (see the README).
- **`--api-url`** now takes effect as documented; a stored login URL no longer
  overrides it.

### Security
- **Deny-by-default egress.** Outbound connections to non-allowlisted hosts are
  refused and recorded. The allowlist covers your twins, LLM providers, and
  loopback; extend it with `POME_EGRESS_ALLOW`.
- **Secret redaction.** Recorded traces scrub common secret shapes before
  anything is written to disk or uploaded — OpenAI/Anthropic keys, GitHub
  tokens, AWS keys, JWTs, PEM blocks, and Stripe, Slack, and Google keys.
  `authorization`, `x-api-key`, and `cookie` are always redacted. The JWT and
  PEM scrubs run in linear time (ReDoS-safe).
- **Twin admin endpoints** require a timing-safe token when configured and are
  loopback-only otherwise.

### Fixed
- `npm install -g pome-sh` now installs a runnable `pome` with no manual `chmod`.
- Various run-reliability fixes: correct upload format, environment parity
  between local and hosted runs, friendlier capacity messages, and cleanup of
  abandoned sessions on error.

### Removed
- Local scoring, the built-in judge, and the `pome matrix`, `pome matrix-html`,
  and `pome eval-report` commands, superseded by the capture-only model.

## [0.5.1] — 2026-05-20

### Added
- `pome init --sdk claude` scaffolds a Claude Agent SDK starter agent.
- `pome register agent <name>` registers an agent in the hosted control plane and threads `agentId` through subsequent hosted runs.
- Public-install path documented in README: `npm install -g github:pome-sh/cli#v0.5.1`.
- Cross-platform build: `prepare` script ensures `dist/` is built on `npm install` from git.

### Changed
- `prepublishOnly` and the build no longer require `bun`; plain `npm` works.
- `@types/node` pinned to `^22` to match `engines.node": ">=20"`.
- Source maps no longer ship in the published tarball.

### Fixed
- Removed an internal local-machine path reference from a source comment.

## [0.5.0] — 2026-05-12

### Added
- Initial public-prep release: `pome init`, `pome login`, `pome session create|list|stop`, `pome run`, `pome inspect`, `pome fix-prompt`, `pome twin start|reset|status`, `pome docs`, `pome endpoints`, `pome version`, `pome health`.
- Local GitHub twin with curated REST surface and 35 MCP tools.
- Hosted-mode integration via the pome.sh control plane.
- Symlink-resolving entry point (works correctly under `npm link` / `bun link`).
