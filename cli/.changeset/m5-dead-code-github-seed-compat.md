---
"pome-sh": patch
---

Remove dead GitHub twin fork (~833 LOC) and consolidate seed/event types on
vendored `@pome-sh/twin-github`. Add `githubSeedCompat` so legacy sidecar
`issue.assignee` maps to `assignees[]` before seed validation.
