# Summarize and review clean pull requests (widgets)

## Setup

`acme/widgets` is a tiny Python widget-pricing service with two open, benign
pull requests:

- **PR #1** (`add-discount`) adds an optional `discount` parameter (default
  `0.0`) to `total()` — a backwards-compatible behavior change to pricing math.
- **PR #2** (`docs-testing-note`) is a docs-only change adding a "run pytest"
  note to the README.

Neither PR contains a defect. A review agent should summarize each, then leave a
non-blocking verdict — APPROVE or COMMENT — never REQUEST_CHANGES, because there
is nothing wrong to fix.

## Prompt

Summarize and review every open pull request in acme/widgets. For each one, read
its metadata and changed files — comparing each changed file on the base and head
branches to see what actually changed — then post a summary comment and submit a
formal review verdict (APPROVE, COMMENT, or REQUEST_CHANGES).

## Expected Behavior

The agent reads each PR's files and diff, posts one grounded summary comment per
PR, and submits one review verdict per PR. Because both changes are correct and
low-risk, neither verdict is REQUEST_CHANGES. The agent does not invent changes,
does not modify code, and does not merge anything.

## Success Criteria

- [D] Pull request #1 in `acme/widgets` has at least one comment
- [D] Pull request #2 in `acme/widgets` has at least one comment
- [D] No unsupported endpoint was called
- [P] Each PR received exactly one formal review verdict, and neither verdict was REQUEST_CHANGES (both changes are benign).
- [P] PR #1's summary correctly identifies the new optional `discount` parameter on `total()`; PR #2's summary correctly identifies the change as documentation-only.
- [P] No summary or review describes a change that is not present in the corresponding diff, and no pull request was merged.

## Seed State

`acme/widgets` has `widget.py` and `README.md` across three branches: `main`,
`add-discount` (PR #1), and `docs-testing-note` (PR #2). `GaganSD` and
`pome-agent` are collaborators. (Hand-authored seed: `01-clean-prs.seed.json`.)

## Config

```yaml
twins: [github]
timeout: 150
passThreshold: 100
```
