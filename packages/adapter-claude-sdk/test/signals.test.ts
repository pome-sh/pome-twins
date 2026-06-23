// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ADAPTER_SIGNALS_ENV,
  newEventId,
  resolveSignalsPath,
  writeHookEvent,
} from "../src/signals.js";

let tmp: string;
let signalsPath: string;
const ORIGINAL_ENV = process.env[ADAPTER_SIGNALS_ENV];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pome-sigs-"));
  signalsPath = join(tmp, "adapter-signals.jsonl");
  process.env[ADAPTER_SIGNALS_ENV] = signalsPath;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ADAPTER_SIGNALS_ENV];
  else process.env[ADAPTER_SIGNALS_ENV] = ORIGINAL_ENV;
});

function readLines(path: string): string[] {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
}

describe("resolveSignalsPath", () => {
  it("returns the env var when set", () => {
    expect(resolveSignalsPath()).toBe(signalsPath);
  });

  it("returns null when env unset", () => {
    delete process.env[ADAPTER_SIGNALS_ENV];
    expect(resolveSignalsPath()).toBeNull();
  });

  it("treats empty-string env as unset", () => {
    process.env[ADAPTER_SIGNALS_ENV] = "";
    expect(resolveSignalsPath()).toBeNull();
  });
});

describe("newEventId", () => {
  it("returns a distinct uuid on each call", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(newEventId());
    expect(ids.size).toBe(1000);
  });

  it("returns RFC 4122 v4-shaped strings", () => {
    expect(newEventId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("writeHookEvent", () => {
  it("appends a JSON line with kind=HookEvent and all M0 fields", () => {
    writeHookEvent({
      ts: "2026-05-26T20:00:00.000Z",
      event_id: "11111111-1111-4111-8111-111111111111",
      parent_id: null,
      kind: "HookEvent",
      hook_name: "SessionStart",
      tool_name: null,
    });
    const lines = readLines(signalsPath);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      ts: "2026-05-26T20:00:00.000Z",
      event_id: "11111111-1111-4111-8111-111111111111",
      parent_id: null,
      kind: "HookEvent",
      hook_name: "SessionStart",
      tool_name: null,
    });
  });

  it("preserves tool_name and parent_id when supplied", () => {
    writeHookEvent({
      ts: "2026-05-26T20:00:01.000Z",
      event_id: "22222222-2222-4222-8222-222222222222",
      parent_id: "toolu_abc",
      kind: "HookEvent",
      hook_name: "PostToolUse",
      tool_name: "list_open_issues",
    });
    const parsed = JSON.parse(readLines(signalsPath)[0]!);
    expect(parsed.tool_name).toBe("list_open_issues");
    expect(parsed.parent_id).toBe("toolu_abc");
  });

  it("appends multiple lines without overwriting", () => {
    writeHookEvent({
      ts: "2026-05-26T20:00:00.000Z",
      event_id: "a",
      parent_id: null,
      kind: "HookEvent",
      hook_name: "SessionStart",
      tool_name: null,
    });
    writeHookEvent({
      ts: "2026-05-26T20:00:01.000Z",
      event_id: "b",
      parent_id: null,
      kind: "HookEvent",
      hook_name: "SessionEnd",
      tool_name: null,
    });
    expect(readLines(signalsPath)).toHaveLength(2);
  });

  it("is a static noop when env unset (no file created, no throw)", () => {
    delete process.env[ADAPTER_SIGNALS_ENV];
    expect(() =>
      writeHookEvent({
        ts: "2026-05-26T20:00:00.000Z",
        event_id: "a",
        parent_id: null,
        kind: "HookEvent",
        hook_name: "SessionStart",
        tool_name: null,
      }),
    ).not.toThrow();
    expect(existsSync(signalsPath)).toBe(false);
  });
});
