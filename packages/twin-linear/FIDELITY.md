# Linear twin fidelity

Heat × fidelity per [`ENDPOINT-TIERS.md`](../sdk/ENDPOINT-TIERS.md). Machine-readable twin: [`fidelity.inventory.json`](fidelity.inventory.json).

## MCP launch tools (22)

| Surface | Heat | Fidelity | Justification |
| --- | --- | --- | --- |
| `list_issues` | hot | semantic | `TC:issue-triage`; `MCP:list_issues` |
| `get_issue` | hot | semantic | `TC:issue-triage`; `MCP:get_issue` |
| `save_issue` | hot | semantic | `TC:issue-create\|issue-triage`; estimate/parentId/relations |
| `list_comments` | hot | semantic | `TC:comment`; `MCP:list_comments` |
| `save_comment` | hot | semantic | `TC:comment`; threaded `parentId` |
| `delete_comment` | warm | semantic | Gate-1; GraphQL `commentDelete` parity |
| `list_teams` | hot | semantic | `TC:issue-create`; `MCP:list_teams` |
| `get_team` | warm | shape | `MCP:get_team` |
| `list_users` | hot | semantic | `TC:issue-create`; `MCP:list_users` |
| `get_user` | warm | shape | `MCP:get_user` |
| `list_issue_statuses` | hot | semantic | `TC:issue-triage`; `MCP:list_issue_statuses` |
| `get_issue_status` | warm | shape | `MCP:get_issue_status` |
| `list_issue_labels` | hot | semantic | `TC:issue-triage`; `MCP:list_issue_labels` |
| `create_issue_label` | warm | shape | `MCP:create_issue_label` |
| `list_projects` | warm | semantic | SQLite project CRUD + issue linkage |
| `get_project` | warm | semantic | SQLite project CRUD + issue linkage |
| `save_project` | warm | semantic | SQLite project create/update |
| `list_cycles` | warm | semantic | SQLite cycle list + issue linkage |
| `search_documentation` | cold | shape | `MCP:search_documentation` — static/empty twin docs |
| `list_documents` | warm | semantic | Gate-1 workspace documents (SQLite) |
| `get_document` | warm | semantic | Gate-1 workspace documents (SQLite) |
| `save_document` | warm | semantic | Gate-1 create/update with one parent |

## GraphQL (selected)

| Surface | Heat | Fidelity | Justification |
| --- | --- | --- | --- |
| `issues` / `issue` / issue mutations | hot | semantic | `TC:issue-triage\|issue-create`; estimate/parent |
| `comments` / comment mutations | hot | semantic | `TC:comment`; threaded parent; `commentDelete` |
| `teams` / `users` / `workflowStates` | hot | semantic | Context for agent chains |
| `issueLabels` / label mutations | hot | semantic | Triage labels |
| `projects` / `cycles` | warm | semantic | PM context backed by SQLite domain |
| `webhooks` / webhook mutations | hot | semantic | `TC:webhook-integrate` |
| agent session / activity mutations | warm | semantic | Emulate agent subset; MCP-absent |
| OAuth authorize/token/revoke | hot | semantic | `TC:oauth-app` |

## Named cold / unsupported

| Surface | Heat | Fidelity | Notes |
| --- | --- | --- | --- |
| Initiatives / milestones / releases MCP | cold | unsupported | Outside Gate-1 tool set |
| Full Linear schema tail | cold | unsupported | Loud GraphQL / 501 |
| Document parents: initiative | cold | unsupported | Twin accepts project/team/issue/cycle only |

## Opt-in OAuth scope denial

`seed.strictScopes` defaults to `false`. Enable it for tasks that mint
restricted tokens and expect Linear-like scope errors. With the flag on, GraphQL
and MCP writes share `LinearDomain.requireScopes`. JWT / provider sessions are
granted the full default scope set so common agent paths stay unblocked.

## Tier-mismatch ledger

_(empty at launch)_
