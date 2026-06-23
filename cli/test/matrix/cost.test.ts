// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the resource rollup over a cell's events.jsonl, focused on the
// mcp-loop telemetry path: the scaffold emits authoritative per-step
// LlmCallEvent rows (tokens + latency + optional gateway cost), and the matrix
// runs mcp-loop cells with capture OFF so the token-less capture-server proxy
// row never coexists with them. These tests pin both the happy path (scaffold
// rows yield real tokens/latency/cost) and the double-count hazard the
// capture-off decision avoids (a proxy row's real latency would inflate the sum).
import { describe, expect, it } from "vitest";
import { runResourceMetrics } from "../../src/matrix/cost.js";
import type { LlmCallEvent } from "../../src/types/shared.js";

// Build a scaffold-emitted LlmCallEvent row (the shape emitLlmCall writes).
function scaffoldLlmRow(over: Partial<LlmCallEvent> = {}): LlmCallEvent {
  return {
    ts: "2026-06-01T10:30:45.123Z",
    event_id: "evt-scaffold",
    parent_id: null,
    kind: "LlmCallEvent",
    host: "ai-gateway",
    port: 443,
    latency_ms: 1000,
    bytes_in: 0,
    bytes_out: 0,
    url: null,
    method: null,
    status: null,
    model: "anthropic/claude-opus-4.5",
    prompt_tokens: 1200,
    completion_tokens: 450,
    cost_usd: null,
    ...over,
  };
}

// A capture-server PROXY row: real wall-clock latency from the TLS tunnel, but
// token-less and cost-less (the proxy can't read the encrypted body). This is
// exactly the row the matrix suppresses for mcp-loop cells via --no-capture.
function proxyLlmRow(over: Partial<LlmCallEvent> = {}): LlmCallEvent {
  return {
    ts: "2026-06-01T10:30:48.000Z",
    event_id: "evt-proxy",
    parent_id: null,
    kind: "LlmCallEvent",
    host: "ai-gateway.vercel.sh",
    port: 443,
    latency_ms: 3000,
    bytes_in: 5000,
    bytes_out: 800,
    url: null,
    method: null,
    status: null,
    model: null,
    prompt_tokens: null,
    completion_tokens: null,
    cost_usd: null,
    ...over,
  };
}

describe("runResourceMetrics — mcp-loop scaffold telemetry", () => {
  it("reads tokens/latency from scaffold rows and prices via the table (Tier 2)", () => {
    const pricing = {
      "anthropic/claude-opus-4.5": { input_per_mtok: 5.0, output_per_mtok: 25.0 },
    };
    const events = [
      scaffoldLlmRow({ prompt_tokens: 1000, completion_tokens: 200, latency_ms: 1500 }),
      scaffoldLlmRow({ prompt_tokens: 800, completion_tokens: 300, latency_ms: 2500 }),
    ];

    const m = runResourceMetrics(events, pricing);

    expect(m.prompt_tokens).toBe(1800);
    expect(m.completion_tokens).toBe(500);
    expect(m.latency_ms).toBe(4000); // summed scaffold-call latency, no proxy
    // Tier 2: (1800/1e6)*5 + (500/1e6)*25 = 0.009 + 0.0125 = 0.0215
    expect(m.cost_usd).toBeCloseTo(0.0215, 6);
  });

  it("prefers gateway-reported cost (Tier 1) when a scaffold row carries cost_usd", () => {
    const events = [
      scaffoldLlmRow({ cost_usd: 0.012 }),
      scaffoldLlmRow({ cost_usd: 0.008 }),
    ];
    // Empty pricing table: only Tier 1 can produce a non-null cost.
    const m = runResourceMetrics(events, {});
    expect(m.cost_usd).toBeCloseTo(0.02, 6);
  });

  it("does NOT double-count latency when scaffold is the SOLE source (capture off)", () => {
    // The capture-off decision means only scaffold rows reach events.jsonl.
    const events = [
      scaffoldLlmRow({ latency_ms: 1500 }),
      scaffoldLlmRow({ latency_ms: 2500 }),
    ];
    const m = runResourceMetrics(events, {});
    expect(m.latency_ms).toBe(4000); // exactly the scaffold wall-clock
  });

  it("demonstrates the proxy double-count hazard the capture-off decision avoids", () => {
    // If a token-less proxy row coexisted with the scaffold rows, its real
    // tunnel latency would SUM into the cell total and inflate it. This pins
    // WHY mcp-loop runs with capture off — turning the proxy on here proves the
    // corruption (latency 4000 → 7000) while tokens stay correct (proxy is null).
    const scaffoldOnly = [
      scaffoldLlmRow({ latency_ms: 1500, prompt_tokens: 1000, completion_tokens: 200 }),
      scaffoldLlmRow({ latency_ms: 2500, prompt_tokens: 800, completion_tokens: 300 }),
    ];
    const withProxy = [...scaffoldOnly, proxyLlmRow({ latency_ms: 3000 })];

    const clean = runResourceMetrics(scaffoldOnly, {});
    const corrupted = runResourceMetrics(withProxy, {});

    // Tokens are safe either way (proxy contributes null → 0).
    expect(corrupted.prompt_tokens).toBe(clean.prompt_tokens);
    expect(corrupted.completion_tokens).toBe(clean.completion_tokens);
    // Latency is the ONLY field the proxy corrupts: 4000 (clean) vs 7000 (proxy).
    expect(clean.latency_ms).toBe(4000);
    expect(corrupted.latency_ms).toBe(7000);
    expect(corrupted.latency_ms).not.toBe(clean.latency_ms);
  });
});
