// SPDX-License-Identifier: Apache-2.0
//
// Adapter signals JSONL writer.
//
// Locked architecture (FDRS-322 [DECISION] 2026-05-11): the CLI runner invokes
// the agent as a subprocess, so adapter signals cannot live in process memory.
// They are appended to `process.env.POME_ADAPTER_SIGNALS_PATH`, one JSON line
// per event, in the order the adapter observes them. The CLI reads the file
// after the subprocess exits and feeds it to the correlator (FDRS-412).
//
// FDRS-407: rows are now M0-schema events. The on-disk shape matches
// `@pome-sh/shared-types`' discriminated union (`hookEventSchema` and
// siblings). Legacy `{type: "step"}` / `{type: "tool_call"}` shapes are
// removed.
//
// FDRS-408: adds ToolUseEvent / ToolResultEvent writers. Same single-writer
// pattern, same on-disk file as HookEvent.
//
// FDRS-409: adds SubagentSpawnEvent writer. Emitted once per sub-agent the
// first time the adapter observes a non-null `parent_tool_use_id` on an SDK
// message; same single-writer pattern.
//
// Standalone dev (no CLI runner): env unset → every write is a static noop.

import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { HookEvent, SubagentSpawnEvent, ToolResultEvent, ToolUseEvent } from "@pome-sh/shared-types";

export const ADAPTER_SIGNALS_ENV = "POME_ADAPTER_SIGNALS_PATH";

export function resolveSignalsPath(): string | null {
  const v = process.env[ADAPTER_SIGNALS_ENV];
  return v && v.length > 0 ? v : null;
}

export function newEventId(): string {
  return randomUUID();
}

export type HookEventRow = HookEvent;

export function writeHookEvent(row: HookEventRow): void {
  const path = resolveSignalsPath();
  if (!path) return;
  appendFileSync(path, JSON.stringify(row) + "\n");
}

// The CLI forwards lines from this signals JSONL into the canonical
// events.jsonl post-run (FDRS-326). HookEvent writers (FDRS-407) share the
// same file — there's one writer per process.
export type ToolUseEventRow = ToolUseEvent;

export type ToolResultEventRow = ToolResultEvent;

export function writeToolUseEvent(row: ToolUseEventRow): void {
  const path = resolveSignalsPath();
  if (!path) return;
  appendFileSync(path, JSON.stringify(row) + "\n");
}

export function writeToolResultEvent(row: ToolResultEventRow): void {
  const path = resolveSignalsPath();
  if (!path) return;
  appendFileSync(path, JSON.stringify(row) + "\n");
}

// `parent_tool_use_id` is the SDK's correlation handle; `parent_id` points at
// the spawning `ToolUseEvent.event_id` when the adapter saw the parent
// tool_use earlier in the stream.
export type SubagentSpawnEventRow = SubagentSpawnEvent;

export function writeSubagentSpawnEvent(row: SubagentSpawnEventRow): void {
  const path = resolveSignalsPath();
  if (!path) return;
  appendFileSync(path, JSON.stringify(row) + "\n");
}
