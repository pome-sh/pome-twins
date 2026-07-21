# @pome-sh/twin-gmail — CHANGELOG

## 0.1.1 — 2026-07-21

Dependency-only patch: repin `@pome-sh/sdk` to 0.5.1 (F-818 batch). No twin
surface change.

## 0.1.0 — 2026-07-20

First public release of the deterministic Gmail twin:

- Broad frozen Gmail v1 REST and upload surface with loud named 501 gaps.
- Captured ten-tool first-party Gmail MCP listing and structured results.
- Deterministic SQLite mailbox state, MIME handling, search, history, labels,
  drafts, settings, bounded state export, and recorder payload projection.
- CLI, scenario, runtime-contract, package, and signed-image integration.

Authentication is Pome-owned. `POME_GMAIL_TOKEN` aliases the session JWT and
the package does not implement Google OAuth or add `provider_credentials.gmail`.
