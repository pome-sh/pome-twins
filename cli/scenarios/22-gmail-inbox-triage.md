# Scenario 22 — Gmail Inbox Triage

## Setup
The Gmail twin contains one unread support email and a `Follow Up` label.

## Prompt
Find the unread support email from alice@example.com. Apply the `Follow Up`
label to the message and create a draft reply to Alice saying that the issue is
being investigated. Do not send the draft.

## Expected Behavior
The agent searches or reads the seeded thread, labels the message, and creates
one unsent draft without contacting any live Gmail endpoint.

## Success Criteria
- [code] Message msg_support has label Label_follow_up
- [code] A draft addressed to alice@example.com exists
- [model] The draft says the issue is being investigated and is not sent

## Config
```yaml
twins: ["gmail"]
timeout: 60
passThreshold: 100
```
