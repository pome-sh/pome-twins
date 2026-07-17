---
"@pome-sh/cli": patch
---

Hosted runs no longer count the preflight probe's telemetry toward the uploaded usage ledger. The runner ran the agent command twice against one shared signals file (a ≤10s preflight probe, then the real run) and uploaded the file whole, so per-turn LLM usage (`LlmTurnEvent`) was double-counted. The shared signals file is now truncated after a successful preflight, before the real run, so the uploaded `signals.jsonl` reflects real-run telemetry only.
