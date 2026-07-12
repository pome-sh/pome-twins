// SPDX-License-Identifier: Apache-2.0
//
// shared-types §6 — EvaluatorHooks. Cross-boundary instrumentation pattern
// (per ADR-002). Re-exported through the `@pome-sh/shared-types` barrel (index.ts).

// ─────────────────────────────────────────────────────────────────────────────
// 6. EvaluatorHooks — cross-boundary instrumentation pattern (per ADR-002)
// ─────────────────────────────────────────────────────────────────────────────
//
// Defined in OSS (`cli/src/evaluator/`). The OSS module never imports
// cloud — the hook is a callback the runtime wires up at construction time.
//
// BYOK Flavor #1 means the LLM judge runs CLI-side using the customer's own
// key, so there is NO cloud-side evaluator service in V1 and NO judge-cost
// metering. The only surviving hook is for trace upload, which lets
// hosted-mode CLI POST trace blobs to the cloud API while self-host writes
// them to local disk. Same evaluator code path; different sink.

export interface TraceUploadContext {
  session_id: string;
  trace_jsonl: string;                         // raw jsonl bytes (HTTP calls between agent and twin; NOT LLM prompts)
  state_initial_json: string;
  state_final_json: string;
}

export interface EvaluatorHooks {
  // Returns the storage keys the cloud assigned (or filesystem paths in self-host).
  onTraceUpload?: (ctx: TraceUploadContext) => Promise<{
    trace_s3_key: string;
    state_initial_s3_key: string;
    state_final_s3_key: string;
  }>;
}
