---
"@pome-sh/cli": minor
---

Per-turn LLM usage is now captured end to end on self-host runs. The Claude-SDK
adapter emits an `LlmTurnEvent` for each assistant turn — model, input/output
tokens, and the cache-read/cache-creation token counts — into `events.jsonl`.

- `pome inspect` renders the new `LlmTurnEvent` rows (turn index, model, token
  usage, cache read/create counts) and counts them in the CAS-adapter trace
  health layer.
- `pome eval` no longer corrupts already-kinded event rows on upload: it
  previously mapped every row through the legacy TwinHttpEvent wrapper, which
  clobbered any non-TwinHttpEvent kind. Legacy (kind-less) rows are still
  wrapped; kinded rows now upload unchanged.
