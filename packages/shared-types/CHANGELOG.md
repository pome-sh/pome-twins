# @pome-sh/shared-types — CHANGELOG

## 0.6.1

### Added

- Strict accepted and status response schemas for asynchronous managed
  evaluation finalization, including the legacy scored-response fallback.

## 0.6.0

First npm-published release (F-714).

M6 — publish the trace-format contract as the single reusable package surface
for OSS twins, the CLI, adapters, and pome-cloud consumers.

### Added

- Subpath exports for `recorder-events`, `run`, `otel`, and `redaction` so
  downstream codegen and consumers can import stable contract leaves.
- Shared redaction helpers (`redactSecrets`, `redactEvent`) used by CLI,
  adapter, SDK, and first-party twins.
- CLI response contract coverage for eval sessions, finalize responses, and
  criterion definitions.

### Changed

- `@pome-sh/shared-types` is the source of truth for the CLI trace/event
  schemas; the CLI no longer maintains a local copy.
- Published consumers must use zod 4 (`^4.1.13`).

## 0.5.0

FDRS-653 — reconcile the forked OTel surface (twins is the single canonical
home; pome-cloud consumes), adopt the W3 "scenario → task" wire vocabulary
behind a tolerant reader, and settle the `src/otel/` ownership banners. Also
formally releases the previously-`Unreleased` FDRS-480/481/482 (OTel surface)
and FDRS-398 (unified event union) sections below.

### Added

- `src/task-vocab.ts` — `LEGACY_TASK_VOCAB_KEY_MAP`, `normalizeTaskVocabKeys`,
  `LEGACY_CRITERION_KIND_MAP` (exported from the barrel). The tolerant-reader
  machinery for the 0.3.0 compatibility window.
- W3 vocab, canonical everywhere: `Run.task_name` / `Run.task_hash` /
  `Run.promoted_task_id`, `submitResultRequest.task_name` / `.task_hash`,
  `createSessionRequest.task_source` / `.task_id`,
  `RecorderEvent.task_step_id` (additive alongside the deprecated
  `scenario_step_id`), criterion kind `code` / `model`
  (+ `criterionKindSchema`, `CRITERION_KINDS`).
- Canonical `task*` exports: `taskSchema` / `Task`, `taskConfigSchema` /
  `TaskConfig`, `persistedTaskSchema` / `PersistedTask`. The `scenario*`
  exports remain as deprecated aliases for one release train (FDRS-654).
- `githubSeedStateSchema` (ported from pome-cloud): full GitHub world —
  top-level `users`, `default_branch`, `files`, `pull_requests` with
  `reviews` / `statuses`. Fixes the narrowing-boundary bug class where
  PR-based seeds were silently zod-stripped to an empty repo.
- `FixtureDerivedFrom` gains `"live-capture"` (ported from pome-cloud;
  reserved — no in-repo fixture uses it).
- New-vocab fixture dirs `test/fixtures/v1/runTaskVocab/` +
  `test/fixtures/v1/createSessionRequestTaskVocab/`, plus task-vocab
  normalization tests (`test/task-vocab.test.ts`) and ported seed-boundary /
  slack seed tests.

### Changed

- TOLERANT READER (0.3.0 window): `runSchema`, `submitResultRequestSchema`,
  `createSessionRequestSchema`, `recorderEventSchema`, `eventSchema` accept
  BOTH the 0.3.0-era `scenario_*` keys / `D`|`P` criterion kinds and the new
  vocabulary, normalizing to the new keys at parse time (new key wins when
  both are present). Nothing a 0.3.0-era artifact contains becomes invalid;
  shipped CLIs vendoring shared-types 0.3.0 keep working unchanged.
- `src/otel/` ownership banners: format schemas (span-event, event-schema,
  semconv, nano, project, map-span, legacy-shim, fixtures) are canonical HERE;
  ingest-side utilities (OTLP decode, redaction/allowlist processors, storage
  helpers, capture tooling) are cloud-owned consumers. The stale
  "pome-cloud mirrors this directory verbatim" claims are removed.
- SCHEMA CLASS CHANGE (downstream SDK consumers): the tolerant-reader wrapping
  changes the exported schema classes. `recorderEventSchema` is no longer a
  bare `ZodObject` and `eventSchema` is no longer a bare
  `ZodDiscriminatedUnion` (both are transform-wrapped); `runSchema`,
  `submitResultRequestSchema`, and `createSessionRequestSchema` are
  preprocess-wrapped. Object-schema methods (`.extend` / `.shape` / `.omit` /
  `.pick` / `.options`) no longer exist on these five exports. `.parse` /
  `.safeParse` / `z.infer` are unchanged, and no in-repo consumer used the
  removed methods. `twinHttpEventSchema` and the other event-variant schemas
  remain plain `ZodObject`s (discriminated-union members).

### Notes

- pome-cloud's hand-mirrored `packages/shared-types` (0.3.0 + cloud-local otel
  surface) is superseded by this package; the cloud consumer swap is FDRS-654.
- The CLI's vendored shared-types tarball intentionally stays at 0.3.0 in this
  release (separately version-gated; rides the FDRS-654/657 train).

## 0.4.0

FDRS-613 — reconcile the twins /v1 wire surface with the pome-cloud production
truth, add a shared /v1 fixture corpus + parity test, and ship runnable `dist`
JS/`.d.ts` so npm consumers (SDK / adapter) can vendor a published tarball
(T10 / FDRS-585 / FDRS-612).

### Added

- `planTierSchema`: `hobby`, `team` tiers.
- `sessionSchema.twins` (M3 authoritative twin list) + `MOUNTED_TWINS` const.
- `createSessionRequestSchema`: permissive `seed` (`z.record`, ADR-015) +
  `idempotency_key`.
- `createSessionResponseSchema`: `session_token` + `per_twin{}` (required).
- `submitResultRequestSchema.events_jsonl_url`.
- `run.ts`: `correlatorKindSchema` + `correlator_kind`, `environment`,
  `promoted_scenario_id`, `replay_run_id`, `state_archive_s3_key`, agent
  telemetry rollup (`agent_tokens_in/out`, `agent_latency_p50/p95/max_ms`,
  `agent_error_count`, `agent_telemetry_span_count`), `summary`.
- `test/fixtures/v1/` shared JSON corpus + `test/v1-fixture-parity.test.ts`.
- Build now emits `dist/` (JS + `.d.ts`); package `main`/`types`/`exports` point
  at `dist`, `files` ships `dist`, `prepublishOnly` builds.

### Changed

- `usageResponseSchema.sessions_remaining`: `.int()` → `.int().min(0)` (matches
  cloud's clamped live snapshot).
- `run.ts` `events_jsonl_url`: relaxed from `.url()` to `z.string()` (persisted
  values are storage keys, not URLs).

## Unreleased

FDRS-480/481/482 — OpenTelemetry-native trace format (M1). Canonical home of the
OTel surface; `pome-cloud` consumes the published package surface instead of
mirroring `src/otel/` source files.

### Added

- New `src/otel/` surface, re-exported from the barrel:
  - `OtelSpanEvent` schema + `mapOtelSpanToEvent` — pure/deterministic mapping of
    a normalized OTel GenAI/HTTP span onto flat `gen_ai_*` / `http_*` / `url_*` /
    `server_*` / `error_type` projections. Real W3C trace context (32-/16-char
    lowercase-hex, non-zero) or explicit `legacy:<id>`; uint64 nanos (no BigInt);
    `end>=start`; `event_id==span_id`; projection-drift `superRefine` (typed
    fields must equal `projectAttributes(attributes)`).
  - `shimLegacyEventToSpan` — lossless (`pome.legacy.record_json` keeps the RAW
    record), deterministic legacy `TwinHttpEvent`/`LlmCallEvent`/`ToolUseEvent` →
    span shim. OTel status rules (1xx–3xx UNSET; 4xx/5xx + transport errors ERROR).
  - `otelEventSchema` — the OTel-extended event union (legacy `eventSchema` ∪
    `OtelSpanEvent`), additive; the frozen v1 `eventSchema` is unchanged.
  - Pinned semconv: `OTEL_CORE_SEMCONV_VERSION` (1.41.1), `OTEL_GENAI_SCHEMA_VERSION`
    (1.42.0), canonical `gen_ai.provider.name` (with `gen_ai.system` deprecated alias).
  - uint64/nanos helpers + the single attribute projector, and a golden-fixture
    corpus under `src/otel/fixtures/` (test/dev artifact; not in the public barrel).

### Notes

- Additive only — `eventSchema` / `recorderEventSchema` and every existing export
  are untouched. Patterns are zod 3+4 compatible (cloud is on zod 3).
- No version bump: accumulates under `## Unreleased` per this changelog's
  convention. Downstream consumers pick this up through the next
  `@pome-sh/shared-types` publish.

---

FDRS-398 — unified `events.jsonl` discriminated-union schema for Agent Trace v1 (M0).

### Added

- `GITHUB_ACCESS_CONTROL_CATALOG` — canonical 52-endpoint GitHub twin sandbox catalog (25 v1 + 27 FDRS-300 v2 hot paths) for hosted access-control toggles, grouped by functional cluster (Issues, Branches & files, Status & checks, …). Export helpers: `formatGitHubAccessControlLabel`, `groupGitHubAccessControlByCategory`, `summarizeGitHubAccessControlCatalog`, `githubAccessControlToolNames`.
- `eventSchema` — discriminated union over `kind` across `TwinHttpEvent | LlmCallEvent | ToolUseEvent | ToolResultEvent | SubagentSpawnEvent | HookEvent`. Every variant carries `event_id: string`, `parent_id: string | null`, `kind` literal, and `ts` (ISO-8601).
- `twinHttpEventSchema` — the existing `recorderEventSchema` shape extended with the union discriminator + parent-chain fields. Renaming of `RecorderEvent`; the legacy export is kept until downstream tickets (FDRS-402 / 403 / 412 / 415 / 417) migrate their callers.
- `llmCallEventSchema` — baseline fields (`host`, `port`, `latency_ms`, `bytes_in`, `bytes_out`) always populated by the M0 HTTP_PROXY CONNECT-tunnel capture; TLS-terminate-only fields (`url`, `method`, `status`, `model`, `prompt_tokens`, `completion_tokens`, `cost_usd`) are `nullable()` and stay null in baseline + CAS mode (CAS surfaces per-turn cost/model on the run summary from `SDKResultMessage`, not on individual `LlmCallEvent` rows).
- `toolUseEventSchema` / `toolResultEventSchema` — CAS-adapter-emitted (FDRS-408) tool-call envelope; payloads typed `unknown` (already redactor-scrubbed by the writer).
- `subagentSpawnEventSchema` — CAS-adapter-emitted (FDRS-409) once per sub-agent.
- `hookEventSchema` — thin audit-trail row for the 25 SDK hooks (FDRS-407); `tool_name` nullable for non-tool-scoped hooks.
- `isLegacyEventRow(row): boolean` — returns `true` iff `row` is a plain object missing a string `kind` discriminator (i.e. pre-FDRS-398 single-shape row on disk). Non-objects and arrays return `false`.

### Notes

- The legacy `recorderEventSchema` / `RecorderEvent` export is untouched — its 58 callers compile against the same shape they did before. Their migration to `twinHttpEventSchema` is owned by downstream tickets.
- OtelSpanEvent dropped from the v1 union (FDRS-400 cancelled by the 2026-05-26 `/plan-eng-review`). Adding it in v2 is a non-breaking extension via the `kind` discriminator.
- No version bump — `@pome-sh/shared-types` is held off npm until OSS Stage 1; consumers pick this up via workspace dep.

## 0.3.0 — 2026-05-11

FDRS-318 — file split + correlator/state-inspector field surface for M1+M2.

### Added

- New leaf `src/recorder-events.ts` and `src/run.ts`. `src/index.ts` keeps barrel re-exports for back-compat — consumers continue to `import { ... } from "@pome-sh/shared-types"` unchanged.
- `RecorderEvent.state_delta: { before, after } | null` — row-level before/after for state-inspector. `before: null` = insert; `after: null` = delete; parent `null` = no mutation.
- `RecorderEvent.step_id: string | null` — correlator-assigned post-hoc group id. Coexists with the existing `scenario_step_id` (scenario-author-set static expectation).
- `RecorderEvent.tool_call_id: string | null` — adapter-emitted (`@pome-sh/adapter-claude-sdk`). Null in heuristic-correlator path.
- `Run.lanes: Lane[]` + `Run.steps: Step[]` — correlator output, flat parallel arrays. Default `[]` for legacy runs.
- `Run.fix_prompt: string | null` — CLI-generated handoff prompt (BYOK Flavor #1, runs CLI-side). Default `null` for legacy / `--no-fix-prompt`.
- `Run.events_jsonl_url: string | null` — S3 URL for raw events.jsonl (V1.5 re-correlate). Default `null` for self-host / `--no-upload` / legacy.
- `submitResultRequestSchema.lanes` / `.steps` / `.fix_prompt` — matching CLI submit fields with backward-compat defaults for pre-M3i CLIs during rollout.
- `Step`, `Lane`, `TwinId`, `KnownTwinId`, `StateDelta` types + corresponding Zod schemas (`stepSchema`, `laneSchema`, `twinIdSchema`, `stateDeltaSchema`).
- `KNOWN_TWIN_IDS = ["github", "stripe"] as const` — canonical pattern-match set for dashboard rendering.
- Vitest config + `test/recorder-events.test.ts`, `test/run.test.ts`, `test/barrel.test.ts` — first-ever package-level test suite.

### Changed

- `criterionSchema` + `judgeModelSchema` now live in `src/run.ts` (re-exported via barrel from `src/index.ts`). External imports are unaffected.
- `RecorderEvent.twin` was already `z.string().min(1)` and remains so — `KNOWN_TWIN_IDS` is exported alongside for dashboard rendering. Closed-enum was considered and rejected mid-implementation (see FDRS-318 [DECISION] amendment) for SDK community-twin compatibility.

### Breaking (for emitters of RecorderEvent)

- `state_delta`, `step_id`, `tool_call_id` are required (nullable) fields. Existing emitters that construct `RecorderEvent` without these fail Zod parse. SDK middleware + twin-github already updated in this PR; future twin authors must pass these (use `null` if not applicable).

### Notes

- Pre-Stage-1, the cloud carried a temporary mirror copy. M8 retires source
  mirroring; downstream consumers should use the published `@pome-sh/shared-types`
  package contract.
- FDRS-318's description says `Run.events_jsonl_url: string`, FDRS-327 says nullable. Aligned with FDRS-327 (nullable) — see [DECISION] comment on FDRS-318.
