# Domain limits

Pinned limits enforced by seed, GraphQL, MCP, and OAuth paths.

| Limit | Value | Notes |
| --- | --- | --- |
| Issue title bytes | `512` | Loud reject above |
| Issue / comment body bytes | `65536` | Loud reject above |
| GraphQL query bytes | `100000` | Loud reject above |
| GraphQL selection depth | `20` | Loud reject above |
| Seed users / teams / issues | `500` / `50` / `5000` | Seed parse caps |
| Seed labels / projects / cycles | `500` / `200` / `200` | Seed parse caps |
| Seed documents | `500` | Seed parse caps |
| Seed oauth apps / tokens / webhooks | `20` / `50` / `50` | Seed parse caps |
| MCP `limit` / pageSize | default `50`, max `250` | list tools |
| Relay `first`/`last` | default `50`, max `250` | GraphQL connections |
| State export collection rows | `2000` | Newest webhook deliveries / agent activities when capped |
| Webhook delivery log | newest `2000` | Truncation prefers newest |
| OAuth code TTL | `600s` | From seed clock |
| Access token TTL | `3600s` | From seed clock unless seed overrides |

See `performanceBudgets` in [`fidelity.inventory.json`](fidelity.inventory.json).

## Scopes

- OAuth/API token **scope denial is opt-in fidelity**: set `seed.strictScopes: true`.
  The default (`false`) matches other twins — auth gate is always on; fine-grained
  Linear scopes are not enforced unless a task opts in.
- When `strictScopes` is on, write mutators call `requireScopes` (`write`,
  `issues:create`, `comments:create`; `admin` bypasses). JWT / `lin_pome_*`
  sessions receive the full default scope set.

## Webhooks

- Outbound delivery enforces a **default-deny SSRF policy**: loopback, private,
  link-local (incl. the `169.254.169.254` cloud metadata endpoint), unique-local,
  and other non-public destinations are refused at dispatch time, validated
  against the host's *resolved* addresses (a public name that resolves to an
  internal IP is blocked too). Refused attempts are logged with
  `error: "blocked_destination"` and never leave the process.
- Loopback/private delivery for trusted lab callbacks (often `127.0.0.1`) is
  opt-in via `LINEAR_TWIN_ALLOW_PRIVATE_WEBHOOKS=1` — an operator/deployment
  trust decision, never settable by the agent under test.
- URLs must be `http`/`https` without embedded credentials.
- Delivery `fetch` also refuses redirects (`redirect: "error"`) so an allowed
  public URL cannot bounce into link-local/metadata targets.

## Recording notes

- GraphQL and MCP writes go through `recorder.handle` / `reportDelta`.
- Public OAuth (`/oauth/authorize`, `/oauth/token`, `/oauth/revoke`) sits outside
  bearerAuth via `withPublicOAuth` and is **not** wrapped in `recorder.handle`.
  Secrets must stay out of `/_pome/state` and any incidental recorder payloads;
  covered by the OAuth canary matrix.
