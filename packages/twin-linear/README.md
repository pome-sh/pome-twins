# `@pome-sh/twin-linear`

Deterministic Linear-shaped twin for agent testing (Pome).

**Status: OSS release candidate.** This package includes the deterministic
SQLite workspace model, strict seed/reset APIs, GraphQL + OAuth surfaces,
bounded semantic state export, recording projection, and the captured
twenty-tool first-party MCP contract.

## Auth identity (frozen)

| Item | Value |
| --- | --- |
| Claim | `linear_email` on the Pome session JWT |
| Default local email | `admin@pome-twin.test` |
| Agent token env | `POME_LINEAR_TOKEN` (alias of `POME_AUTH_TOKEN`) |
| Seeded personal token | `lin_test_admin` (resolved via `resolveCredential`) |
| Provider token prefix | `lin_pome_` |
| Bearer | Pome session JWT, seeded Linear tokens, or `lin_pome_*` |

Pome owns hosted authentication. Local runs also accept DB-backed Linear API
tokens from the seed for official-client parity.

## Gate 0 artifacts

| Path | Role |
| --- | --- |
| [`fixtures/graphql-surface.json`](fixtures/graphql-surface.json) | Frozen GraphQL query/mutation/OAuth operation floor |
| [`fixtures/mcp-tools-list.canonical.json`](fixtures/mcp-tools-list.canonical.json) | Official Linear MCP launch set (18 tools) |
| [`fidelity.inventory.json`](fidelity.inventory.json) | Heat × fidelity × evidence for every launch MCP/GraphQL row |
| [`REFERENCE-DIVERGENCES.md`](REFERENCE-DIVERGENCES.md) | Emulate rejected; never an oracle |
| [`LIMITS.md`](LIMITS.md) | Seed/GraphQL/MCP/state-export caps |

See [`fixtures/README.md`](fixtures/README.md) for capture provenance.

## Launch MCP tools (exactly 18)

`list_issues`, `get_issue`, `save_issue`, `list_comments`, `save_comment`,
`list_teams`, `get_team`, `list_users`, `get_user`, `list_issue_statuses`,
`get_issue_status`, `list_issue_labels`, `create_issue_label`, `list_projects`,
`get_project`, `save_project`, `list_cycles`, `search_documentation`.

Order and names are frozen from the current official Linear MCP listing
(`save_*` upserts). Documents tools are **out of launch scope** (named cold
in the inventory). GraphQL still exposes `issueCreate`/`issueUpdate` for SDK
parity.

## Named gaps (not fake success)

- Documents MCP tools — out of Gate 0 launch set
- Full Linear GraphQL schema tail — loud unsupported / 501
- External webhook delivery beyond logged attempts

## Non-goals

- Live Linear network calls
- Expanding MCP beyond the frozen 18-tool launch set without a new Gate 0 ruling
- Hosted product enablement (see [`HOSTED.md`](HOSTED.md))

## Limits

See [`LIMITS.md`](LIMITS.md). Defaults/maxima are pinned in
`fidelity.inventory.json` `performanceBudgets`.

## Stateful parity with other first-party twins

Linear follows the same SDK chassis as GitHub / Slack / Stripe / Gmail:

| Capability | Linear | Notes vs peers |
| --- | --- | --- |
| `defineTwin` + SQLite domain | yes | Same `@pome-sh/sdk` boot path |
| `/_pome/state` | yes | Bounded collection rows |
| `/_pome/events` + durable recorder | yes | `recordingProjection` redacts secrets |
| `/admin/reset` + `/admin/seed` | yes | Reports `state_delta` |
| MCP + GraphQL on one domain | yes | `LinearCommands` |
| Session identity claim | `linear_email` | Peers use provider-shaped claims |
| Root session mount | yes | `mountSessionAtRoot: true` |

## Development

```bash
npm test -w @pome-sh/twin-linear
npm run typecheck -w @pome-sh/twin-linear
npm run fidelity:parity -w @pome-sh/twin-linear
```

## CLI

```bash
npx @pome-sh/cli twin start linear
# prints POME_LINEAR_REST_URL, POME_LINEAR_MCP_URL, POME_AUTH_TOKEN,
# and the identical POME_LINEAR_TOKEN alias
```

Use `pome scenarios linear --copy` for the issue-triage scenario. Hosted
rollout is gated separately; see [`HOSTED.md`](HOSTED.md).
