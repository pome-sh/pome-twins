# Gmail twin fixtures (Gate 0/1 oracles)

Immutable upstream captures for `@pome-sh/twin-gmail`. Normal tests must not require Google credentials.

## REST

| File | Purpose |
| --- | --- |
| `gmail-discovery-v1.raw.json` | Raw Gmail API v1 discovery document |
| `gmail-discovery-v1.meta.json` | Capture date + SHA-256 |
| `rest-surface.json` | Frozen launch REST method/parameter/media matrix |

## MCP

| File | Purpose |
| --- | --- |
| `mcp-tools-list.raw.json` | Live unauthenticated `tools/list` (13 tools as returned) |
| `mcp-tools-list.canonical.json` | Gate-1 launch 13-tool listing oracle (schemas from live capture) |
| `mcp-tools-list.meta.json` | Endpoint, protocol version, SHA-256, Gate-1 promotions |
| `mcp-initialize.raw.json` / `.meta.json` | Live `initialize` (protocolVersion) |
| `mcp-tools-call-unauth-error.raw.json` | Live unauthenticated `tools/call` error envelope |
| `mcp-tools-call.representative.json` | Schema-derived representative success call shapes |

### Provenance notes

- `tools/list` and `initialize` were captured live without OAuth on 2026-07-20 against `https://gmailmcp.googleapis.com/mcp/v1`.
- Authenticated `tools/call` success was **not** available; representative success fixtures are reconstructed from live `outputSchema` + public docs and are marked as such.
- Gate 1 expands the OSS launch set to the full live 13-tool listing, promoting `get_message`, `apply_sensitive_thread_label`, and `apply_sensitive_message_label` that Gate 0 treated as preview drift.
