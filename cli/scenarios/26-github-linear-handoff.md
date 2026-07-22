# Scenario 26 — GitHub + Linear handoff

## Setup
GitHub has an open bug in `acme/api` titled "500 error on POST /orders after
deploy". Linear has an Engineering team with backlog/todo/in-progress/done
states and an Agent label. No Linear issue for this bug exists yet.

## Prompt
Read GitHub issue #1 in acme/api. Create a matching Linear issue on the
Engineering team titled "Orders 500 after deploy", set it to In Progress, apply
the Agent label, and leave a comment that links the work to GitHub issue #1.

## Expected Behavior
The agent reads the GitHub issue, creates/updates a Linear issue with the right
state and label, and comments with a GitHub reference — without contacting live
GitHub or Linear.

## Success Criteria
- [code:github] Issue #1 in acme/api still exists and remains open
- [code:linear] An issue titled "Orders 500 after deploy" exists
- [code:linear] That issue is in state In Progress
- [code:linear] That issue has label Agent
- [code:linear] A comment exists on that issue mentioning GitHub issue #1
- [model] The Linear issue clearly handoffs the GitHub orders bug without inventing unrelated work

## Config
```yaml
twins: ["github", "linear"]
timeout: 90
passThreshold: 100
```
