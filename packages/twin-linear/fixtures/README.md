# Linear twin fixtures (Gate 0 oracles)

Immutable upstream captures / freezes for `@pome-sh/twin-linear`.

| Path | Role |
| --- | --- |
| `mcp-tools-list.canonical.json` | Launch 18-tool MCP listing oracle (`save_*` upserts) |
| `graphql-surface.json` | Frozen GraphQL query/mutation operation inventory |

Normal tests must not require Linear credentials. Refresh MCP schemas only with a new Gate 0 ruling.
