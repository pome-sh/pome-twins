// SPDX-License-Identifier: Apache-2.0
// FDRS-657 — `pome fix-prompt` is CAPTURE-ONLY: it assembles a paste-into-IDE
// prompt from the raw trace + the scenario's criteria, with NO LLM/judge call
// and NO network. This test asserts the prompt content and that no fetch is
// attempted.

import { describe, it, expect, vi } from "vitest";
import { buildFixPrompt, buildFixUserPrompt } from "../../src/fix-prompt/index.js";
import type { RecorderEvent } from "../../src/types/shared.js";
import type { Scenario } from "../../src/scenario/scenarioSchema.js";

const scenario: Scenario = {
  slug: "01-bug-happy-path",
  title: "Bug happy path",
  setup: "",
  prompt: "Triage the incoming bug and label it.",
  expectedBehavior: "The agent labels the issue as a bug.",
  criteria: [
    { type: "D", text: "The issue is labeled `bug`" },
    { type: "P", text: "The agent left a helpful triage comment" },
  ],
  config: { twins: ["github"], timeout: 60, runs: 1, passThreshold: 100 },
  seedState: {} as Scenario["seedState"],
};

const events = [
  {
    twin: "github",
    method: "POST",
    path: "/repos/acme/api/issues/1/labels",
    status: 200,
    latency_ms: 12,
    request_body: { labels: ["bug"] },
    response_body: null,
    state_delta: null,
  },
] as unknown as RecorderEvent[];

describe("fix-prompt (capture-only)", () => {
  it("builds a prompt from the trace + all scenario criteria, no network", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const out = buildFixPrompt({ events, scenario });

    // System instructions are prepended.
    expect(out).toContain("You are a senior engineer");
    // The scenario prompt + every criterion are included (no verdict needed).
    expect(out).toContain("Triage the incoming bug and label it.");
    expect(out).toContain("[D] The issue is labeled `bug`");
    expect(out).toContain("[P] The agent left a helpful triage comment");
    // The captured trace is embedded inside the agent-trace fence.
    expect(out).toContain("<agent-trace>");
    expect(out).toContain("/repos/acme/api/issues/1/labels");
    // Absolutely no LLM/judge call.
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("lists criteria as 'had to satisfy', not a local pass/fail verdict", () => {
    const user = buildFixUserPrompt({ events, scenario });
    expect(user).toContain("## Criteria the run had to satisfy");
    expect(user).not.toMatch(/\bpassed\b|\bfailed\b|judge confidence/);
  });
});
