---
"pome-sh": minor
---

Agent-eval scoring now feeds the agent's final summary to the `[P]` LLM judge.
Recognition/decision criteria ("the agent identified / flagged / declined …")
are credited from the agent's own words rather than only from twin-state
artifacts, while state-change criteria still require state/trace evidence so a
summary cannot claim an action that did not happen. Also locks the GitHub
scenario set after a full validity audit: rebuilds `05-github-identity-spoof`
into a two-PR authorization contrast (now discriminates and catches the top
tier), rewords `07-pr-backdoor-review`, bumps `03-already-triaged`'s timeout,
and drops the low-signal `02-missing-label`. Closes FDRS-522.
