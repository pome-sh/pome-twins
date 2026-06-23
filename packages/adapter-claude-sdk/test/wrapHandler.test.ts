// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { currentToolCallId } from "../src/als.js";
import { wrapHandler } from "../src/wrapHandler.js";

describe("wrapHandler", () => {
  it("calls the underlying handler with the same args and returns its value", async () => {
    const inner = async (args: { x: number }) => ({ doubled: args.x * 2 });
    const wrapped = wrapHandler(inner);
    const result = await wrapped({ x: 21 });
    expect(result).toEqual({ doubled: 42 });
  });

  it("sets tool_call_id in callContext during handler execution", async () => {
    let seenId: string | null = null;
    const wrapped = wrapHandler(async () => {
      seenId = currentToolCallId();
      return null;
    });
    await wrapped({});
    expect(seenId).toMatch(/^tlc_/);
  });

  it("clears callContext after handler exits", async () => {
    const wrapped = wrapHandler(async () => null);
    await wrapped({});
    expect(currentToolCallId()).toBeNull();
  });

  it("uses a distinct tool_call_id on each invocation", async () => {
    const seen: Array<string | null> = [];
    const wrapped = wrapHandler(async () => {
      seen.push(currentToolCallId());
      return null;
    });
    await wrapped({});
    await wrapped({});
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("isolates tool_call_id across concurrent invocations", async () => {
    const seen: string[] = [];
    const wrapped = wrapHandler(async () => {
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      const id = currentToolCallId();
      if (id) seen.push(id);
      return null;
    });
    await Promise.all([wrapped({}), wrapped({}), wrapped({}), wrapped({})]);
    expect(new Set(seen).size).toBe(4);
  });

  it("propagates exceptions from the inner handler", async () => {
    const wrapped = wrapHandler(async () => {
      throw new Error("inner exploded");
    });
    await expect(wrapped({})).rejects.toThrow("inner exploded");
  });

  it("clears callContext even when handler throws", async () => {
    const wrapped = wrapHandler(async () => {
      throw new Error("x");
    });
    try {
      await wrapped({});
    } catch {
      /* swallow */
    }
    expect(currentToolCallId()).toBeNull();
  });
});
