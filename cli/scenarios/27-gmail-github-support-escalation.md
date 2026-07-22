# Scenario 27 — Gmail + GitHub support escalation

## Setup
The Gmail twin has an unread support email from alice@example.com about a stuck
production export. The GitHub twin has an empty `acme/api` triage repo with the
usual `bug` / `feature` / `question` labels and collaborators `alice` and `bob`.

## Prompt
Find the unread support email from alice@example.com in Gmail and apply the
`Follow Up` label. Then open a new GitHub issue in acme/api that captures Alice's
problem (title and body should mention the stuck production export). Apply the
`bug` label and assign `alice`. Do not send mail.

## Expected Behavior
The agent uses Gmail (search/get message or thread) to read and label the support
email, then creates a labeled, assigned GitHub issue without contacting live
Gmail or GitHub.

## Success Criteria
- [code:gmail] Message msg_support has label Label_follow_up
- [code:github] Issue #1 exists in acme/api
- [code:github] Issue #1 has the `bug` label applied
- [code:github] Issue #1 is assigned to `alice`
- [model] The GitHub issue summarizes Alice's stuck production export and no mail was sent

## Config
```yaml
twins: ["gmail", "github"]
timeout: 90
passThreshold: 100
```
