# @pome-sh/twin-linear — CHANGELOG

## 0.1.0 — 2026-07-21

First public release of the deterministic Linear twin:

- Frozen GraphQL + OAuth surface with SQLite-backed LinearCommands.
- Captured twenty-tool first-party Linear MCP listing and structured results.
- Deterministic seed/reset, webhooks log, bounded state export, and recorder
  payload projection.
- CLI, scenario, runtime-contract, package, and signed-image integration.

Authentication is Pome-owned for hosted runs. Local seeds include
`lin_test_admin` for `resolveCredential`, and `POME_LINEAR_TOKEN` aliases the
session JWT. There is no `provider_credentials.linear` contract.
