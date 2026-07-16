# @pome-sh/twin-stripe — CHANGELOG

All notable changes to the Stripe twin are documented here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the package follows [Semantic Versioning](https://semver.org/).

## 0.2.3 — 2026-07-16

Strip trailing slashes from `twinBaseUrl` with an `endsWith`/`slice` loop
instead of `/\/+$/`, so CodeQL no longer flags a polynomial ReDoS on
library-controlled input. No API or behavior change.

## 0.2.2 — 2026-07-10

Dependency-only release for the node:sqlite driver swap (F-703):
`@pome-sh/sdk` pinned to 0.3.1 and the direct `better-sqlite3` dependency
dropped — the twin's install closure now has zero native modules. No twin
behavior changes.

## 0.2.1 — 2026-07-10

Dependency-only release: `@pome-sh/sdk` pinned to 0.3.0 (durable write-through
recorder) so the CLI bundle resolves a single sdk copy. No twin behavior
changes.

## 0.2.0 — 2026-07-09

First npm-published release (F-714).

A deterministic Stripe x402 machine-payments twin for agent testing — REST +
MCP surfaces (payment intents, refunds, balance) over SQLite-backed,
balance-consistent state. Built as a thin `@pome-sh/sdk` plugin (F-684): the
twin declares its domain, tools, and Stripe's frozen wire shapes; the engine
owns HTTP mounting, bearer auth, the recorder, MCP dispatch, and the admin
gate.

### Added

- `twin-stripe` bin: boots via `node dist/src/server.js` per the twin runtime
  contract (`/CONTRACT.md`, v1.0.0) — `GET /healthz` within 3 s, refuses
  non-loopback binds without `TWIN_AUTH_SECRET`.
- Stripe x402 REST + MCP tool surface with balance-consistent mutations and
  fidelity-annotated behavior (see `FIDELITY.md`).
- Seed control: built-in default seed, `POME_SEED_JSON` override,
  `STRIPE_CLONE_NO_SEED=1`, and `POST /admin/reset|seed`.
- Library entry points `createTwinStripeApp` and `StripeDomain` for
  in-process embedding (used by the `pome` CLI's `--local` harness).

## 0.1.0

Initial internal version (pre-engine, self-contained server). Never published.
