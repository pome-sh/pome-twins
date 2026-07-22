# Task 00 — Default seed triage (hosted-compatible)

## Setup

The repo `acme/api` already has an open bug (issue #1) labeled `bug` from the default seed. This task does not provide a custom `## Seed State` block — both self-host (`runScenario`) and hosted (`runScenarioHosted`) fall back to the GitHub twin's `defaultSeedState()`, so the run state is identical in both modes.

## Prompt

Triage issue #1 in acme/api.

## Expected Behavior

The agent reads the issue, sees it is already classified as a bug, and stops without applying duplicate labels or creating new ones.

## Success Criteria

- [code] Issue #1 has the `bug` label applied
- [code] No new labels were created
- [code] No unsupported endpoint was called

## Config

```yaml
twins: [github]
timeout: 60
passThreshold: 100
```
