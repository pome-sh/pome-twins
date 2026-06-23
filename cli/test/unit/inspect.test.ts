import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEGACY_EVENTS_MESSAGE,
  computeTraceHealth,
  readEventsJsonl,
  renderEvents,
  renderTraceHealth,
} from "../../src/recorder/inspect.js";
import type {
  Event,
  HookEvent,
  LlmCallEvent,
  SubagentSpawnEvent,
  ToolResultEvent,
  ToolUseEvent,
  TwinHttpEvent,
} from "../../src/types/shared.js";

const twinHttp: TwinHttpEvent = {
  kind: "TwinHttpEvent",
  ts: "2026-05-26T00:00:01.000Z",
  event_id: "evt_twin_1",
  parent_id: null,
  run_id: "run_test",
  twin: "github",
  request_id: "req_1",
  step_id: null,
  tool_call_id: null,
  method: "POST",
  path: "/repos/acme/api/issues/1/labels",
  request_body: null,
  status: 200,
  response_body: null,
  latency_ms: 12,
  fidelity: "semantic",
  state_mutation: true,
  state_delta: null,
  error: null,
};

const llmCall: LlmCallEvent = {
  kind: "LlmCallEvent",
  ts: "2026-05-26T00:00:00.500Z",
  event_id: "evt_llm_1",
  parent_id: null,
  host: "api.anthropic.com",
  port: 443,
  latency_ms: 800,
  bytes_in: 12345,
  bytes_out: 6789,
  url: null,
  method: null,
  status: null,
  model: null,
  prompt_tokens: null,
  completion_tokens: null,
  cost_usd: null,
};

const toolUse: ToolUseEvent = {
  kind: "ToolUseEvent",
  ts: "2026-05-26T00:00:01.100Z",
  event_id: "evt_tool_use_1",
  parent_id: "evt_llm_1",
  tool_use_id: "tu_1",
  tool_name: "add_label",
  input: { issue: 1, label: "bug" },
};

const toolResult: ToolResultEvent = {
  kind: "ToolResultEvent",
  ts: "2026-05-26T00:00:01.200Z",
  event_id: "evt_tool_result_1",
  parent_id: "evt_tool_use_1",
  tool_use_id: "tu_1",
  output: { ok: true },
  is_error: false,
};

const subagentSpawn: SubagentSpawnEvent = {
  kind: "SubagentSpawnEvent",
  ts: "2026-05-26T00:00:01.300Z",
  event_id: "evt_sub_1",
  parent_id: "evt_tool_use_1",
  parent_tool_use_id: "tu_1",
};

const hook: HookEvent = {
  kind: "HookEvent",
  ts: "2026-05-26T00:00:01.400Z",
  event_id: "evt_hook_1",
  parent_id: null,
  hook_name: "PreToolUse",
  tool_name: "add_label",
};

const allEvents: Event[] = [llmCall, twinHttp, toolUse, toolResult, subagentSpawn, hook];

describe("readEventsJsonl", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "pome-inspect-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns missing when events.jsonl does not exist", async () => {
    const result = await readEventsJsonl(tmp);
    expect(result.kind).toBe("missing");
  });

  it("parses new-shape rows into the discriminated union", async () => {
    const lines = allEvents.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(join(tmp, "events.jsonl"), lines);
    const result = await readEventsJsonl(tmp);
    expect(result.kind).toBe("events");
    if (result.kind !== "events") return;
    expect(result.events).toHaveLength(6);
    expect(result.events.map((e) => e.kind)).toEqual([
      "LlmCallEvent",
      "TwinHttpEvent",
      "ToolUseEvent",
      "ToolResultEvent",
      "SubagentSpawnEvent",
      "HookEvent",
    ]);
  });

  it("flags legacy rows that are missing the kind discriminator", async () => {
    // Legacy row: shape matches pre-FDRS-398 recorderEventSchema (no `kind`).
    const legacy = {
      ts: "2026-05-01T00:00:00.000Z",
      run_id: "run_old",
      twin: "github",
      request_id: "req_1",
      step_id: null,
      tool_call_id: null,
      method: "GET",
      path: "/repos/acme/api",
      request_body: null,
      status: 200,
      response_body: null,
      latency_ms: 3,
      fidelity: "semantic",
      state_mutation: false,
      state_delta: null,
      error: null,
    };
    await writeFile(join(tmp, "events.jsonl"), JSON.stringify(legacy) + "\n");
    const result = await readEventsJsonl(tmp);
    expect(result.kind).toBe("legacy");
  });

  it("flags a legacy row even when mixed with new-shape rows", async () => {
    // Defensive: if a corrupted run had a mix, we still surface the legacy
    // error rather than partially rendering.
    const lines =
      JSON.stringify(twinHttp) +
      "\n" +
      JSON.stringify({ ts: "x", run_id: "y", twin: "github", request_id: "z" }) +
      "\n";
    await writeFile(join(tmp, "events.jsonl"), lines);
    const result = await readEventsJsonl(tmp);
    expect(result.kind).toBe("legacy");
  });

  it("ignores blank lines", async () => {
    await writeFile(join(tmp, "events.jsonl"), `\n${JSON.stringify(twinHttp)}\n\n`);
    const result = await readEventsJsonl(tmp);
    expect(result.kind).toBe("events");
    if (result.kind !== "events") return;
    expect(result.events).toHaveLength(1);
  });
});

describe("computeTraceHealth", () => {
  it("reports ok across all layers when each layer has events", () => {
    const layers = computeTraceHealth({ events: allEvents, scenarioUsesTwin: true });
    expect(layers).toEqual([
      {
        name: "proxy",
        count: 1,
        expectedAtLeast: 1,
        status: "ok",
        note: null,
      },
      {
        name: "twin",
        count: 1,
        expectedAtLeast: 1,
        status: "ok",
        note: null,
      },
      {
        name: "CAS adapter",
        count: 4,
        expectedAtLeast: 1,
        status: "ok",
        note: null,
      },
    ]);
  });

  it("warns when scenario expects LLM but no LlmCallEvent appears", () => {
    const layers = computeTraceHealth({
      events: [twinHttp],
      scenarioUsesTwin: true,
      scenarioExpectsLlm: true,
    });
    const proxy = layers.find((l) => l.name === "proxy")!;
    expect(proxy.count).toBe(0);
    expect(proxy.expectedAtLeast).toBe(1);
    expect(proxy.status).toBe("warning");
    expect(proxy.note).toBe("warning: capture-server may not have started");
  });

  it("does not warn on the proxy layer when scenario does not declare LLM use", () => {
    const layers = computeTraceHealth({ events: [twinHttp], scenarioUsesTwin: true });
    const proxy = layers.find((l) => l.name === "proxy")!;
    expect(proxy.count).toBe(0);
    expect(proxy.expectedAtLeast).toBe(0);
    expect(proxy.status).toBe("none");
    expect(proxy.note).toBeNull();
  });

  it("warns on the twin layer when scenarioUsesTwin is true but no twin events", () => {
    const layers = computeTraceHealth({ events: [llmCall], scenarioUsesTwin: true });
    const twin = layers.find((l) => l.name === "twin")!;
    expect(twin.status).toBe("warning");
  });

  it("warns on the CAS layer when scenarioExpectsCas is true but no adapter events", () => {
    const layers = computeTraceHealth({
      events: [twinHttp, llmCall],
      scenarioUsesTwin: true,
      scenarioExpectsCas: true,
    });
    const cas = layers.find((l) => l.name === "CAS adapter")!;
    expect(cas.status).toBe("warning");
  });
});

describe("renderTraceHealth", () => {
  it("formats each layer on its own line", () => {
    const layers = computeTraceHealth({ events: allEvents, scenarioUsesTwin: true });
    const lines = renderTraceHealth(layers);
    expect(lines[0]).toBe("Trace health:");
    expect(lines).toContain("  proxy: 1/expected≥1 [ok]");
    expect(lines).toContain("  twin: 1/expected≥1 [ok]");
    expect(lines).toContain("  CAS adapter: 4/expected≥1 [ok]");
  });

  it("appends the warning note when the layer is in warning state", () => {
    const layers = computeTraceHealth({
      events: [twinHttp],
      scenarioUsesTwin: true,
      scenarioExpectsLlm: true,
    });
    const lines = renderTraceHealth(layers);
    expect(lines).toContain(
      "  proxy: 0/expected≥1 [warning] (warning: capture-server may not have started)",
    );
  });
});

describe("renderEvents", () => {
  it("emits one section header and per-kind rows", () => {
    const lines = renderEvents(allEvents);
    expect(lines[0]).toBe("Events (6):");
    const body = lines.slice(1).join("\n");
    expect(body).toContain("TwinHttpEvent");
    expect(body).toContain("POST /repos/acme/api/issues/1/labels → 200");
    expect(body).toContain("LlmCallEvent");
    expect(body).toContain("api.anthropic.com:443");
    expect(body).toContain("ToolUseEvent   add_label (id=tu_1)");
    expect(body).toContain("ToolResultEvent ok (use_id=tu_1)");
    expect(body).toContain("SubagentSpawnEvent parent_tool_use_id=tu_1");
    expect(body).toContain("HookEvent      PreToolUse tool=add_label");
  });

  it("handles the empty case", () => {
    expect(renderEvents([])).toEqual(["Events: (none)"]);
  });
});

describe("LEGACY_EVENTS_MESSAGE", () => {
  it("is the exact wording locked by FDRS-403", () => {
    // The exit-code-2 contract is the message + the code. If either drifts,
    // tooling that scripts pome inspect (CI gates, dashboards) breaks.
    expect(LEGACY_EVENTS_MESSAGE).toBe(
      "this run was produced by an older CLI version (pre-M0); rerun against current CLI to view",
    );
  });
});
