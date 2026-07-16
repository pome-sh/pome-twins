# @pome-sh/adapter-claude-sdk — CHANGELOG

## Unreleased

## 0.2.1 — 2026-07-16

Dependency-only release: `@pome-sh/shared-types` pinned to 0.9.0 after removal
of obsolete local-evaluation hook types. No adapter behavior changes.

## 0.2.0 — 2026-07-16

F-766 — `query()` now emits one `LlmTurnEvent` per assistant turn reporting usage: a `withTurnUsage` stream wrapper (same turn detection as the OTLP `withGenAiSpans` lane) writes `turn_index`, `model`, `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `finish_reasons`, and `latency_ms` (+ `latency_ms_estimated`) to the signals JSONL (`POME_ADAPTER_SIGNALS_PATH`; inert when unset). The OTLP lane is untouched. `@pome-sh/shared-types` pin bumped 0.6.0 → 0.8.0 for the `LlmTurnEvent` schema.

Minor, not patch: the adapter's output surface (the signals JSONL) gains a new event kind. A pre-#152 `pome eval` corrupts kinded rows on hosted upload (mapped through `toTwinHttpEvent`), so consumers must pair this adapter with a CLI carrying the F-766 eval fix — consumer-must-act under the pre-1.0 rule in `PACKAGE_RELEASE.md`.

## 0.1.0 — 2026-07-09

First npm-published release (F-714). Drop-in adapter for Anthropic's
`@anthropic-ai/claude-agent-sdk` (peer dependency): `withPome`, `tool`, and
`query` wrap an agent so its tool calls, subagent spawns, and hook events
land in the Pome trace format defined by `@pome-sh/shared-types`.

FDRS-410 — outgoing correlation header renamed from `X-Pome-Tool-Call-Id` to lowercase `x-pome-correlation-id` to match the twin recorders' contract (FDRS-402) and HTTP header-name convention. The exported symbol on the index follows: `TOOL_CALL_HEADER` → `CORRELATION_HEADER`. New `test/als-propagation.test.ts` exercises a tool handler that crosses two microtask boundaries before issuing `fetch()`, asserting exact equality between the entry-time `tool_call_id` (read from ALS) and the outgoing `x-pome-correlation-id` header — fails loudly on the silent-`null`-header failure mode that hid FDRS-322 for weeks.

FDRS-409 — `query()` now emits one `SubagentSpawnEvent` the first time it sees a non-null `parent_tool_use_id` on an SDK message. The spawn row's `parent_id` points at the spawning `ToolUseEvent.event_id` (looked up via `tool_use_id == parent_tool_use_id`); subsequent child `ToolUseEvent`s coming from that sub-agent's message stream carry `parent_id` set to the SubagentSpawnEvent's `event_id`, so child rows chain through the spawn row instead of pointing at null. Same single-writer JSONL path (`POME_ADAPTER_SIGNALS_PATH`); shape matches `subagentSpawnEventSchema` in `@pome-sh/shared-types`.

FDRS-407 — signals are now M0-schema rows; SDK hooks emit `HookEvent`. The legacy `{type: "step"}` and `{type: "tool_call"}` shapes are removed from `signals.ts`. `query()` now merges a read-only `HookEvent` emitter over every entry in the SDK's `HOOK_EVENTS` constant (29 events at impl time: PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, UserPromptSubmit, UserPromptExpansion, SessionStart, SessionEnd, Stop, StopFailure, SubagentStart, SubagentStop, PreCompact, PostCompact, PermissionRequest, PermissionDenied, Setup, TeammateIdle, TaskCreated, TaskCompleted, Elicitation, ElicitationResult, ConfigChange, WorktreeCreate, WorktreeRemove, InstructionsLoaded, CwdChanged, FileChanged). Each invocation appends one row matching `hookEventSchema` from `@pome-sh/shared-types`: `{ts, event_id, parent_id, kind: "HookEvent", hook_name, tool_name}`. User-supplied hooks in `options.hooks` are preserved alongside pome's. `wrapHandler` keeps the ALS scope that feeds the `X-Pome-Tool-Call-Id` header but no longer writes a signal; `withStepBoundaries` is removed (ToolUseEvent / ToolResultEvent emission moves to FDRS-408's message-stream wrapper).

FDRS-404 — package rename. `@pome-sh/claude-agent-sdk` → `@pome-sh/adapter-claude-sdk`; directory `packages/claude-agent-sdk/` → `packages/adapter-claude-sdk/`. No behavior change. The package was never published to npm under the old name, so this is a no-op for downstream consumers. M2 builds the actual adapter implementation on top of the renamed package; the rename lands in M0 to avoid path collisions with M2's parallel twin-side work.
