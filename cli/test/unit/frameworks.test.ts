import { describe, expect, it } from "vitest";

import { KNOWN_FRAMEWORKS, suggestFramework } from "../../src/cli/frameworks.js";

describe("suggestFramework", () => {
  it("accepts a known framework (case-insensitive)", () => {
    expect(suggestFramework("langgraph")).toEqual({ known: true });
    expect(suggestFramework("LangGraph")).toEqual({ known: true });
    expect(suggestFramework("claude-agent-sdk")).toEqual({ known: true });
  });

  it("suggests the nearest known framework for a close typo", () => {
    expect(suggestFramework("langraph")).toEqual({ known: false, suggestion: "langgraph" });
    expect(suggestFramework("openai-agent")).toEqual({ known: false, suggestion: "openai-agents" });
  });

  it("returns no suggestion for something far from every known framework", () => {
    expect(suggestFramework("totally-made-up-xyz")).toEqual({ known: false });
  });

  it("exposes the known set as a non-empty list", () => {
    expect(KNOWN_FRAMEWORKS.length).toBeGreaterThan(0);
    expect(KNOWN_FRAMEWORKS).toContain("langgraph");
  });
});
