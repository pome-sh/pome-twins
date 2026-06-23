---
"pome-sh": minor
---

New `pome capture-server` subcommand: HTTP CONNECT-tunnel proxy that emits one
`LlmCallEvent` (host / port / latency_ms / bytes_in / bytes_out) per tunnel
into `events.jsonl`. Forwards TLS opaquely — no CA install required. Run
manually for ad-hoc captures, or rely on `pome run` to spawn it as a child
process and set `HTTPS_PROXY` (FDRS-399). Adapter-only fields (url, method,
status, model, tokens, cost) stay null in baseline mode; per-call token /
model / cost are deferred to the v2 opt-in TLS-terminate mode.
