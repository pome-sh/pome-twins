# Hosted Gmail handoff

The OSS package and CLI are release-ready independently of hosted support.
Pome Cloud must complete this consumer gate before advertising hosted Gmail:

1. Add `gmail` to the mounted/provisionable twin registry and consume
   `@pome-sh/shared-types@0.11.0`.
2. Mint the session JWT with
   `gmail_email: "pome-agent@pome-twin.test"` by default, or the normalized
   primary mailbox email from the accepted Gmail seed.
3. Do **not** add `provider_credentials.gmail`. Return the normal
   `agent_token`; clients expose it as both `POME_AUTH_TOKEN` and
   `POME_GMAIL_TOKEN`.
4. Route the signed `ghcr.io/pome-sh/twins:gmail-*` digest and publish Gmail
   `api_url`, `mcp_url`, and `openapi_url` entries under `per_twin.gmail`.
5. Forward the Gmail seed unchanged to the pod, capture `/_pome/state` and
   `/_pome/events`, and retain MIME/attachment projection redaction.
6. Run the packaged official-client, ten-tool MCP parity, and multi-twin
   scenarios against the hosted route before enabling the product flag.
7. Add the signed digest to fidelity watch/dashboard registration.

Until that gate passes, documentation must describe Gmail as local/OSS-ready,
not hosted-ready.
