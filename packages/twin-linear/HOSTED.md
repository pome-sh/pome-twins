# Hosted Linear handoff

The OSS package and CLI are release-ready independently of hosted support.
Pome Cloud must complete this consumer gate before advertising hosted Linear:

1. Add `linear` to the mounted/provisionable twin registry and consume
   `@pome-sh/shared-types` with `linearSeedStateSchema`.
2. Mint the session JWT with
   `linear_email: "admin@pome-twin.test"` by default, or the normalized
   primary admin email from the accepted Linear seed.
3. Do **not** add `provider_credentials.linear`. Return the normal
   `agent_token`; clients expose it as both `POME_AUTH_TOKEN` and
   `POME_LINEAR_TOKEN`. Seeded personal tokens such as `lin_test_admin` remain
   a local/dev convenience via `resolveCredential`.
4. Route the signed `ghcr.io/pome-sh/twins:linear-*` digest and publish Linear
   `api_url`, `mcp_url`, and `openapi_url` entries under `per_twin.linear`.
5. Forward the Linear seed unchanged to the pod, capture `/_pome/state` and
   `/_pome/events`, and retain OAuth/token projection redaction.
6. Run the packaged official-client, twenty-tool MCP parity, and multi-twin
   scenarios against the hosted route before enabling the product flag.
7. Add the signed digest to fidelity watch/dashboard registration.

Until that gate passes, documentation must describe Linear as local/OSS-ready,
not hosted-ready.
