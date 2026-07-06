---
"pome-sh": patch
---

`pome run --local` now serves the packaged GitHub and Slack twins
(`@pome-sh/twin-github`, `@pome-sh/twin-slack`), vendored as
`cli/vendor/pome-sh-twin-{github,slack}-0.1.0.tgz` + `bundleDependencies`,
instead of divergent in-CLI copies. The `cli/src/twin-github` and
`cli/src/twin-slack` forks are deleted, completing the twin consolidation
(FDRS-648) begun with Stripe (FDRS-599/590): local runs and Docker runs now
execute one implementation per service.

Local GitHub runs pick up the full packaged surface the CLI copy lacked
(PRs, milestones, tags, releases, review comments, collaborators, access
control) and the CLI-only seed path for pull-request `reviews`/`statuses` is
reconciled into the package so seeded merge-gate scenarios keep working. The
CLI's vendored `@pome-sh/shared-types` is refreshed 0.3.0 → 0.6.0 because the
packaged GitHub twin's access-control surface reads its catalog from
shared-types. No behavior change for CLI users beyond the local/Docker parity
fix and the expanded local GitHub tool surface.
