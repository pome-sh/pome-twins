# Scenario 23 — Gmail First-Party MCP Parity

## Setup
The mailbox contains a multi-thread inbox (welcome, build+reply, support)
plus the parity seed message, two drafts, and user labels. This scenario
targets the captured first-party Gmail MCP launch contract.

## Prompt
Using only the Gmail MCP server, exercise all ten available Gmail tools:
create_draft, list_drafts, get_thread, search_threads, label_thread,
unlabel_thread, list_labels, label_message, unlabel_message, and create_label.
Use the seeded IDs where needed. Finish with the original message labeled
`STARRED`, create a label named `Parity Complete`, and leave at least two
drafts. Do not send mail.

## Expected Behavior
The agent observes exactly the captured ten-tool launch surface and completes a
stateful read/write chain without using live Google APIs.

## Success Criteria
- [code] Message msg_parity has label STARRED
- [code] A label named Parity Complete exists
- [code] At least two drafts exist
- [model] The run uses all ten first-party Gmail MCP tools and sends no mail

## Config
```yaml
twins: ["gmail"]
timeout: 90
passThreshold: 100
```
