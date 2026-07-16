# Scenario 04 — Judge sees context (hosted-compatible)

## Setup

The repo `acme/api` already has an open bug (issue #1) pre-labeled `bug` via the sidecar seed `04-judge-context.seed.json`. (The twin's `defaultSeedState()` leaves issue #1 *unlabeled*, so this scenario ships its own sidecar — without it the correct no-op would fail the `[code]` label check.) The scenario is designed to exercise the `[model]` LLM-judge evaluator: the deterministic check confirms a label was applied; the probabilistic check evaluates whether that label is *contextually appropriate* given the issue's title and body.

## Prompt

Read issue #1 in acme/api and confirm its classification is correct (bug, feature, or question). The issue is already labeled — do not apply duplicate labels.

## Expected Behavior

The agent fetches issue #1, reads the title and body, sees it is already classified as a bug, and stops without applying duplicate labels.

## Success Criteria

- [code] Issue #1 has the `bug` label applied
- [model] The classification label on issue #1 is contextually appropriate given the issue's title and body

## Config

```yaml
twins: [github]
timeout: 60
passThreshold: 50
```
