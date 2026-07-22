# Hosted Linear handoff

OSS package + CLI are release-ready independently of hosted support. Use this
checklist to split **OSS-ready** work from **cloud-owned** gating. No cloud
imports belong in this package.

## OSS-ready (this repo)

| Item | Status / note |
| --- | --- |
| Package `@pome-sh/twin-linear` | Deterministic domain, GraphQL, launch MCP tools |
| Registry id | `linear` (twin id / CLI `--twin linear`) |
| JWT claim | `linear_email` — default admin `admin@pome-twin.test` |
| Agent token env | `POME_AUTH_TOKEN` + alias `POME_LINEAR_TOKEN` (same JWT) |
| Local tokens | Seeded personal tokens (e.g. `lin_test_admin`) via `resolveCredential` |
| Seed / admin | `/admin/seed`, `/admin/reset`, `/_pome/state`, `/_pome/events` |
| Image tag family | `ghcr.io/pome-sh/twins:linear-*` (publish after CI + secret-scan) |
| Local scenarios | Issue triage; multi-twin with GitHub |
| Fidelity artifacts | `fidelity.inventory.json`, `FIDELITY.md`, fixtures under `fixtures/` |

## Cloud-owned (Pome Cloud — not this repo)

Complete before advertising hosted Linear:

1. **Registry** — Add `linear` to the mounted/provisionable twin registry and
   consume `@pome-sh/shared-types` with `linearSeedStateSchema`.
2. **JWT claims** — Mint the session JWT with
   `linear_email: "admin@pome-twin.test"` by default, or the normalized
   primary admin email from the accepted Linear seed.
3. **Credentials** — Do **not** add `provider_credentials.linear`. Return the
   normal `agent_token`; clients expose it as both `POME_AUTH_TOKEN` and
   `POME_LINEAR_TOKEN`. Seeded personal tokens remain a local/dev convenience.
4. **Digest routing** — Route the signed `ghcr.io/pome-sh/twins:linear-*`
   digest (cosign-verify + pin). Publish Linear `api_url`, `mcp_url`, and
   `openapi_url` under `per_twin.linear`.
5. **Pod seed / capture** — Forward the Linear seed unchanged to the pod,
   capture `/_pome/state` and `/_pome/events`, retain OAuth/token projection
   redaction.
6. **Hosted verification** — Run official-client, launch-tool MCP parity, and
   multi-twin scenarios against the hosted route before enabling the product
   flag.
7. **Fidelity watch** — Register the signed digest on the fidelity
   dashboard/watch list.

Until that gate passes, documentation must describe Linear as **local/OSS-ready**,
not hosted-ready.
