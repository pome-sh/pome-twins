// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { eventSchema } from "../../../src/types/shared.js";
import { mergeAdapterSignalsIntoEvents } from "../../../src/runner/mergeAdapterSignals.js";

async function workspace() {
  return mkdtemp(join(tmpdir(), "pome-merge-"));
}

function llm(ts: string, event_id: string) {
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

function hook(ts: string, event_id: string, hook_name = "PreToolUse") {
  return {
    ts,
    event_id,
    parent_id: null,
    kind: "HookEvent",
    hook_name,
    tool_name: null,
  };
}

function llmTurn(ts: string, event_id: string, turn_index = 0) {
  return {
    ts,
    event_id,
    parent_id: null,
    kind: "LlmTurnEvent",
    turn_index,
    model: "claude-opus-4-8",
    input_tokens: 1200,
    output_tokens: 340,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 128,
    finish_reasons: ["end_turn"],
    latency_ms: 2150,
    latency_ms_estimated: true,
    session_id: null,
  };
}

describe("mergeAdapterSignalsIntoEvents", () => {
  it("interleaves 3 LlmCallEvents + 2 HookEvents in ts order; every merged row validates (FDRS-412)", async () => {
    const dir = await workspace();
    const eventsPath = join(dir, "events.jsonl");
    const signalsPath = join(dir, "signals.jsonl");

    const e1 = llm("2026-05-26T12:00:01.000Z", "llm_a");
    const e2 = llm("2026-05-26T12:00:03.000Z", "llm_b");
    const e3 = llm("2026-05-26T12:00:05.000Z", "llm_c");
    const s1 = hook("2026-05-26T12:00:02.000Z", "hook_x");
    const s2 = hook("2026-05-26T12:00:04.000Z", "hook_y");

    await writeFile(eventsPath, [e1, e2, e3].map((r) => JSON.stringify(r)).join("\n") + "\n");
    await writeFile(signalsPath, [s1, s2].map((r) => JSON.stringify(r)).join("\n") + "\n");

    const result = await mergeAdapterSignalsIntoEvents(signalsPath, eventsPath);
    expect(result).toEqual({ appended: 2, dropped: 0 });

    const lines = (await readFile(eventsPath, "utf8")).split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(5);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.map((r) => r.event_id)).toEqual([
      "llm_a",
      "hook_x",
      "llm_b",
      "hook_y",
      "llm_c",
    ]);
    // Every merged row schema-validates against the M0 unified event union.
    for (const row of parsed) {
      expect(eventSchema.safeParse(row).success).toBe(true);
    }
  });

  it("admits LlmTurnEvent signal rows and preserves cache tokens (F-766)", async () => {
    const dir = await workspace();
    const eventsPath = join(dir, "events.jsonl");
    const signalsPath = join(dir, "signals.jsonl");

    // A twin HTTP row already on disk, plus a turn-usage row + a tool row from
    // the adapter signals sidechannel — interleaved by ts on merge.
    const existing = llm("2026-05-26T12:00:00.000Z", "llm_a");
    const turn = llmTurn("2026-05-26T12:00:02.000Z", "turn_0");
    const hk = hook("2026-05-26T12:00:01.000Z", "hook_x");
    await writeFile(eventsPath, JSON.stringify(existing) + "\n");
    await writeFile(signalsPath, [hk, turn].map((r) => JSON.stringify(r)).join("\n") + "\n");

    const result = await mergeAdapterSignalsIntoEvents(signalsPath, eventsPath);
    expect(result).toEqual({ appended: 2, dropped: 0 });

    const parsed = (await readFile(eventsPath, "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    expect(parsed.map((r) => r.event_id)).toEqual(["llm_a", "hook_x", "turn_0"]);

    const turnRow = parsed.find((r) => r.kind === "LlmTurnEvent");
    expect(turnRow).toBeDefined();
    // The cache-token counts — the whole point of F-766 — survive the merge.
    expect(turnRow.cache_read_input_tokens).toBe(900);
    expect(turnRow.cache_creation_input_tokens).toBe(128);
    expect(turnRow.turn_index).toBe(0);
    expect(turnRow.finish_reasons).toEqual(["end_turn"]);
    // ...and it schema-validates as a canonical union member.
    expect(eventSchema.safeParse(turnRow).success).toBe(true);
  });

  it("re-sorts out-of-order events.jsonl rows when merging signals (interleave)", async () => {
    // capture-server appends LlmCallEvents as each CONNECT tunnel closes —
    // a slow first tunnel + fast second one can land out of ts order on disk.
    // When signals are merged in, the whole file is rewritten ts-sorted.
    const dir = await workspace();
    const eventsPath = join(dir, "events.jsonl");
    const signalsPath = join(dir, "signals.jsonl");

    const late = llm("2026-05-26T12:00:03.000Z", "late");
    const early = llm("2026-05-26T12:00:01.000Z", "early");
    const s = hook("2026-05-26T12:00:02.000Z", "hook_mid");
    await writeFile(eventsPath, [late, early].map((r) => JSON.stringify(r)).join("\n") + "\n");
    await writeFile(signalsPath, JSON.stringify(s) + "\n");

    await mergeAdapterSignalsIntoEvents(signalsPath, eventsPath);
    const lines = (await readFile(eventsPath, "utf8")).split("\n").filter((l) => l.length > 0);
    expect(lines.map((l) => JSON.parse(l).event_id)).toEqual(["early", "hook_mid", "late"]);
  });

  it("appends valid HookEvent rows from signals.jsonl to events.jsonl, ts-sorted", async () => {
    const dir = await workspace();
    const eventsPath = join(dir, "events.jsonl");
    const signalsPath = join(dir, "signals.jsonl");
    await writeFile(eventsPath, "\n");
    const rowA = {
      ts: "2026-05-26T12:00:02.000Z",
      event_id: "evt_b",
      parent_id: null,
      kind: "HookEvent",
      hook_name: "PostToolUse",
      tool_name: "Bash",
    };
    const rowB = {
      ts: "2026-05-26T12:00:01.000Z",
      event_id: "evt_a",
      parent_id: null,
      kind: "HookEvent",
      hook_name: "PreToolUse",
      tool_name: "Bash",
    };
    await writeFile(signalsPath, `${JSON.stringify(rowA)}\n${JSON.stringify(rowB)}\n`);

    const result = await mergeAdapterSignalsIntoEvents(signalsPath, eventsPath);
    expect(result).toEqual({ appended: 2, dropped: 0 });

    const lines = (await readFile(eventsPath, "utf8")).split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event_id).toBe("evt_a");
    expect(JSON.parse(lines[1]).event_id).toBe("evt_b");
  });

  it("is a no-op when signals.jsonl is empty", async () => {
    const dir = await workspace();
    const eventsPath = join(dir, "events.jsonl");
    const signalsPath = join(dir, "signals.jsonl");
    await writeFile(eventsPath, "\n");
    await writeFile(signalsPath, "");

    const result = await mergeAdapterSignalsIntoEvents(signalsPath, eventsPath);
    expect(result).toEqual({ appended: 0, dropped: 0 });
    expect(await readFile(eventsPath, "utf8")).toBe("\n");
  });

  it("returns {appended:0} when signals.jsonl is missing", async () => {
    const dir = await workspace();
    const eventsPath = join(dir, "events.jsonl");
    await writeFile(eventsPath, "\n");

    const result = await mergeAdapterSignalsIntoEvents(join(dir, "missing.jsonl"), eventsPath);
    expect(result).toEqual({ appended: 0, dropped: 0 });
  });

  it("drops malformed JSON lines and schema-invalid rows without throwing", async () => {
    const dir = await workspace();
    const eventsPath = join(dir, "events.jsonl");
    const signalsPath = join(dir, "signals.jsonl");
    await writeFile(eventsPath, "\n");
    const valid = {
      ts: "2026-05-26T12:00:00.000Z",
      event_id: "evt_ok",
      parent_id: null,
      kind: "HookEvent",
      hook_name: "PreToolUse",
      tool_name: null,
    };
    await writeFile(
      signalsPath,
      [
        "{not json",
        JSON.stringify({ ts: "x", kind: "HookEvent" }),
        JSON.stringify(valid),
      ].join("\n") + "\n",
    );

    const result = await mergeAdapterSignalsIntoEvents(signalsPath, eventsPath);
    expect(result.appended).toBe(1);
    expect(result.dropped).toBe(2);
    const lines = (await readFile(eventsPath, "utf8")).split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).event_id).toBe("evt_ok");
  });

  it("interleaves signals with existing events.jsonl rows in ts order", async () => {
    const dir = await workspace();
    const eventsPath = join(dir, "events.jsonl");
    const signalsPath = join(dir, "signals.jsonl");
    const existing = llm("2026-05-26T11:00:00.000Z", "evt_existing");
    await writeFile(eventsPath, JSON.stringify(existing) + "\n");
    const valid = hook("2026-05-26T12:00:00.000Z", "evt_hook");
    await writeFile(signalsPath, JSON.stringify(valid) + "\n");

    await mergeAdapterSignalsIntoEvents(signalsPath, eventsPath);
    const lines = (await readFile(eventsPath, "utf8")).split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event_id).toBe("evt_existing");
    expect(JSON.parse(lines[1]).event_id).toBe("evt_hook");
  });
});
