---
"@pome-sh/cli": minor
---

`pome twin start <twin>` now starts any of the three twins (github, slack, stripe) as a long-lived foreground server (Ctrl-C to stop) on the same in-process boot path `pome run --local` uses, and prints a ready-to-use JWT. The command reuses a secret persisted at `.pome-data/<twin>/secret` (`POME_TWIN_DATA_DIR` overrides the directory); an env-injected `TWIN_AUTH_SECRET` always wins.
