// SPDX-License-Identifier: Apache-2.0
//
// withTurnUsage → LlmTurnEvent rows in the signals JSONL (F-766). Points the
// adapter's signals writer at a tmp file via the env contract, drives a
// synthetic SDK message stream, and asserts one LlmTurnEvent per assistant turn
// that reported usage — carrying the cache-read/cache-creation tokens the OTLP
// lane drops. Same turn detection as the OTLP `withGenAiSpans` lane, but this
// is the JSONL source-of-truth lane.

import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADAPTER_SIGNALS_ENV } from "../src/signals.js";
import { withTurnUsage } from "../src/turn-usage.js";

let tmp: string;
let signalsPath: string;
const ORIGINAL_ENV = process.env[ADAPTER_SIGNALS_ENV];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pome-turn-"));
  signalsPath = join(tmp, "adapter-signals.jsonl");
  process.env[ADAPTER_SIGNALS_ENV] = signalsPath;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ADAPTER_SIGNALS_ENV];
  else process.env[ADAPTER_SIGNALS_ENV] = ORIGINAL_ENV;
});

function readRows(): Array<Record<string, unknown>> {
  if (!existsSync(signalsPath)) return [];
  return readFileSync(signalsPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function drive(messages: Array<{ type: string; [k: string]: unknown }>): Promise<void> {
  async function* src() {
    for (const m of messages) yield m;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of withTurnUsage(src())) void _;
}

describe("withTurnUsage → LlmTurnEvent signals", () => {
  it("emits one LlmTurnEvent per usage-bearing assistant turn, with cache tokens", async () => {
    await drive([
      { type: "system" },
      {
        type: "assistant",
        message: {
          model: "claude-opus-4-8",
          stop_reason: "end_turn",
          usage: {
            input_tokens: 1200,
            output_tokens: 340,
            cache_read_input_tokens: 900,
            cache_creation_input_tokens: 128,
          },
        },
      },
      { type: "result", subtype: "success" },
    ]);

    const rows = readRows();
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.kind).toBe("LlmTurnEvent");
    expect(r.turn_index).toBe(0);
    expect(r.parent_id).toBeNull();
    expect(r.model).toBe("claude-opus-4-8");
    expect(r.input_tokens).toBe(1200);
    expect(r.output_tokens).toBe(340);
    expect(r.cache_read_input_tokens).toBe(900);
    expect(r.cache_creation_input_tokens).toBe(128);
    expect(r.finish_reasons).toEqual(["end_turn"]);
    expect(r.latency_ms_estimated).toBe(true);
    expect(typeof r.latency_ms).toBe("number");
    expect(r.latency_ms as number).toBeGreaterThanOrEqual(0);
    expect(r.session_id).toBeNull();
    // ts is ISO-8601 + event_id present (uuid).
    expect(typeof r.ts).toBe("string");
    expect(typeof r.event_id).toBe("string");
  });

  it("increments turn_index across usage turns and skips usage-less turns", async () => {
    await drive([
      { type: "assistant", message: { model: "m", usage: { input_tokens: 5, output_tokens: 2 } } },
      // No usage → no row, and turn_index must NOT advance for it.
      { type: "assistant", message: { model: "m" } },
      { type: "assistant", message: { model: "m", usage: { input_tokens: 7, output_tokens: 3 } } },
      { type: "result", subtype: "success" },
    ]);

    const rows = readRows();
    expect(rows.map((r) => r.turn_index)).toEqual([0, 1]);
  });

  it("emits explicit null for absent cache/model/finish fields (nullable, not optional)", async () => {
    await drive([
      { type: "assistant", message: { usage: { input_tokens: 10, output_tokens: 4 } } },
      { type: "result", subtype: "success" },
    ]);

    const rows = readRows();
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    // The keys are PRESENT with null values (stable on-disk shape).
    expect(r).toHaveProperty("model", null);
    expect(r).toHaveProperty("cache_read_input_tokens", null);
    expect(r).toHaveProperty("cache_creation_input_tokens", null);
    expect(r).toHaveProperty("finish_reasons", null);
    expect(r).toHaveProperty("session_id", null);
  });

  it("is a static noop when the signals env is unset (no file, no throw)", async () => {
    delete process.env[ADAPTER_SIGNALS_ENV];
    await expect(
      drive([
        { type: "assistant", message: { model: "m", usage: { input_tokens: 1, output_tokens: 1 } } },
        { type: "result", subtype: "success" },
      ]),
    ).resolves.toBeUndefined();
    expect(existsSync(signalsPath)).toBe(false);
  });

  it("yields every source message verbatim (transparent pass-through)", async () => {
    const seen: string[] = [];
    async function* src() {
      yield { type: "assistant", message: { usage: { input_tokens: 1, output_tokens: 1 } } };
      yield { type: "result" };
    }
    for await (const m of withTurnUsage(src())) seen.push(m.type);
    expect(seen).toEqual(["assistant", "result"]);
  });
});
