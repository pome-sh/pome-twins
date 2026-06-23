# Scenario 00 — Default seed triage (hosted-compatible)

## Setup

The repo `acme/api` already has an open bug (issue #1) labeled `bug` from the default seed. This scenario does not provide a custom `## Seed State` block — both self-host (`runScenario`) and hosted (`runScenarioHosted`) fall back to the GitHub twin's `defaultSeedState()`, so the run state is identical in both modes.

## Prompt

Triage issue #1 in acme/api.

## Expected Behavior

The agent reads the issue, sees it is already classified as a bug, and stops without applying duplicate labels or creating new ones.

## Success Criteria

- [D] Issue #1 has the `bug` label applied
- [D] No new labels were created
- [D] No unsupported endpoint was called

## Config

```yaml
twins: [github]
timeout: 60
passThreshold: 100
```
