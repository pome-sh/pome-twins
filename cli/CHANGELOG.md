# Changelog

## 0.1.1

### Patch Changes

- [#103](https://github.com/pome-sh/pome-twins/pull/103) [`830164f`](https://github.com/pome-sh/pome-twins/commit/830164fab0f3c51b654878ae95934a17e3c5624b) Thanks [@AFFFPupu](https://github.com/AFFFPupu)! - Zero native dependencies: better-sqlite3 is gone from the install closure (F-704). The bundled twin engine now runs on the `node:sqlite` builtin (`@pome-sh/sdk` 0.3.1, twins 0.1.2/0.1.2/0.2.2), so `npm install`/`npx` needs no compiler toolchain. No behavior changes.

All notable changes to the `pome` CLI are documented here. The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/).

The full product changelog lives at https://docs.pome.sh/changelog. This file tracks CLI-package releases specifically.

## 0.1.0

First release under the package name **`@pome-sh/cli`** (F-727). The CLI was
previously published as `pome-sh`; that npm package is deprecated in place and
its 0.5.x–0.8.0 history is preserved below (npm never reuses published version
numbers, so this line restarts at 0.1.0). Same CLI, same `pome` command — only
the install name changes: `npx @pome-sh/cli` / `npm install -g @pome-sh/cli`.
The org-scoped name is deliberate: npm's name-similarity rule blocks the
unscoped `pomecli` (too close to the unrelated, long-abandoned `pome-cli`),
and scoped names are immune to that class of collision.

Requires Node.js ≥ 24.

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
- **Durable recording.** Twin HTTP events stream to the run's `events.jsonl`
  via the twin-core durable recorder, so local runs survive process death
  without duplicating finalize rows.
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

- `npm install -g @pome-sh/cli` now installs a runnable `pome` with no manual `chmod`.
- Various run-reliability fixes: correct upload format, environment parity
  between local and hosted runs, friendlier capacity messages, and cleanup of
  abandoned sessions on error.

### Removed

- Local scoring, the built-in judge, and the `pome matrix`, `pome matrix-html`,
  and `pome eval-report` commands, superseded by the capture-only model.

## Historical releases (published as `pome-sh`)

Everything below shipped on npm under the previous package name `pome-sh`,
now deprecated in favor of `@pome-sh/cli`. Those version numbers belong to that
package and are never reused.

## 0.8.0

### Minor Changes

- [#82](https://github.com/pome-sh/pome-twins/pull/82) [`427d44e`](https://github.com/pome-sh/pome-twins/commit/427d44e46eec0c6ee3867e3273fe54ad12e6db4c) Thanks [@GaganSD](https://github.com/GaganSD)! - Capture-only run-dir trim and meta.json contract.

  A completed run directory now contains exactly six files: `meta.json`, `events.jsonl`, `state_initial.json`, `state_final.json`, `stdout.txt`, and `stderr.log`. The intermediate correlation sidecars this CLI used to also write — `tool_calls.jsonl`, `state-before.json`, `state-after.json`, and `state-diff.json` — have been removed. They duplicated data already in `events.jsonl` / `state_initial.json` / `state_final.json` and only ever fed the local correlator/evaluator, which no longer runs in the OSS CLI. Consumers reading the removed files should read `events.jsonl` for the tool-call trace and `state_initial.json` / `state_final.json` for pre/post state.

  `meta.json` gains two additive fields: `spec_version` (the meta.json shape version) and `twin_versions` (a map of the installed twin package versions that produced the run). Older readers that ignore unknown keys are unaffected.

  `meta.json` is now uploaded alongside the trace and state blobs on the hosted `pome run`, `pome eval`, and `pome demo` paths (best-effort; a control plane that predates the meta upload route is tolerated).

- [#84](https://github.com/pome-sh/pome-twins/pull/84) [`f21c05a`](https://github.com/pome-sh/pome-twins/commit/f21c05aba95a073c81d691ceac81c23df621f633) Thanks [@GaganSD](https://github.com/GaganSD)! - BREAKING: requires Node.js ≥ 24 (previously ≥ 20). `engines.node` is now `>=24`. npm only warns on an engine mismatch, so on an older Node the CLI may still install but can fail at runtime — upgrade to Node 24 before updating. Provider dependencies are refreshed in the same release.

### Patch Changes

- [#63](https://github.com/pome-sh/pome-twins/pull/63) [`9ad94e1`](https://github.com/pome-sh/pome-twins/commit/9ad94e1a0333a8aacc23a7a1c26a652454f8281f) Thanks [@AFFFPupu](https://github.com/AFFFPupu)! - Conform the CLI to the engine-based twin-github: local Recorder interface replaces the twin's deleted type export; the standalone twin server signs with its env-pinned secret.

- [#62](https://github.com/pome-sh/pome-twins/pull/62) [`b967830`](https://github.com/pome-sh/pome-twins/commit/b967830ef25517be076cb49fe89b5d5d1f1d7c1d) Thanks [@AFFFPupu](https://github.com/AFFFPupu)! - Type the local slack twin harness recorder against the engine surface (the ported twin no longer exports a per-twin Recorder type).

- [#64](https://github.com/pome-sh/pome-twins/pull/64) [`7be004f`](https://github.com/pome-sh/pome-twins/commit/7be004f6aa92f46dde08c4e30ba3894a3718931a) Thanks [@AFFFPupu](https://github.com/AFFFPupu)! - Conform the local twin harness to the engine-based twin-stripe: the factory owns middleware, MCP mount, and the failure-injection store; the shared CLI recorder replaces the twin's deleted recorder exports.

- [#61](https://github.com/pome-sh/pome-twins/pull/61) [`91eb11a`](https://github.com/pome-sh/pome-twins/commit/91eb11a9d63ccb1effa39d5140eb2471acb2ded9) Thanks [@GaganSD](https://github.com/GaganSD)! - Use exact published `@pome-sh/*` package dependencies instead of vendored tarballs.

- [#85](https://github.com/pome-sh/pome-twins/pull/85) [`2b1142b`](https://github.com/pome-sh/pome-twins/commit/2b1142bffe05f798a1cf94b942502e0aa6e13a17) Thanks [@GaganSD](https://github.com/GaganSD)! - Point doctor/help copy at npm (and tsx) instead of Bun after the package-manager migration.

## [0.5.1] — 2026-05-20

### Added

- `pome init --sdk claude` scaffolds a Claude Agent SDK starter agent.
- `pome register agent <name>` registers an agent in the hosted control plane and threads `agentId` through subsequent hosted runs.
- Public-install path documented in README: `npm install -g github:pome-sh/cli#v0.5.1`.
- Cross-platform build: `prepare` script ensures `dist/` is built on `npm install` from git.

### Changed

- `prepublishOnly` and the build work with plain `npm` (no alternate package manager required).
- `@types/node` pinned to `^22` to match `engines.node": ">=20"`.
- Source maps no longer ship in the published tarball.

### Fixed

- Removed an internal local-machine path reference from a source comment.

## [0.5.0] — 2026-05-12

### Added

- Initial public-prep release: `pome init`, `pome login`, `pome session create|list|stop`, `pome run`, `pome inspect`, `pome fix-prompt`, `pome twin start|reset|status`, `pome docs`, `pome endpoints`, `pome version`, `pome health`.
- Local GitHub twin with curated REST surface and 35 MCP tools.
- Hosted-mode integration via the pome.sh control plane.
- Symlink-resolving entry point (works correctly under `npm link`).
