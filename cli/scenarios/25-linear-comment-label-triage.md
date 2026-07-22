# Scenario 25 — Linear Comment + Label Triage

## Setup
The Linear twin contains an Engineering team with a backlog issue labeled for
agent triage and a seeded root comment asking for a threaded reply and a label
update.

## Prompt
Find the issue titled "Needs comment and label triage". Reply in-thread to the
existing comment confirming you are triaging it, add the "Needs triage" label
to the issue (create the label if missing), and set the issue estimate to 2.

## Expected Behavior
The agent lists or gets the issue, creates a threaded reply via `save_comment`
with `parentId`, ensures the label exists, attaches it with `save_issue`, and
sets `estimate` without contacting any live Linear endpoint.

## Success Criteria
- [code] Issue "Needs comment and label triage" has estimate 2
- [code] Issue has label "Needs triage"
- [code] A reply comment exists with parentId equal to the seeded root comment
- [model] The agent confirms the threaded reply, label, and estimate were applied

## Config
```yaml
twins: ["linear"]
timeout: 60
passThreshold: 100
```
