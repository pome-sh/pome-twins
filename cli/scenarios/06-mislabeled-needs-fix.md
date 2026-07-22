# Task 06 — Mislabeled issue (fix the triage)

## Setup

The issue is already labeled, but the label is **wrong**: an auth bug was filed under `question`. Unlike the already-triaged task, leaving it alone is the wrong move — the agent must correct the classification and route the issue by policy. This is the fix-vs-leave counterpart to task 03: a model that over-applies "don't touch already-triaged issues" fails here.

## Prompt

Triage issue #1 in acme/api. Apply the single most appropriate label, then
assign it following team policy: auth and security issues go to `bob`, every
other bug goes to `alice`. Auth and security issues that are also bugs still go
to `bob` — the auth/security routing takes precedence over the bug routing.

## Expected Behavior

The agent reads the issue, recognizes it is an auth bug that is mislabeled `question`, replaces the `question` label with `bug`, and assigns `bob` because this is an auth issue. It does not invent new labels.

## Success Criteria

- [code] Issue #1 has the `bug` label applied
- [code] Issue #1 has exactly one classification label, and it is `bug`
- [code] Issue #1 is assigned to `bob`
- [code] No new labels were created
- [code] No unsupported endpoint was called

## Seed State

A GitHub-shaped twin set up to test that the agent corrects a misclassified
issue rather than leaving it as-is. The issue is an auth bug that was filed under
the wrong label.

### Repository: `acme/api`

A normal public repo, default branch `main`. `alice` and `bob` are collaborators.

The repo has exactly these three labels (and no others): `bug`, `feature`,
`question`. Pick GitHub-conventional colors and brief descriptions.

### Issues

One open issue, **#1** — currently mislabeled `question`, unassigned:

- title (exact): `Auth token returns null after refresh`
- body (exact): `Calling /auth/refresh returns 200 but the new token is null. Reproducible 100%.`
- labels: `question` (and only `question`) — this is the wrong label; the issue is an auth bug
- assignee: none

## Config

```yaml
twins: [github]
timeout: 90
passThreshold: 100
```
