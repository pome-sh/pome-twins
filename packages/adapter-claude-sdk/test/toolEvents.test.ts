// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADAPTER_SIGNALS_ENV } from "../src/signals.js";
import { withToolEvents } from "../src/wrapQuery.js";

let tmp: string;
let signalsPath: string;
const ORIGINAL_ENV = process.env[ADAPTER_SIGNALS_ENV];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pome-toolevt-"));
  signalsPath = join(tmp, "adapter-signals.jsonl");
  process.env[ADAPTER_SIGNALS_ENV] = signalsPath;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ADAPTER_SIGNALS_ENV];
  else process.env[ADAPTER_SIGNALS_ENV] = ORIGINAL_ENV;
});

type FakeMsg =
  | { type: "assistant"; message: { content: Array<unknown> }; parent_tool_use_id?: string | null }
  | { type: "user"; message: { content: Array<unknown> | string } }
  | { type: "system" }
  | { type: "result" };

async function* fakeRun(messages: FakeMsg[]) {
  for (const m of messages) yield m;
}

function readRows(path: string) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("withToolEvents", () => {
  it("yields every message from the underlying iterable verbatim", async () => {
    const messages: FakeMsg[] = [
      { type: "system" },
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "toolu_a", name: "list_issues", input: { q: "open" } }],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "ok", is_error: false }],
        },
      },
      { type: "result" },
    ];
    const out: FakeMsg[] = [];
    for await (const m of withToolEvents(fakeRun(messages))) out.push(m);
    expect(out).toEqual(messages);
  });

  it("ticket acceptance: one tool_use + matching tool_result emits ToolUseEvent + ToolResultEvent with parent_id linkage", async () => {
    const messages: FakeMsg[] = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "calling tool" },
            { type: "tool_use", id: "toolu_xyz", name: "list_issues", input: { repo: "pome" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_xyz",
              content: [{ type: "text", text: "5 issues" }],
              is_error: false,
            },
          ],
        },
      },
    ];
    for await (const _ of withToolEvents(fakeRun(messages))) void _;

    const rows = readRows(signalsPath);
    const tu = rows.filter((r) => r.kind === "ToolUseEvent");
    const tr = rows.filter((r) => r.kind === "ToolResultEvent");
    expect(tu).toHaveLength(1);
    expect(tr).toHaveLength(1);

    expect(tu[0].tool_use_id).toBe("toolu_xyz");
    expect(tu[0].tool_name).toBe("list_issues");
    expect(tu[0].input).toEqual({ repo: "pome" });
    expect(typeof tu[0].event_id).toBe("string");
    expect(tu[0].event_id.length).toBeGreaterThan(0);
    expect(typeof tu[0].ts).toBe("string");
    expect(tu[0].parent_id === null || typeof tu[0].parent_id === "string").toBe(true);

    expect(tr[0].tool_use_id).toBe("toolu_xyz");
    expect(tr[0].is_error).toBe(false);
    expect(tr[0].parent_id).toBe(tu[0].event_id);
    expect(typeof tr[0].event_id).toBe("string");
    expect(tr[0].event_id).not.toBe(tu[0].event_id);
  });

  it("redacts secrets in tool_use input before write", async () => {
    const apiKey = "sk-" + "test-ABCDEFGHIJKLMNOPQRSTUVWX";
    const messages: FakeMsg[] = [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_secret",
              name: "set_creds",
              input: {
                authorization: "Bearer leakme",
                note: `key ${apiKey}`,
              },
            },
          ],
        },
      },
    ];
    for await (const _ of withToolEvents(fakeRun(messages))) void _;
    const [row] = readRows(signalsPath).filter((r) => r.kind === "ToolUseEvent");
    expect(row.input.authorization).toBe("[REDACTED]");
    expect(row.input.note).toBe("key [REDACTED]");
  });

  it("redacts secrets in tool_result output before write", async () => {
    const apiKey = "sk-" + "a".repeat(24);
    const messages: FakeMsg[] = [
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "toolu_r", name: "fetch", input: {} }],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_r",
              content: [{ type: "text", text: `token=${apiKey}` }],
              is_error: false,
            },
          ],
        },
      },
    ];
    for await (const _ of withToolEvents(fakeRun(messages))) void _;
    const [row] = readRows(signalsPath).filter((r) => r.kind === "ToolResultEvent");
    expect(JSON.stringify(row.output)).toContain("[REDACTED]");
    expect(JSON.stringify(row.output)).not.toContain(apiKey);
  });

  it("propagates is_error=true from the content block", async () => {
    const messages: FakeMsg[] = [
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_e", name: "boom", input: {} }] },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu_e", content: "kaboom", is_error: true },
          ],
        },
      },
    ];
    for await (const _ of withToolEvents(fakeRun(messages))) void _;
    const [row] = readRows(signalsPath).filter((r) => r.kind === "ToolResultEvent");
    expect(row.is_error).toBe(true);
  });

  it("orphan tool_result (no prior tool_use) still emits with parent_id=null", async () => {
    const messages: FakeMsg[] = [
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu_ghost", content: "x", is_error: false },
          ],
        },
      },
    ];
    for await (const _ of withToolEvents(fakeRun(messages))) void _;
    const rows = readRows(signalsPath);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("ToolResultEvent");
    expect(rows[0].tool_use_id).toBe("toolu_ghost");
    expect(rows[0].parent_id).toBeNull();
  });

  it("ignores assistant messages with no tool_use blocks", async () => {
    const messages: FakeMsg[] = [
      { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
    ];
    for await (const _ of withToolEvents(fakeRun(messages))) void _;
    expect(existsSync(signalsPath)).toBe(false);
  });

  it("ignores user messages whose content is a plain string", async () => {
    const messages: FakeMsg[] = [{ type: "user", message: { content: "hi there" } }];
    for await (const _ of withToolEvents(fakeRun(messages))) void _;
    expect(existsSync(signalsPath)).toBe(false);
  });

  it("is a static noop on signals when env unset (iteration still works)", async () => {
    delete process.env[ADAPTER_SIGNALS_ENV];
    const messages: FakeMsg[] = [
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_q", name: "x", input: {} }] },
      },
    ];
    const out: FakeMsg[] = [];
    for await (const m of withToolEvents(fakeRun(messages))) out.push(m);
    expect(out).toHaveLength(1);
    expect(existsSync(signalsPath)).toBe(false);
  });

  it("FDRS-409 ticket acceptance: 1 parent tool_use + 2 child assistant messages emits 1 SubagentSpawnEvent and chains child events via parent_id", async () => {
    const messages: FakeMsg[] = [
      // Parent agent fires the spawning tool_use (e.g. Task tool).
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "toolu_parent", name: "Task", input: { prompt: "do work" } },
          ],
        },
      },
      // Two child assistant messages from the spawned sub-agent, both carrying
      // the same parent_tool_use_id at the top level. Each emits one child
      // tool_use; only the first should trigger a SubagentSpawnEvent.
      {
        type: "assistant",
        parent_tool_use_id: "toolu_parent",
        message: {
          content: [
            { type: "tool_use", id: "toolu_child_a", name: "Read", input: { path: "/a" } },
          ],
        },
      },
      {
        type: "assistant",
        parent_tool_use_id: "toolu_parent",
        message: {
          content: [
            { type: "tool_use", id: "toolu_child_b", name: "Grep", input: { pattern: "x" } },
          ],
        },
      },
    ];
    for await (const _ of withToolEvents(fakeRun(messages))) void _;

    const rows = readRows(signalsPath);
    const spawns = rows.filter((r) => r.kind === "SubagentSpawnEvent");
    const uses = rows.filter((r) => r.kind === "ToolUseEvent");

    expect(spawns).toHaveLength(1);
    expect(spawns[0].parent_tool_use_id).toBe("toolu_parent");
    expect(typeof spawns[0].event_id).toBe("string");
    expect(spawns[0].event_id.length).toBeGreaterThan(0);

    const parentUse = uses.find((r) => r.tool_use_id === "toolu_parent");
    const childA = uses.find((r) => r.tool_use_id === "toolu_child_a");
    const childB = uses.find((r) => r.tool_use_id === "toolu_child_b");

    // SubagentSpawnEvent.parent_id points at the spawning tool_use's event_id.
    expect(spawns[0].parent_id).toBe(parentUse?.event_id);

    // Parent tool_use itself has no sub-agent ancestor.
    expect(parentUse?.parent_id).toBeNull();

    // Both child tool_uses chain through the SubagentSpawnEvent.
    expect(childA?.parent_id).toBe(spawns[0].event_id);
    expect(childB?.parent_id).toBe(spawns[0].event_id);
  });

  it("emits at most one SubagentSpawnEvent per distinct parent_tool_use_id", async () => {
    const messages: FakeMsg[] = [
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_p1", name: "Task", input: {} }] },
      },
      {
        type: "assistant",
        parent_tool_use_id: "toolu_p1",
        message: { content: [{ type: "tool_use", id: "toolu_c1", name: "Read", input: {} }] },
      },
      {
        type: "assistant",
        parent_tool_use_id: "toolu_p1",
        message: { content: [{ type: "tool_use", id: "toolu_c2", name: "Read", input: {} }] },
      },
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_p2", name: "Task", input: {} }] },
      },
      {
        type: "assistant",
        parent_tool_use_id: "toolu_p2",
        message: { content: [{ type: "tool_use", id: "toolu_c3", name: "Read", input: {} }] },
      },
    ];
    for await (const _ of withToolEvents(fakeRun(messages))) void _;
    const rows = readRows(signalsPath);
    const spawns = rows.filter((r) => r.kind === "SubagentSpawnEvent");
    expect(spawns).toHaveLength(2);
    expect(spawns.map((s) => s.parent_tool_use_id).sort()).toEqual(["toolu_p1", "toolu_p2"]);
  });

  it("handles multiple tool_use blocks in a single assistant message", async () => {
    const messages: FakeMsg[] = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "toolu_1", name: "a", input: {} },
            { type: "tool_use", id: "toolu_2", name: "b", input: {} },
          ],
        },
      },
    ];
    for await (const _ of withToolEvents(fakeRun(messages))) void _;
    const rows = readRows(signalsPath).filter((r) => r.kind === "ToolUseEvent");
    expect(rows.map((r) => r.tool_use_id)).toEqual(["toolu_1", "toolu_2"]);
    expect(new Set(rows.map((r) => r.event_id)).size).toBe(2);
  });
});
