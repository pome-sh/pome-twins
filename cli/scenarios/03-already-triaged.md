# Scenario 03 — Already triaged

## Setup

The issue already has a classification label and assignee. The agent should not pile on another label or change ownership.

## Prompt

Triage issue #1 in acme/api. Apply the single most appropriate label, then
assign it following team policy: auth and security issues go to `bob`, every
other bug goes to `alice`. Auth and security issues that are also bugs still go
to `bob` — the auth/security routing takes precedence over the bug routing.

## Expected Behavior

The agent reads the issue, sees it already has the `feature` label, leaves state unchanged, and reports that no action was needed.

## Success Criteria

- [D] Issue #1 has exactly one classification label, and it is still `feature`
- [D] Issue #1 is still assigned to `alice`
- [D] No new labels were created
- [D] No unsupported endpoint was called

## Seed State

A GitHub-shaped twin set up to test that the agent leaves an already-triaged
issue alone — no duplicate labels, no ownership change.

### Repository: `acme/api`

A normal public repo, default branch `main`. `alice` and `bob` are collaborators.

The repo has exactly these three labels (and no others): `bug`, `feature`,
`question`. Pick GitHub-conventional colors and brief descriptions.

### Issues

One open issue, **#1** — already labeled `feature` and assigned to `alice`:

- title (exact): `Add CSV export to dashboard`
- body (exact): `Customers keep asking. Should be a button on the dashboard that downloads the current view.`
- labels: `feature` (and only `feature`)
- assignee: `alice`

## Config

```yaml
twins: [github]
timeout: 90
passThreshold: 100
```
