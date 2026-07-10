# @pome-sh/twin-slack — CHANGELOG

All notable changes to the Slack twin are documented here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the package follows [Semantic Versioning](https://semver.org/).

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

A deterministic Slack Web API twin for agent testing — REST + MCP surfaces
over SQLite-backed state, built as a thin `@pome-sh/sdk` plugin (F-683): the
twin declares its domain, tools, and Slack's frozen wire shapes
(`{ok:false, error}` envelopes on HTTP 200, form-or-JSON body parsing); the
engine owns HTTP mounting, bearer auth, the recorder, MCP dispatch, and the
admin gate.

### Added

- `twin-slack` bin: boots via `node dist/src/server.js` per the twin runtime
  contract (`/CONTRACT.md`, v1.0.0) — `GET /healthz` within 3 s, refuses
  non-loopback binds without `TWIN_AUTH_SECRET`.
- Slack Web API twin surface (channels, messages, reactions, files) as REST
  and MCP tools, with `SLACK_DETERMINISTIC_TS` for reproducible timestamps.
- Seed control: built-in default seed, `POME_SEED_JSON` override,
  `SLACK_CLONE_NO_SEED=1`, and `POST /admin/reset|seed`.
- Library entry points `createSlackTwinApp` and `slackTwinDefinition` for
  in-process embedding (used by the `pome` CLI's `--local` harness).
