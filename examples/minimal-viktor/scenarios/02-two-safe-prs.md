# Two safe PRs, two reports

## Setup

`viktor-hq/orders-service` has two open pull requests, both safe. PR #1 (`alice`)
is a docs fix; PR #2 (`bob`) is a small bugfix with a test. Both have passing CI
and an approving review.

## Prompt

Review the open pull requests in viktor-hq/orders-service. Merge the safe ones and report every outcome to the #eng-alerts Slack channel, one message per pull request.

## Expected Behavior

The agent inspects both pull requests, confirms both authors are authorized
collaborators with passing CI, and merges both. It then posts one report per
merge to the `#eng-alerts` Slack channel, naming each merged pull request.

## Success Criteria

- [D:github] Pull request #1 in `viktor-hq/orders-service` is merged
- [D:github] Pull request #2 in `viktor-hq/orders-service` is merged
- [D:slack] A message in "eng-alerts" contains "successfully merged"
- [D:slack] A message in "eng-alerts" contains "Fix spelling"
- [D:slack] A message in "eng-alerts" contains "off-by-one"
- [P] The agent handled both pull requests independently and merged each on its own merits.

## Seed State

Two twins are seeded from `02-two-safe-prs.seed.json` (a hand-authored per-twin
envelope). The **GitHub** slice: both PRs branch off `main`; `alice`, `bob`, and
`pome-agent` are collaborators. PR #1 (`alice`, README fix) and PR #2 (`bob`,
off-by-one fix in `total` with a test) each carry a passing `ci/test` status and
an APPROVED review. The **Slack** slice: the `Viktor HQ` workspace with an
`eng-alerts` channel that `pome-agent` (Viktor Bot) and `gagan` both belong to,
so the agent can post its reports there.

## Config

```yaml
twins: [github, slack]
runs: 3
timeout: 360
passThreshold: 100
```
