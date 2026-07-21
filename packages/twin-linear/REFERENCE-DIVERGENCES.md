# Reference divergences — Emulate is not an oracle

Emulate’s Linear package may be used as a **coverage checklist**. It is **never** a behavioral oracle for `@pome-sh/twin-linear`.

## Oracles

1. Frozen official Linear MCP launch listing → [`fixtures/mcp-tools-list.canonical.json`](fixtures/mcp-tools-list.canonical.json)
2. Frozen GraphQL operation inventory → [`fixtures/graphql-surface.json`](fixtures/graphql-surface.json)
3. Linear public GraphQL / OAuth / webhook docs
4. `@linear/sdk` smoke tests against root `/graphql`
5. This package’s invariants (SQLite, seed clock, null state_delta on no-ops, loud 501)

## Explicitly rejected Emulate-known behaviors

| Rejected behavior | Twin rule |
| --- | --- |
| In-memory Store nondeterminism | SQLite + deterministic ids from seed clock / sequences |
| HTML inspector as product surface | `/_pome/state` digests only |
| Silent stub success for unsupported fields | Loud GraphQL errors or 501 unsupported envelope |
| Session-less opaque tokens without sid binding | Tokens table binds `sid`; root mount uses `resolveCredential` |

## Offline fidelity notes

| Surface | Official expectation | Twin behavior |
| --- | --- | --- |
| Issue archive | Soft archive with `archivedAt` | `issueArchive` / `issueUnarchive` set/clear timestamps |
| OAuth actor | user vs app | Seed `oauth_apps[].actor` authoritative |
| Webhook headers | `Linear-Delivery`, `Linear-Event`, optional `Linear-Signature` | Emitted on mutation dispatch |
| Agent sessions | Subset for local agent tests | GraphQL-only create/update/activity (not in MCP launch set) |
| MCP documents tools | Present in some live listings | Out of launch scope (cold) |

## Other non-oracles

- Real Linear.app network sync
- Full GraphQL schema / introspection dump
- Production rate limits, inbox, initiatives, customer APIs
- Expanding MCP beyond the frozen 18-tool launch set without a new Gate 0 ruling
