# Domain limits

Phase 2 pins the limits enforced by strict seed, MIME, and search parsing.
REST-specific batch, pagination, and upload policy remains for Phase 3.

| Limit | Placeholder | Notes |
| --- | --- | --- |
| Raw MIME bytes (accept) | `36700160` | Checked before parse and after base64url decode |
| Decoded MIME bytes | `36700160` | Canonical raw upper bound |
| Header count / header bytes | `1000` / `262144` | Folded headers count after unfolding |
| MIME parts / nesting depth | `500` / `20` | Multipart boundaries fail loudly |
| Recipients (To+Cc+Bcc) | `500` per field in seeds | Send delivery is deduplicated by normalized address |
| Attachment count / filename bytes / attachment bytes | `100` / `512` / bounded by raw | Recording projects to `{sha256,size}` |
| `messages.send` / insert media `maxSize` (discovery) | `36700160` | From discovery; twin may lower |
| `messages.insert` / `import` media `maxSize` (discovery) | `157286400` | From discovery; twin may lower |
| Draft create/update media `maxSize` (discovery) | `36700160` | From discovery; twin may lower |
| Search query bytes / tokens / nesting / branches | `4096` / `256` / `20` / `256` | Shared AST for domain + filters |
| Labels per mailbox / per message | `5000` / `100` in seeds | |
| Filters per mailbox | `1000` in seeds | `action.forward` → 501 (no forwarding delivery) |
| Batch modify/delete ID count | TBD | |
| List `maxResults` / MCP `pageSize` | Discovery / tool schema | e.g. MCP search/list_drafts default 20, max 50 |
| SQLite bind parameters / query complexity | TBD | Parameterized SQL only |
| History page size | TBD | |
| Packaged boot | ≤ 3s | Contract gate (later) |

See `performanceBudgets` in [`fidelity.inventory.json`](fidelity.inventory.json).
