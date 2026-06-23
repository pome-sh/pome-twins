// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  eventSchema,
  isLegacyEventRow,
  type Event,
  type HookEvent,
  type LlmCallEvent,
  type SubagentSpawnEvent,
  type ToolResultEvent,
  type ToolUseEvent,
  type TwinHttpEvent,
} from "../types/shared.js";

/**
 * Result of reading + classifying a run's `events.jsonl`. The reader can take
 * three paths:
 *   - `kind: "events"` — every row parsed cleanly against the discriminated
 *     union; the renderer walks `events` to print sections + trace health.
 *   - `kind: "legacy"` — at least one row is missing the `kind` discriminator
 *     (pre-FDRS-398 shape). `pome inspect` prints the legacy error and exits 2.
 *   - `kind: "missing"` — `events.jsonl` does not exist (run never produced
 *     trace blobs). Renderer prints a one-line note; no exit-2.
 */
export type ReadEventsResult =
  | { kind: "events"; events: Event[] }
  | { kind: "legacy" }
  | { kind: "missing" };

export const LEGACY_EVENTS_MESSAGE =
  "this run was produced by an older CLI version (pre-M0); rerun against current CLI to view";

export async function readEventsJsonl(runDir: string): Promise<ReadEventsResult> {
  let raw: string;
  try {
    raw = await readFile(join(runDir, "events.jsonl"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    throw err;
  }

  const rows = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);

  if (rows.some(isLegacyEventRow)) {
    return { kind: "legacy" };
  }

  const events = rows.map((row) => eventSchema.parse(row));
  return { kind: "events", events };
}

// ─────────────────────────────────────────────────────────────────────────────
// Trace health
//
// Three layers, counted per FDRS-403 acceptance criteria:
//   - proxy : LlmCallEvent           (HTTP_PROXY CONNECT capture-server)
//   - twin  : TwinHttpEvent          (twin runtime HTTP traffic)
//   - cas   : ToolUse/ToolResult/    (claude-agent-sdk adapter)
//             SubagentSpawn/Hook
//
// "Expected" is a heuristic, not a hard count. We report the layer's actual
// count and a one-word judgement: "ok", "warning" (we believe the layer
// should have produced events but didn't), or "—" (no expectation either
// way).
// ─────────────────────────────────────────────────────────────────────────────

export type TraceHealthLayer = {
  name: string;
  count: number;
  expectedAtLeast: number;
  status: "ok" | "warning" | "none";
  note: string | null;
};

export type TraceHealthInput = {
  events: Event[];
  // Scenario-level signals. All optional — when unknown the heuristic
  // gracefully degrades to "presence implies expected".
  scenarioUsesTwin?: boolean;
  scenarioExpectsLlm?: boolean;
  scenarioExpectsCas?: boolean;
};

export function computeTraceHealth(input: TraceHealthInput): TraceHealthLayer[] {
  const counts = countByKind(input.events);

  // proxy layer — LLM calls captured by the HTTP_PROXY CONNECT tunnel.
  // Default heuristic: presence implies it was expected (so a populated layer
  // never warns). When the scenario manifest declares LLM usage we expect at
  // least one row even with zero observed; absence then surfaces as a warning
  // ("capture-server may not have started").
  const proxyExpected = input.scenarioExpectsLlm
    ? 1
    : counts.LlmCallEvent > 0
      ? 1
      : 0;
  const proxy: TraceHealthLayer = {
    name: "proxy",
    count: counts.LlmCallEvent,
    expectedAtLeast: proxyExpected,
    status: layerStatus(counts.LlmCallEvent, proxyExpected),
    note:
      proxyExpected > 0 && counts.LlmCallEvent === 0
        ? "warning: capture-server may not have started"
        : null,
  };

  // twin layer — TwinHttpEvent rows. A scenario always declares ≥1 twin in
  // `config.twins`, so when we know the scenario we expect ≥1 row.
  const twinExpectedBool = input.scenarioUsesTwin ?? counts.TwinHttpEvent > 0;
  const twinExpected = twinExpectedBool ? 1 : 0;
  const twin: TraceHealthLayer = {
    name: "twin",
    count: counts.TwinHttpEvent,
    expectedAtLeast: twinExpected,
    status: layerStatus(counts.TwinHttpEvent, twinExpected),
    note:
      twinExpected > 0 && counts.TwinHttpEvent === 0
        ? "warning: twin runtime emitted no HTTP events"
        : null,
  };

  // CAS adapter layer — only active when the agent is wired through
  // `@pome-sh/claude-agent-sdk`. Heuristic: any of ToolUse/ToolResult/
  // SubagentSpawn/Hook indicates adapter is live.
  const casCount =
    counts.ToolUseEvent +
    counts.ToolResultEvent +
    counts.SubagentSpawnEvent +
    counts.HookEvent;
  const casExpected = input.scenarioExpectsCas ? 1 : casCount > 0 ? 1 : 0;
  const cas: TraceHealthLayer = {
    name: "CAS adapter",
    count: casCount,
    expectedAtLeast: casExpected,
    status: layerStatus(casCount, casExpected),
    note:
      casExpected > 0 && casCount === 0
        ? "warning: scenario flagged adapter but no adapter events recorded"
        : null,
  };

  return [proxy, twin, cas];
}

function layerStatus(count: number, expected: number): "ok" | "warning" | "none" {
  if (expected === 0) return count > 0 ? "ok" : "none";
  return count >= expected ? "ok" : "warning";
}

type EventKind = Event["kind"];
type CountsByKind = Record<EventKind, number>;

function emptyCounts(): CountsByKind {
  return {
    TwinHttpEvent: 0,
    LlmCallEvent: 0,
    ToolUseEvent: 0,
    ToolResultEvent: 0,
    SubagentSpawnEvent: 0,
    HookEvent: 0,
  };
}

function countByKind(events: Event[]): CountsByKind {
  const counts = emptyCounts();
  for (const event of events) {
    counts[event.kind] += 1;
  }
  return counts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
//
// Lines are emitted into a string array so tests can snapshot the full output
// without intercepting console.log. The inspect command joins on "\n".
// ─────────────────────────────────────────────────────────────────────────────

export function renderTraceHealth(layers: TraceHealthLayer[]): string[] {
  const lines: string[] = ["Trace health:"];
  for (const layer of layers) {
    const expected =
      layer.expectedAtLeast > 0 ? `expected≥${layer.expectedAtLeast}` : "no expectation";
    const tail = layer.note ? ` (${layer.note})` : "";
    lines.push(`  ${layer.name}: ${layer.count}/${expected} [${layer.status}]${tail}`);
  }
  return lines;
}

export function renderEvents(events: Event[]): string[] {
  if (events.length === 0) {
    return ["Events: (none)"];
  }
  const lines: string[] = [`Events (${events.length}):`];
  for (const event of events) {
    lines.push(...renderEventLines(event));
  }
  return lines;
}

function renderEventLines(event: Event): string[] {
  switch (event.kind) {
    case "TwinHttpEvent":
      return renderTwinHttp(event);
    case "LlmCallEvent":
      return renderLlmCall(event);
    case "ToolUseEvent":
      return renderToolUse(event);
    case "ToolResultEvent":
      return renderToolResult(event);
    case "SubagentSpawnEvent":
      return renderSubagentSpawn(event);
    case "HookEvent":
      return renderHook(event);
  }
}

function renderTwinHttp(event: TwinHttpEvent): string[] {
  const status = event.error ? `ERR ${event.status}` : `${event.status}`;
  const dedupe = event.idempotency_dedupe ? " [dedupe-replay]" : "";
  const mutation = event.state_mutation ? " [mutation]" : "";
  return [
    `- TwinHttpEvent  ${event.method} ${event.path} → ${status} (${event.latency_ms}ms)${mutation}${dedupe}`,
    `    twin=${event.twin}  fidelity=${event.fidelity}${event.error ? `  error=${event.error}` : ""}`,
  ];
}

function renderLlmCall(event: LlmCallEvent): string[] {
  const model = event.model ? ` model=${event.model}` : "";
  const status = event.status !== null ? ` status=${event.status}` : "";
  const tokens =
    event.prompt_tokens !== null || event.completion_tokens !== null
      ? ` tokens=${event.prompt_tokens ?? "?"}/${event.completion_tokens ?? "?"}`
      : "";
  return [
    `- LlmCallEvent   ${event.host}:${event.port}${status} (${event.latency_ms}ms)`,
    `    bytes=${event.bytes_in}/${event.bytes_out}${model}${tokens}`,
  ];
}

function renderToolUse(event: ToolUseEvent): string[] {
  return [`- ToolUseEvent   ${event.tool_name} (id=${event.tool_use_id})`];
}

function renderToolResult(event: ToolResultEvent): string[] {
  const status = event.is_error ? "error" : "ok";
  return [`- ToolResultEvent ${status} (use_id=${event.tool_use_id})`];
}

function renderSubagentSpawn(event: SubagentSpawnEvent): string[] {
  return [`- SubagentSpawnEvent parent_tool_use_id=${event.parent_tool_use_id}`];
}

function renderHook(event: HookEvent): string[] {
  const tool = event.tool_name ? ` tool=${event.tool_name}` : "";
  return [`- HookEvent      ${event.hook_name}${tool}`];
}
