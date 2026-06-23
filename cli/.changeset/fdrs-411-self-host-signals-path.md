---
"pome-sh": minor
---

Self-host `pome run` now injects `POME_ADAPTER_SIGNALS_PATH=<runDir>/signals.jsonl`
into the agent subprocess env (sibling of `events.jsonl`). After the agent
exits, the runner merges valid M0 rows from `signals.jsonl` into `events.jsonl`
in ts-sorted order, making the merged file the canonical view for `pome
inspect` and downstream consumers. Empty or missing `signals.jsonl` is
tolerated. Closes the FDRS-322 self-host gap so agents using
`@pome-sh/adapter-claude-sdk`'s `withPome()` produce trace rows on self-host
the same way they already do under hosted runs.
