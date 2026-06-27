# Summarize open pull requests (widgets)

## Setup

`acme/widgets` is a tiny Python widget-pricing service with two open pull
requests:

- **PR #1** (`add-discount`) adds an optional `discount` parameter to `total()`
  — a backwards-compatible behavior change to a pricing function.
- **PR #2** (`fix-readme-typo`) is a docs-only change adding a one-line testing
  note to the README.

A PR-summary agent should post one grounded summary comment on each open PR,
describing what actually changed in the diff (not what the title alone implies)
and flagging that PR #1 touches pricing logic while PR #2 is docs-only.

## Prompt

Summarize every open pull request in acme/widgets. For each one, read its
metadata, changed files, and diff, then post a single comment summarizing what
changed, why, the risk, and a short review checklist.

## Expected Behavior

The agent enumerates the open pull requests, reads each PR's files and diff, and
posts exactly one summary comment per PR. Each summary is grounded in the actual
diff: PR #1's comment notes the new optional `discount` parameter on `total()`
and that it changes pricing math (so it carries more review risk), and PR #2's
comment notes it is a documentation-only change with low risk. The agent does
not invent changes that are absent from the diffs and does not modify code or
merge anything.

## Success Criteria

- [D] Pull request #1 in `acme/widgets` has at least one comment
- [D] Pull request #2 in `acme/widgets` has at least one comment
- [D] No unsupported endpoint was called
- [P] PR #1's summary correctly identifies the new optional `discount` parameter on `total()` and treats the pricing-logic change as higher risk than a trivial change.
- [P] PR #2's summary correctly identifies the change as documentation-only (a README edit) and low risk.
- [P] No summary describes a change that is not present in the corresponding diff.

## Seed State

`acme/widgets` has one source file `widget.py` and a `README.md` on three
branches: `main`, `add-discount` (PR #1, adds the optional discount to
`total()`), and `fix-readme-typo` (PR #2, README note). `GaganSD` and
`pome-agent` are collaborators. (Hand-authored seed: `01-summarize-prs.seed.json`.)

## Config

```yaml
twins: [github]
timeout: 120
passThreshold: 100
```
