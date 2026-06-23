// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { generateToolCallId } from "../src/ids.js";

describe("generateToolCallId", () => {
  it("has the tlc_ prefix", () => {
    expect(generateToolCallId()).toMatch(/^tlc_/);
  });

  it("returns a distinct value on each call", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(generateToolCallId());
    expect(ids.size).toBe(1000);
  });

  it("has stable shape: tlc_<lowercase-hex>, length >= 12 total", () => {
    for (let i = 0; i < 50; i++) {
      const id = generateToolCallId();
      expect(id).toMatch(/^tlc_[a-f0-9]+$/);
      expect(id.length).toBeGreaterThanOrEqual(12);
    }
  });
});
