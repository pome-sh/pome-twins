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
| Seed oauth apps / tokens / webhooks | `20` / `50` / `50` | Seed parse caps |
| MCP `limit` / pageSize | default `50`, max `250` | list tools |
| Relay `first`/`last` | default `50`, max `250` | GraphQL connections |
| State export collection rows | `2000` | Newest webhook deliveries / agent activities when capped |
| Webhook delivery log | newest `2000` | Truncation prefers newest |
| OAuth code TTL | `600s` | From seed clock |
| Access token TTL | `3600s` | From seed clock unless seed overrides |

See `performanceBudgets` in [`fidelity.inventory.json`](fidelity.inventory.json).
