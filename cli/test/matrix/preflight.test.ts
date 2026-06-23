// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the provider-key preflight. Pure over an injected env map.
import { describe, expect, it } from "vitest";
import {
  preflightFleet,
  providerKeyForModel,
} from "../../src/matrix/preflight.js";
import type { AgentEntry } from "../../src/matrix/agentsConfig.js";

describe("providerKeyForModel", () => {
  it("maps model prefixes to the right env var", () => {
    expect(providerKeyForModel("claude-opus-4-8")?.env).toBe("ANTHROPIC_API_KEY");
    expect(providerKeyForModel("anthropic/claude-x")?.env).toBe("ANTHROPIC_API_KEY");
    expect(providerKeyForModel("openai/gpt-5")?.env).toBe("OPENAI_API_KEY");
    expect(providerKeyForModel("openrouter/qwen-3-235b")?.env).toBe("OPENROUTER_API_KEY");
    expect(providerKeyForModel("google/gemini-2.5-pro")?.env).toBe("GOOGLE_API_KEY");
    expect(providerKeyForModel("gemini-2.5-pro")?.env).toBe("GOOGLE_API_KEY");
  });

  it("returns null for an unknown provider prefix", () => {
    expect(providerKeyForModel("mystery/model-9")).toBeNull();
  });
});

describe("preflightFleet", () => {
  const sdk: AgentEntry = {
    id: "opus/sdk",
    scaffold: "claude-agent-sdk",
    model: "claude-opus-4-8",
  };
  const loop: AgentEntry = {
    id: "gpt-5/loop",
    scaffold: "mcp-loop",
    model: "openai/gpt-5",
  };
  const scripted: AgentEntry = {
    id: "scripted",
    scaffold: "command",
    command: "echo x",
  };

  it("collects distinct required keys and flags the missing ones", () => {
    const pf = preflightFleet([sdk, loop], { OPENAI_API_KEY: "sk-x" });
    expect(pf.requiredKeys.map((k) => k.env).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
    ]);
    expect(pf.ok).toBe(false);
    expect(pf.missing.map((k) => k.env)).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("passes when every required key is present", () => {
    const pf = preflightFleet([sdk, loop], {
      ANTHROPIC_API_KEY: "sk-a",
      OPENAI_API_KEY: "sk-o",
    });
    expect(pf.ok).toBe(true);
    expect(pf.missing).toEqual([]);
  });

  it("a keyless command fleet requires no keys", () => {
    const pf = preflightFleet([scripted], {});
    expect(pf.ok).toBe(true);
    expect(pf.requiredKeys).toEqual([]);
  });

  it("treats an empty-string key as missing", () => {
    const pf = preflightFleet([loop], { OPENAI_API_KEY: "   " });
    expect(pf.ok).toBe(false);
  });
});
