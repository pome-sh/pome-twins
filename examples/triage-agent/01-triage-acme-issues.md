# Triage open issues in acme/api

The bundled happy-path scenario for the triage agent. The default Pome twin
seed ships one open issue (`#1` — a 500 error after deploy in `acme/api`). The
agent should read it, classify it as a `bug`, apply the label, and post a
one-sentence reasoning comment.

## Setup

Uses the default GitHub twin seed:

- Repository `acme/api`
- Labels already exist: `bug`, `feature`, `question`
- Collaborators: `alice`, `bob`, `pome-agent`
- One open issue, number `1`:
  - Title: `500 error on POST /orders after deploy`
  - Body: `Started failing right after the 14:00 deploy. Stack trace points to OrderController#create.`
  - Labels: none
  - Assignees: none

## Prompt

Triage every open issue in acme/api. For each issue, read it, decide whether
it is a bug, feature request, or question, apply the matching label, then
post a one-sentence comment summarizing the reason for the classification.
Use only the existing repository labels — do not invent new ones.

## Expected Behavior

The agent reads issue `#1`, recognizes it as a bug (regression after deploy
plus a stack trace), applies the `bug` label, posts a brief reasoning
comment, and stops.

## Success Criteria

- [D] Issue #1 has the `bug` label applied
- [D] No new labels were created on acme/api

## Config

```yaml
twins: [github]
timeout: 120
```
