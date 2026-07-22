# Task 01 — Bug, happy path

## Setup

The repo already has the `bug`, `feature`, and `question` labels. The issue describes an orders bug.

## Prompt

Triage issue #1 in acme/api. Apply the single most appropriate label, then
assign it following team policy: auth and security issues go to `bob`, every
other bug goes to `alice`. Auth and security issues that are also bugs still go
to `bob` — the auth/security routing takes precedence over the bug routing.

## Expected Behavior

The agent reads the issue, classifies it as a bug, applies the `bug` label, assigns `alice`, and stops.

## Success Criteria

- [code] Issue #1 has the `bug` label applied
- [code] Issue #1 is assigned to `alice`
- [code] No new labels were created
- [code] No unsupported endpoint was called

## Seed State

A GitHub-shaped twin set up for issue triage.

### Repository: `acme/api`

A normal public repo, default branch `main`. `alice` and `bob` are collaborators.

The repo has exactly these three labels (and no others) — the test relies on
the agent picking one of them rather than inventing a new one. Pick
GitHub-conventional colors and brief descriptions:

- `bug` — for things that don't work
- `feature` — for new feature requests
- `question` — for clarifying questions

### Issues

One open issue, **#1** — no labels yet, unassigned:

- title (exact): `500 error on POST /orders after deploy`
- body (exact): `Started failing right after the 14:00 deploy. Stack trace points to OrderController#create.`

## Config

```yaml
twins: [github]
timeout: 60
passThreshold: 100
```
