# Gmail twin fidelity

Heat × fidelity per [`ENDPOINT-TIERS.md`](../sdk/ENDPOINT-TIERS.md). Machine-readable twin: [`fidelity.inventory.json`](fidelity.inventory.json).

## MCP launch tools (13)

| Surface | Heat | Fidelity | Justification |
| --- | --- | --- | --- |
| `create_draft` | hot | semantic | MCP:create_draft (vendor default Gmail MCP toolset); TC:inbox-triage\|compose-draft\|label-triage. Live capture schem... |
| `list_drafts` | hot | semantic | MCP:list_drafts (vendor default Gmail MCP toolset); TC:inbox-triage\|compose-draft\|label-triage. Live capture schema... |
| `get_thread` | hot | semantic | MCP:get_thread (vendor default Gmail MCP toolset); TC:inbox-triage\|compose-draft\|label-triage. Live capture schemas... |
| `get_message` | hot | semantic | MCP:get_message (Gate-1 Developer Preview promotion); TC:inbox-triage. Live capture schemas frozen in fixtures/mcp-to... |
| `search_threads` | hot | semantic | MCP:search_threads (vendor default Gmail MCP toolset); TC:inbox-triage\|compose-draft\|label-triage. Live capture sch... |
| `label_thread` | hot | semantic | MCP:label_thread (vendor default Gmail MCP toolset); TC:inbox-triage\|compose-draft\|label-triage. Live capture schem... |
| `unlabel_thread` | hot | semantic | MCP:unlabel_thread (vendor default Gmail MCP toolset); TC:inbox-triage\|compose-draft\|label-triage. Live capture sch... |
| `apply_sensitive_thread_label` | hot | semantic | MCP:apply_sensitive_thread_label (Gate-1 Developer Preview promotion); TC:cleanup\|label-triage. Applies TRASH/SPAM a... |
| `list_labels` | hot | semantic | MCP:list_labels (vendor default Gmail MCP toolset); TC:inbox-triage\|compose-draft\|label-triage. Live capture schema... |
| `label_message` | hot | semantic | MCP:label_message (vendor default Gmail MCP toolset); TC:inbox-triage\|compose-draft\|label-triage. Live capture sche... |
| `unlabel_message` | hot | semantic | MCP:unlabel_message (vendor default Gmail MCP toolset); TC:inbox-triage\|compose-draft\|label-triage. Live capture sc... |
| `apply_sensitive_message_label` | hot | semantic | MCP:apply_sensitive_message_label (Gate-1 Developer Preview promotion); TC:cleanup\|label-triage. Applies TRASH/SPAM ... |
| `create_label` | hot | semantic | MCP:create_label (vendor default Gmail MCP toolset); TC:inbox-triage\|compose-draft\|label-triage. Live capture schem... |

## REST (semantic)

In-scope Gmail v1 REST rows share the deterministic domain with MCP. Full list: [`fidelity.inventory.json`](fidelity.inventory.json) (`rest[]`, fidelity `semantic`).

## Named cold / unsupported (loud 501)

| Surface | Heat | Fidelity | Justification |
| --- | --- | --- | --- |
| `POST /resumable/upload/gmail/v1/users/{userId}/messages/send (resumable)` | cold | unsupported | PS: resumable upload for users.messages.send declared by discovery but explicitly unsupported in launch — loud 501, n... |
| `POST /resumable/upload/gmail/v1/users/{userId}/messages (resumable)` | cold | unsupported | PS: resumable upload for users.messages.insert declared by discovery but explicitly unsupported in launch — loud 501,... |
| `POST /resumable/upload/gmail/v1/users/{userId}/messages/import (resumable)` | cold | unsupported | PS: resumable upload for users.messages.import declared by discovery but explicitly unsupported in launch — loud 501,... |
| `POST /resumable/upload/gmail/v1/users/{userId}/drafts (resumable)` | cold | unsupported | PS: resumable upload for users.drafts.create declared by discovery but explicitly unsupported in launch — loud 501, n... |
| `PUT /resumable/upload/gmail/v1/users/{userId}/drafts/{id} (resumable)` | cold | unsupported | PS: resumable upload for users.drafts.update declared by discovery but explicitly unsupported in launch — loud 501, n... |
| `POST /resumable/upload/gmail/v1/users/{userId}/drafts/send (resumable)` | cold | unsupported | PS: resumable upload for users.drafts.send declared by discovery but explicitly unsupported in launch — loud 501, no ... |
| `POST /gmail/v1/users/{userId}/watch` | cold | unsupported | PS: named gap — Pub/Sub watch/stop out of launch scope. Must return loud 501; never fake successful registration. Dis... |
| `POST /gmail/v1/users/{userId}/stop` | cold | unsupported | PS: named gap — Pub/Sub watch/stop out of launch scope. Must return loud 501; never fake successful registration. Dis... |

## Tier-mismatch ledger

_(empty)_

## Notes

- Inventory `gaps[]` is empty: measured unsupported surfaces live in `tools[]` / `rest[]` with `fidelity: unsupported`.
- Do not fake success for watch/stop, resumable upload, or filter `action.forward`.
- Gate 1 expands the MCP launch set from 10 → 13 to match the live Developer Preview `tools/list`.
