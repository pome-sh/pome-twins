---
"@pome-sh/cli": patch
---

Rename "scenario" to "task" across user-facing copy (F-860): help text, error
messages, `pome scenarios` listings, the fix-prompt template, and the bundled
task files' titles/prose. No behavior change — the `pome scenarios` command,
the `./scenarios/` directory convention, positional CLI usage, and all wire
keys (`scenario_*`) are unchanged.
