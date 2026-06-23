// SPDX-License-Identifier: Apache-2.0
//
// Tests for `mergeSignalsIntoEvents` — the pure-function merge step that
// turns the two on-disk JSONL streams (events.jsonl + signals.jsonl) into
// one ts-ordered stream of M0 unified events. FDRS-412.

import { describe, expect, it } from "vitest";
import type {
  HookEvent,
  LlmCallEvent,
  ToolUseEvent,
} from "@pome-sh/shared-types";
import { mergeSignalsIntoEvents } from "../src/index.js";

function llm(ts: string, event_id: string): LlmCallEvent {
  return {
    ts,
    event_id,
    parent_id: null,
    kind: "LlmCallEvent",
    host: "api.anthropic.com",
    port: 443,
    latency_ms: 100,
    bytes_in: 0,
    bytes_out: 0,
    url: null,
    method: null,
    status: null,
    model: null,
    prompt_tokens: null,
    completion_tokens: null,
    cost_usd: null,
  };
}

function hook(ts: string, event_id: string, hook_name = "PreToolUse"): HookEvent {
  return {
    ts,
    event_id,
    parent_id: null,
    kind: "HookEvent",
    hook_name,
    tool_name: null,
  };
}

function toolUse(ts: string, event_id: string, tool_use_id: string): ToolUseEvent {
  return {
    ts,
    event_id,
    parent_id: null,
    kind: "ToolUseEvent",
    tool_use_id,
    tool_name: "Bash",
    input: {},
  };
}

describe("mergeSignalsIntoEvents", () => {
  it("returns [] when both inputs are empty", () => {
    expect(mergeSignalsIntoEvents([], [])).toEqual([]);
  });

  it("returns events untouched when signals is empty", () => {
    const events = [llm("2026-05-26T12:00:00.000Z", "e1")];
    expect(mergeSignalsIntoEvents(events, [])).toEqual(events);
  });

  it("returns signals when events is empty, in ts order", () => {
    const signals = [
      hook("2026-05-26T12:00:02.000Z", "s2"),
      hook("2026-05-26T12:00:01.000Z", "s1"),
    ];
    const out = mergeSignalsIntoEvents([], signals);
    expect(out.map((r) => r.event_id)).toEqual(["s1", "s2"]);
  });

  it("interleaves events + signals by ts ascending (the FDRS-412 acceptance case)", () => {
    // 3 LlmCallEvents (different ts) + 2 HookEvents (ts interleaved with them).
    const events: LlmCallEvent[] = [
      llm("2026-05-26T12:00:01.000Z", "llm_a"),
      llm("2026-05-26T12:00:03.000Z", "llm_b"),
      llm("2026-05-26T12:00:05.000Z", "llm_c"),
    ];
    const signals: HookEvent[] = [
      hook("2026-05-26T12:00:02.000Z", "hook_x"),
      hook("2026-05-26T12:00:04.000Z", "hook_y"),
    ];
    const out = mergeSignalsIntoEvents(events, signals);
    expect(out.map((r) => r.event_id)).toEqual([
      "llm_a",
      "hook_x",
      "llm_b",
      "hook_y",
      "llm_c",
    ]);
  });

  it("re-sorts events too — when events.jsonl rows aren't already chronological", () => {
    // capture-server appends LlmCallEvent rows in capture (CONNECT close) order;
    // out-of-order ts is possible. Merge must put them right.
    const events: LlmCallEvent[] = [
      llm("2026-05-26T12:00:03.000Z", "late"),
      llm("2026-05-26T12:00:01.000Z", "early"),
    ];
    const out = mergeSignalsIntoEvents(events, []);
    expect(out.map((r) => r.event_id)).toEqual(["early", "late"]);
  });

  it("is a stable sort — equal ts preserves input order (events first, then signals)", () => {
    const ts = "2026-05-26T12:00:00.000Z";
    const events = [llm(ts, "e1"), llm(ts, "e2")];
    const signals = [hook(ts, "s1"), hook(ts, "s2")];
    const out = mergeSignalsIntoEvents(events, signals);
    expect(out.map((r) => r.event_id)).toEqual(["e1", "e2", "s1", "s2"]);
  });

  it("does not mutate either input array", () => {
    const events = [llm("2026-05-26T12:00:03.000Z", "e1")];
    const signals = [hook("2026-05-26T12:00:01.000Z", "s1")];
    const eventsBefore = [...events];
    const signalsBefore = [...signals];
    mergeSignalsIntoEvents(events, signals);
    expect(events).toEqual(eventsBefore);
    expect(signals).toEqual(signalsBefore);
  });

  it("preserves event variant payloads (no field-dropping)", () => {
    const events = [llm("2026-05-26T12:00:00.000Z", "e1")];
    const signals = [toolUse("2026-05-26T12:00:01.000Z", "s1", "tlu_a")];
    const out = mergeSignalsIntoEvents(events, signals);
    expect(out).toEqual([events[0], signals[0]]);
  });
});
