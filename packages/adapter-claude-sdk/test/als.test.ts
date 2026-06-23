// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { callContext, currentToolCallId } from "../src/als.js";

describe("callContext", () => {
  it("returns null outside any run() context", () => {
    expect(currentToolCallId()).toBeNull();
  });

  it("exposes tool_call_id inside run()", () => {
    let seen: string | null = null;
    callContext.run({ tool_call_id: "tlc_a" }, () => {
      seen = currentToolCallId();
    });
    expect(seen).toBe("tlc_a");
  });

  it("clears after run() exits", () => {
    callContext.run({ tool_call_id: "tlc_a" }, () => {
      // body runs
    });
    expect(currentToolCallId()).toBeNull();
  });

  it("isolates concurrent run() invocations", async () => {
    const results: Array<string | null> = [];
    await Promise.all([
      new Promise<void>((resolve) =>
        callContext.run({ tool_call_id: "tlc_one" }, async () => {
          await new Promise((r) => setTimeout(r, 5));
          results.push(currentToolCallId());
          resolve();
        }),
      ),
      new Promise<void>((resolve) =>
        callContext.run({ tool_call_id: "tlc_two" }, async () => {
          await new Promise((r) => setTimeout(r, 1));
          results.push(currentToolCallId());
          resolve();
        }),
      ),
    ]);
    expect(results.sort()).toEqual(["tlc_one", "tlc_two"]);
  });
});
