// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the eval/agents.yaml zod schema + parser (no filesystem — the
// parse path is exercised directly off YAML strings).
import { describe, expect, it } from "vitest";
import { parseAgentsConfig } from "../../src/matrix/agentsConfig.js";

describe("parseAgentsConfig — happy paths", () => {
  it("parses a two-agent fleet with prompts and named prompt refs", () => {
    const cfg = parseAgentsConfig(`
prompts:
  default: eval/prompts/default.md
agents:
  - id: opus/sdk/default
    scaffold: claude-agent-sdk
    model: claude-opus-4-8
    prompt: default
  - id: gpt-5/loop/default
    scaffold: mcp-loop
    model: openai/gpt-5
    prompt: default
`);
    expect(cfg.agents).toHaveLength(2);
    expect(cfg.agents[0]!.scaffold).toBe("claude-agent-sdk");
    expect(cfg.prompts.default).toBe("eval/prompts/default.md");
  });

  it("parses a keyless scaffold:command fleet (no model/prompt)", () => {
    const cfg = parseAgentsConfig(`
agents:
  - id: scripted/github
    scaffold: command
    command: npx tsx examples/agents/scripted-triage-agent.ts
`);
    expect(cfg.agents[0]!.command).toContain("scripted-triage");
    // prompts defaults to {}
    expect(cfg.prompts).toEqual({});
  });
});

describe("parseAgentsConfig — error paths (superRefine)", () => {
  it("rejects duplicate agent ids", () => {
    expect(() =>
      parseAgentsConfig(`
agents:
  - id: dup
    scaffold: command
    command: echo a
  - id: dup
    scaffold: command
    command: echo b
`),
    ).toThrow(/duplicate agent id: dup/);
  });

  it("rejects scaffold:command without a command", () => {
    expect(() =>
      parseAgentsConfig(`
agents:
  - id: bad
    scaffold: command
`),
    ).toThrow(/requires command/);
  });

  it("rejects a model-bearing scaffold without a model", () => {
    expect(() =>
      parseAgentsConfig(`
agents:
  - id: bad
    scaffold: mcp-loop
`),
    ).toThrow(/requires model/);
  });

  it("rejects a prompt ref that is not in the prompts map", () => {
    expect(() =>
      parseAgentsConfig(`
prompts:
  default: eval/prompts/default.md
agents:
  - id: bad
    scaffold: mcp-loop
    model: openai/gpt-5
    prompt: missing
`),
    ).toThrow(/prompt .*missing.* not in prompts map/);
  });

  it("rejects an unknown scaffold value", () => {
    expect(() =>
      parseAgentsConfig(`
agents:
  - id: bad
    scaffold: not-a-scaffold
    command: echo x
`),
    ).toThrow();
  });

  it("rejects an empty agents list", () => {
    expect(() => parseAgentsConfig(`agents: []`)).toThrow();
  });

  it("rejects unknown top-level keys (strict)", () => {
    expect(() =>
      parseAgentsConfig(`
agents:
  - id: a
    scaffold: command
    command: echo x
unexpected: true
`),
    ).toThrow();
  });
});
