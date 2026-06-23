# Changelog

All notable changes to the `pome` CLI are documented here. The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/).

The full product changelog lives at https://docs.pome.sh/changelog. This file tracks CLI-package releases specifically.

## [Unreleased]

### Security
- Hosted-run `events.jsonl` upload now passes through the centralized redactor before leaving the machine. Previously only the local on-disk `events.jsonl` was redacted; the S3 blob the cloud judge reads was raw. Closes FDRS-401.
- Redactor extended with regex scrubs for OpenAI/Anthropic `sk-…` keys, GitHub `ghp_…` PATs, AWS `AKIA…` keys, JWTs, and PEM blocks — so secrets leaking through OTLP attributes, ToolUseEvent args, or twin request/response bodies are caught even when the field name is benign. `authorization`, `x-api-key`, and `cookie` keys are hard-redacted unconditionally.

### Changed
- **`pome inspect` now consumes the FDRS-398 unified `events.jsonl` schema.** Each event kind (TwinHttpEvent, LlmCallEvent, ToolUseEvent, ToolResultEvent, SubagentSpawnEvent, HookEvent) renders in its own section. A new "Trace health" report shows per-layer event counts (proxy / twin / CAS adapter) with expectation heuristics. Pre-M0 (legacy) recordings are detected and surfaced as a clear error with exit code 2 (`this run was produced by an older CLI version (pre-M0); rerun against current CLI to view`). Closes FDRS-403.
- **`pome run` now defaults to the hosted control plane.** Runs record to `app.pome.sh` without needing the `--hosted` flag.
- The `--hosted` flag is kept as a deprecated no-op for one release; passing it prints a one-line deprecation note and will be removed on the next minor bump.
- Help text, `pome init` next-steps output, `pome login` follow-up hint, `pome scenarios <twin>` next-step hint, the `pome register agent` file-header comment, and the Claude-SDK scaffold no longer mention `--hosted`.
- **Hosted runs now report the cloud's authoritative score on the `score:` line.** Per ADR-013 the cloud is the managed judge; the CLI no longer computes a local score for hosted runs and no longer POSTs to the deprecated `/v1/sessions/:id/result`. `pome run` now POSTs criteria definitions to `POST /v1/sessions/:id/finalize` and prints the score the cloud returns (the same number the dashboard displays).

### Added
- `POME_LOCAL=1` environment variable opts back into the local in-process twin (engineer-only escape hatch, undocumented in customer-facing surfaces).
- `HostedClient.finalize(sessionId, input)` calls `POST /v1/sessions/:id/finalize` and returns `{ run_id, score, judge_model, dashboard_url }`. `HostedClient.submitResult` is retained as a `@deprecated` shim for one release.
- `HostedClient.requestStateUploadUrl(sessionId)` calls `POST /v1/sessions/:id/state-upload-url` and returns signed PUT URLs for `state_initial.json` / `state_final.json`. `pome run` now uploads both twin-state blobs in parallel with `events.jsonl` and passes the resulting storage keys into `/finalize`, so the cloud judge sees real state instead of `"{}"` on state-sensitive criteria. Closes FDRS-395.

### Fixed
- Customer false-green discovered while testing the auto-merge-bot example in `pome-cloud`: `pome run scenarios/` silently defaulted to local, scoring 3/3 PASS 100/100 while the same scenarios produced 1 PASS + 2 FAIL on the hosted twin. Closes FDRS-384.
- Hosted-run CLI/dashboard score divergence: stdout `score:` line could disagree with the dashboard for the same `run_id` because the CLI was printing a stale local-evaluator score while cloud judged authoritatively per ADR-013.

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
