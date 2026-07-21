# Linear twin fidelity

Heat × fidelity per [`ENDPOINT-TIERS.md`](../sdk/ENDPOINT-TIERS.md). Machine-readable twin: [`fidelity.inventory.json`](fidelity.inventory.json).

## MCP launch tools (18)

| Surface | Heat | Fidelity | Justification |
| --- | --- | --- | --- |
| `list_issues` | hot | semantic | `TC:issue-triage`; `MCP:list_issues` |
| `get_issue` | hot | semantic | `TC:issue-triage`; `MCP:get_issue` |
| `save_issue` | hot | semantic | `TC:issue-create\|issue-triage`; `MCP:save_issue` (create+update) |
| `list_comments` | hot | semantic | `TC:comment`; `MCP:list_comments` |
| `save_comment` | hot | semantic | `TC:comment`; `MCP:save_comment` |
| `list_teams` | hot | semantic | `TC:issue-create`; `MCP:list_teams` |
| `get_team` | warm | shape | `MCP:get_team` |
| `list_users` | hot | semantic | `TC:issue-create`; `MCP:list_users` |
| `get_user` | warm | shape | `MCP:get_user` |
| `list_issue_statuses` | hot | semantic | `TC:issue-triage`; `MCP:list_issue_statuses` |
| `get_issue_status` | warm | shape | `MCP:get_issue_status` |
| `list_issue_labels` | hot | semantic | `TC:issue-triage`; `MCP:list_issue_labels` |
| `create_issue_label` | warm | shape | `MCP:create_issue_label` |
| `list_projects` | warm | shape | `MCP:list_projects` |
| `get_project` | warm | shape | `MCP:get_project` |
| `save_project` | warm | shape | `MCP:save_project` (create+update) |
| `list_cycles` | warm | shape | `MCP:list_cycles` |
| `search_documentation` | cold | shape | `MCP:search_documentation` — static/empty twin docs |

## GraphQL (selected)

| Surface | Heat | Fidelity | Justification |
| --- | --- | --- | --- |
| `issues` / `issue` / issue mutations | hot | semantic | `TC:issue-triage\|issue-create` |
| `comments` / comment mutations | hot | semantic | `TC:comment` |
| `teams` / `users` / `workflowStates` | hot | semantic | Context for agent chains |
| `issueLabels` / label mutations | hot | semantic | Triage labels |
| `projects` / `cycles` | warm | shape | Adjacent PM context |
| `webhooks` / webhook mutations | hot | semantic | `TC:webhook-integrate` |
| agent session / activity mutations | warm | shape | Emulate agent subset; MCP-absent |
| OAuth authorize/token/revoke | hot | semantic | `TC:oauth-app` |

## Named cold / unsupported

| Surface | Heat | Fidelity | Notes |
| --- | --- | --- | --- |
| Documents MCP tools | cold | unsupported | Out of Gate 0 launch set |
| Full Linear schema tail | cold | unsupported | Loud GraphQL / 501 |

## Tier-mismatch ledger

_(empty at launch)_
