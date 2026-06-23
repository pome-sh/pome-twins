---
"pome": patch
---

Rename `@pome-sh/claude-agent-sdk` -> `@pome-sh/adapter-claude-sdk` in the deferred-SDK error message surfaced by `pome init --sdk claude` (FDRS-404). No behavior change beyond the package name printed in the error string; the scaffold remains deferred until the renamed package publishes to npm.
