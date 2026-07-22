# Hosted Gmail handoff

OSS package + CLI are release-ready independently of hosted support. Use this
checklist to split **OSS-ready** work from **cloud-owned** gating. No cloud
imports belong in this package.

## OSS-ready (this repo)

| Item | Status / note |
| --- | --- |
| Package `@pome-sh/twin-gmail` | Deterministic domain, REST, Gate-1 13-tool MCP |
| Registry id | `gmail` (twin id / CLI `--twin gmail`) |
| JWT claim | `gmail_email` — default local mailbox `pome-agent@pome-twin.test` |
| Agent token env | `POME_AUTH_TOKEN` + alias `POME_GMAIL_TOKEN` (same JWT) |
| Seed / admin | `/admin/seed`, `/admin/reset`, `/_pome/state`, `/_pome/events` |
| Image tag family | `ghcr.io/pome-sh/twins:gmail-*` (publish after CI + secret-scan) |
| Local tasks | Inbox triage, first-party MCP parity, multi-twin with GitHub |
| Fidelity artifacts | `fidelity.inventory.json`, `FIDELITY.md`, fixtures under `fixtures/` |

## Cloud-owned (Pome Cloud — not this repo)

Complete before advertising hosted Gmail:

1. **Registry** — Add `gmail` to the mounted/provisionable twin registry and
   consume a `@pome-sh/shared-types` version that includes `gmailSeedStateSchema`.
2. **JWT claims** — Mint the session JWT with
   `gmail_email: "pome-agent@pome-twin.test"` by default, or the normalized
   primary mailbox email from the accepted Gmail seed.
3. **Credentials** — Do **not** add `provider_credentials.gmail`. Return the
   normal `agent_token`; clients expose it as both `POME_AUTH_TOKEN` and
   `POME_GMAIL_TOKEN`.
4. **Digest routing** — Route the signed `ghcr.io/pome-sh/twins:gmail-*`
   digest (cosign-verify + pin). Publish Gmail `api_url`, `mcp_url`, and
   `openapi_url` under `per_twin.gmail`.
5. **Pod seed / capture** — Forward the Gmail seed unchanged to the pod,
   capture `/_pome/state` and `/_pome/events`, retain MIME/attachment
   projection redaction.
6. **Hosted verification** — Run official-client, thirteen-tool MCP parity,
   and multi-twin tasks against the hosted route before enabling the
   product flag.
7. **Fidelity watch** — Register the signed digest on the fidelity
   dashboard/watch list.

Until that gate passes, documentation must describe Gmail as **local/OSS-ready**,
not hosted-ready.
