// SPDX-License-Identifier: Apache-2.0
//
// AdapterSignal — JSONL line shape emitted by `@pome-sh/adapter-claude-sdk` to
// the path in `POME_ADAPTER_SIGNALS_PATH`. The correlator package owns this
// type rather than importing from adapter-claude-sdk so the OSS dependency
// arrow points one way only: adapter-claude-sdk writes the wire format,
// correlator reads it. Future adapters (custom frameworks, community SDKs)
// can emit the same shape without taking a runtime dep on the Anthropic SDK.

import { z } from "zod";

export const stepSignalSchema = z.object({
  ts: z.string().datetime(),
  type: z.literal("step"),
  step_id: z.string().min(1),
});
export type StepSignal = z.infer<typeof stepSignalSchema>;

export const toolCallSignalSchema = z.object({
  ts: z.string().datetime(),
  type: z.literal("tool_call"),
  tool_call_id: z.string().min(1),
  tool_name: z.string().min(1),
});
export type ToolCallSignal = z.infer<typeof toolCallSignalSchema>;

export const adapterSignalSchema = z.discriminatedUnion("type", [
  stepSignalSchema,
  toolCallSignalSchema,
]);
export type AdapterSignal = z.infer<typeof adapterSignalSchema>;

// Synthetic step id under which uncorrelated events land. Reserved literal:
// adapters MUST NOT emit a step signal with this id, and the correlator
// always uses it for the catch-all step. Stable across runs so dashboards
// can render uncorrelated buckets consistently.
export const UNCORRELATED_STEP_ID = "stp_uncorrelated";
