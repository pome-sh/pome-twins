// SPDX-License-Identifier: Apache-2.0
//
// FDRS-407 acceptance: every SDK hook fires a HookEvent row in M0 schema.
// We invoke `buildPomeHooks()`'s callbacks directly with synthetic inputs —
// no live SDK round-trip needed; the callback contract is the unit under test.

import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HOOK_EVENTS,
  type HookCallback,
  type HookEvent,
  type HookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { buildPomeHooks } from "../src/hooks.js";
import { ADAPTER_SIGNALS_ENV } from "../src/signals.js";

let tmp: string;
let signalsPath: string;
const ORIGINAL_ENV = process.env[ADAPTER_SIGNALS_ENV];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pome-hooks-"));
  signalsPath = join(tmp, "adapter-signals.jsonl");
  process.env[ADAPTER_SIGNALS_ENV] = signalsPath;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ADAPTER_SIGNALS_ENV];
  else process.env[ADAPTER_SIGNALS_ENV] = ORIGINAL_ENV;
});

function readRows(): Array<Record<string, unknown>> {
  return readFileSync(signalsPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// HookCallback's `signal` arg isn't read by pome's emitter; provide an
// abort signal for type compatibility.
const NEVER_ABORTED = { signal: new AbortController().signal };

function callbackFor(event: HookEvent): HookCallback {
  const hooks = buildPomeHooks();
  const matchers = hooks[event];
  if (!matchers || matchers.length === 0) {
    throw new Error(`no matchers for ${event}`);
  }
  const cb = matchers[0]!.hooks[0];
  if (!cb) throw new Error(`no hook callback for ${event}`);
  return cb;
}

async function invoke(
  event: HookEvent,
  input: HookInput,
  toolUseID?: string,
): Promise<void> {
  await callbackFor(event)(input, toolUseID, NEVER_ABORTED);
}

// Builds a HookInput-like object. Tests only read `hook_event_name`,
// `tool_name`, and `tool_use_id` off the input, so we cast at the call site.
function fakeInput(extras: Record<string, unknown> = {}): HookInput {
  return {
    session_id: "ses_test",
    transcript_path: "/tmp/x.jsonl",
    cwd: "/tmp",
    permission_mode: "default",
    hook_event_name: "Notification",
    ...extras,
  } as unknown as HookInput;
}

describe("buildPomeHooks coverage", () => {
  it("registers a matcher for every entry in HOOK_EVENTS", () => {
    const hooks = buildPomeHooks();
    for (const event of HOOK_EVENTS) {
      expect(hooks[event]).toBeDefined();
      expect(hooks[event]!.length).toBeGreaterThanOrEqual(1);
      expect(hooks[event]![0]!.hooks.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("every hook returns { continue: true } (read-only — never mutates)", async () => {
    for (const event of HOOK_EVENTS) {
      const out = await callbackFor(event)(
        fakeInput({ hook_event_name: event }),
        undefined,
        NEVER_ABORTED,
      );
      expect(out).toEqual({ continue: true });
    }
  });

  it("each hook invocation appends exactly one HookEvent row", async () => {
    for (const event of HOOK_EVENTS) {
      await invoke(event, fakeInput({ hook_event_name: event }));
    }
    const rows = readRows();
    expect(rows).toHaveLength(HOOK_EVENTS.length);
    expect(new Set(rows.map((r) => r.hook_name))).toEqual(new Set(HOOK_EVENTS));
    for (const row of rows) {
      expect(row.kind).toBe("HookEvent");
      expect(typeof row.event_id).toBe("string");
      expect((row.event_id as string).length).toBeGreaterThan(0);
      expect(typeof row.ts).toBe("string");
      expect(Number.isFinite(Date.parse(row.ts as string))).toBe(true);
    }
  });
});

describe("HookEvent row shape per hook category", () => {
  it("tool category (PreToolUse): tool_name + parent_id from tool_use_id", async () => {
    await invoke(
      "PreToolUse",
      fakeInput({
        hook_event_name: "PreToolUse",
        tool_name: "list_open_issues",
        tool_input: { owner: "acme" },
        tool_use_id: "toolu_abc",
      }),
      "toolu_abc",
    );
    const [row] = readRows();
    expect(row).toMatchObject({
      kind: "HookEvent",
      hook_name: "PreToolUse",
      tool_name: "list_open_issues",
      parent_id: "toolu_abc",
    });
  });

  it("tool category (PostToolUse): reads tool_use_id from input when callback arg absent", async () => {
    await invoke(
      "PostToolUse",
      fakeInput({
        hook_event_name: "PostToolUse",
        tool_name: "create_issue",
        tool_input: {},
        tool_response: {},
        tool_use_id: "toolu_xyz",
      }),
    );
    const [row] = readRows();
    expect(row).toMatchObject({
      hook_name: "PostToolUse",
      tool_name: "create_issue",
      parent_id: "toolu_xyz",
    });
  });

  it("tool category (PostToolBatch): batch hook with no tool_name on input", async () => {
    await invoke(
      "PostToolBatch",
      fakeInput({
        hook_event_name: "PostToolBatch",
        tool_calls: [{ tool_name: "x" }, { tool_name: "y" }],
      }),
    );
    const [row] = readRows();
    expect(row).toMatchObject({
      hook_name: "PostToolBatch",
      tool_name: null,
      parent_id: null,
    });
  });

  it("subagent category (SubagentStart): no tool_name, parent_id null", async () => {
    await invoke(
      "SubagentStart",
      fakeInput({
        hook_event_name: "SubagentStart",
        agent_type: "general-purpose",
      }),
    );
    const [row] = readRows();
    expect(row).toMatchObject({
      hook_name: "SubagentStart",
      tool_name: null,
      parent_id: null,
    });
  });

  it("subagent category (SubagentStop): no tool_name", async () => {
    await invoke("SubagentStop", fakeInput({ hook_event_name: "SubagentStop" }));
    const [row] = readRows();
    expect(row).toMatchObject({
      hook_name: "SubagentStop",
      tool_name: null,
    });
  });

  it("compact category (PreCompact): no tool_name, parent_id null", async () => {
    await invoke(
      "PreCompact",
      fakeInput({ hook_event_name: "PreCompact", trigger: "auto" }),
    );
    const [row] = readRows();
    expect(row).toMatchObject({
      hook_name: "PreCompact",
      tool_name: null,
      parent_id: null,
    });
  });

  it("compact category (PostCompact): no tool_name", async () => {
    await invoke("PostCompact", fakeInput({ hook_event_name: "PostCompact" }));
    const [row] = readRows();
    expect(row).toMatchObject({ hook_name: "PostCompact", tool_name: null });
  });

  it("permission category (PermissionRequest): tool_name set, no tool_use_id", async () => {
    await invoke(
      "PermissionRequest",
      fakeInput({
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      }),
    );
    const [row] = readRows();
    expect(row).toMatchObject({
      hook_name: "PermissionRequest",
      tool_name: "Bash",
      parent_id: null,
    });
  });

  it("permission category (PermissionDenied): tool_name + tool_use_id → parent_id", async () => {
    await invoke(
      "PermissionDenied",
      fakeInput({
        hook_event_name: "PermissionDenied",
        tool_name: "Bash",
        tool_input: {},
        tool_use_id: "toolu_denied",
        reason: "policy",
      }),
    );
    const [row] = readRows();
    expect(row).toMatchObject({
      hook_name: "PermissionDenied",
      tool_name: "Bash",
      parent_id: "toolu_denied",
    });
  });

  it("task category (TaskCreated): no tool_name", async () => {
    await invoke(
      "TaskCreated",
      fakeInput({ hook_event_name: "TaskCreated", task_id: "t_1" }),
    );
    const [row] = readRows();
    expect(row).toMatchObject({
      hook_name: "TaskCreated",
      tool_name: null,
    });
  });

  it("task category (TaskCompleted): no tool_name", async () => {
    await invoke(
      "TaskCompleted",
      fakeInput({ hook_event_name: "TaskCompleted", task_id: "t_1" }),
    );
    const [row] = readRows();
    expect(row).toMatchObject({
      hook_name: "TaskCompleted",
      tool_name: null,
    });
  });

  it("message category (UserPromptSubmit): no tool_name", async () => {
    await invoke(
      "UserPromptSubmit",
      fakeInput({
        hook_event_name: "UserPromptSubmit",
        prompt: "hello",
      }),
    );
    const [row] = readRows();
    expect(row).toMatchObject({
      hook_name: "UserPromptSubmit",
      tool_name: null,
    });
  });

  it("message category (Notification): no tool_name", async () => {
    await invoke(
      "Notification",
      fakeInput({
        hook_event_name: "Notification",
        message: "x",
      }),
    );
    const [row] = readRows();
    expect(row).toMatchObject({
      hook_name: "Notification",
      tool_name: null,
    });
  });

  it("session category (SessionStart): tool_name null, parent_id null", async () => {
    await invoke(
      "SessionStart",
      fakeInput({ hook_event_name: "SessionStart", source: "startup" }),
    );
    const [row] = readRows();
    expect(row).toMatchObject({
      hook_name: "SessionStart",
      tool_name: null,
      parent_id: null,
    });
  });

  it("session category (SessionEnd): tool_name null", async () => {
    await invoke(
      "SessionEnd",
      fakeInput({ hook_event_name: "SessionEnd", reason: "exit" }),
    );
    const [row] = readRows();
    expect(row).toMatchObject({
      hook_name: "SessionEnd",
      tool_name: null,
      parent_id: null,
    });
  });

  it("session category (Stop / StopFailure): tool_name null", async () => {
    await invoke("Stop", fakeInput({ hook_event_name: "Stop" }));
    await invoke("StopFailure", fakeInput({ hook_event_name: "StopFailure" }));
    const rows = readRows();
    expect(rows.map((r) => r.hook_name)).toEqual(["Stop", "StopFailure"]);
    for (const r of rows) expect(r.tool_name).toBeNull();
  });
});

describe("static noop when env unset", () => {
  it("invoking every hook writes no file when POME_ADAPTER_SIGNALS_PATH is unset", async () => {
    delete process.env[ADAPTER_SIGNALS_ENV];
    for (const event of HOOK_EVENTS) {
      await invoke(event, fakeInput({ hook_event_name: event }));
    }
    expect(existsSync(signalsPath)).toBe(false);
  });
});

describe("event_id uniqueness", () => {
  it("every emitted row has a distinct event_id", async () => {
    for (let i = 0; i < 50; i++) {
      await invoke("Notification", fakeInput({ hook_event_name: "Notification" }));
    }
    const ids = new Set(readRows().map((r) => r.event_id));
    expect(ids.size).toBe(50);
  });
});
