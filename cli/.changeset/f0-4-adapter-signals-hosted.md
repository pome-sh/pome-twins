---
"pome-sh": patch
---

**F0-4 / L7 (CLI half) — adapter signals reach the cloud judge on hosted runs.**

Before this change, the entire adapter-signals roadmap (FDRS-407 / 408 / 409 / 411 / 412 / 413) was invisible on the launch-default hosted path:

- `examples/triage-agent` imported `tool` / `query` directly from `@anthropic-ai/claude-agent-sdk`, so `withPome()`'s `globalThis.fetch` hook never installed and nothing wrote to `POME_ADAPTER_SIGNALS_PATH`.
- `runScenarioHosted.ts` created the signals tempfile and exported it as an env var, but never uploaded the contents to cloud storage — `correlateRun(signalsPath, events)` was called and its result `void`ed.

Cloud-side support landed in Session A (Linear FDRS-423): new endpoint `POST /v1/sessions/:id/signals-upload-url` mints a signed PUT; `/finalize` accepts an optional `signals_storage_key` field; when present, finalize-run switches its correlator to `correlateTraceJsonlWithSignals` so adapter-emitted `HookEvent` / `ToolUseEvent` / `SubagentSpawnEvent` rows correlate into lanes/steps alongside the twin-HTTP timeline.

CLI changes:
- `examples/triage-agent/src/index.ts` — imports `tool`, `query`, `withPome` from `@pome-sh/adapter-claude-sdk` (`createSdkMcpServer` stays on the upstream SDK, the adapter doesn't expose it). Calls `withPome()` at module load. `package.json` adds the adapter as a `file:..` dep (post-Stage-1 cutover to the published npm version is L2).
- `cli/src/hosted/client.ts` — adds `requestSignalsUploadUrl(sessionId)` mirroring the existing events/state endpoints, plus optional `signalsStorageKey` on `FinalizeInput` (forwarded to the cloud as `signals_storage_key`).
- `cli/src/runner/runScenarioHosted.ts` — adds an `uploadSignals()` step that reads `signalsPath`, skips silently when the file is empty, and otherwise POSTs to the new upload URL endpoint, PUTs the body, and threads the returned key onto the finalize call. Best-effort like the other uploads — a failure leaves `signals_storage_key=null` and cloud falls back to heuristic correlation.
- Regression test in `test/unit/runner/runScenarioHosted.upload.test.ts` — stub agent writes a `HookEvent` row to the runner-injected signals path; assertion verifies the runner uploaded it and threaded `signalsStorageKey` onto `/finalize`. The unsigned-file case is implicitly covered by every other suite test (none of which write to signalsPath).

**Behavior note:** the triage-agent now pins `@anthropic-ai/claude-agent-sdk` to `0.2.139` (was `^0.2.132`) so the TS types resolve to a single SdkMcpToolDefinition identity across the adapter's symlinked source and the direct dep. Once `@pome-sh/adapter-claude-sdk` ships to npm (L2), the adapter pins its own peer range and triage-agent's pin can return to a caret range.
