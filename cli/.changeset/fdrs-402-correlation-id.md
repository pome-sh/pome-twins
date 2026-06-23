---
"pome-sh": patch
---

Local twin-github recorder now persists the adapter's `x-pome-correlation-id`
header on each event as both `tool_call_id` and (for legacy correlator
compatibility) `correlation_id`. Request and response bodies are run through
the centralized secret redactor before persisting, so `events.jsonl` no longer
leaks `Authorization` / `token` / `api_key` payloads even if they slip into a
tool call.
