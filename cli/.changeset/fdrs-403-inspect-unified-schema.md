---
"pome-sh": minor
---

`pome inspect` now reads the FDRS-398 unified `events.jsonl` discriminated-union schema and renders each event kind in its own section (TwinHttpEvent, LlmCallEvent, ToolUseEvent, ToolResultEvent, SubagentSpawnEvent, HookEvent). Adds a "Trace health" report per layer (proxy / twin / CAS adapter) with per-layer counts and expectations.

Pre-FDRS-398 (legacy) `events.jsonl` rows are detected and surfaced with a clear error and a distinct exit code 2: `this run was produced by an older CLI version (pre-M0); rerun against current CLI to view`. Closes FDRS-403.
