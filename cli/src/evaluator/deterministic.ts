// SPDX-License-Identifier: Apache-2.0
import type { Scenario } from "../scenario/scenarioSchema.js";
import type { RecorderEvent as LegacyRecorderEvent } from "../twin/github/types.js";
import type { RecorderEvent } from "../types/shared.js";
import { scoreResults, type CriterionResult, type Score } from "./score.js";
import { evaluateProbabilistic } from "./probabilistic/index.js";
import { createTwinPluginRegistry } from "./twin-plugins/index.js";
import { githubPlugin } from "./twin-plugins/github.js";
import { stripePlugin } from "./twin-plugins/stripe.js";
import { slackPlugin } from "./twin-plugins/slack.js";

const registry = createTwinPluginRegistry();
registry.register(githubPlugin);
registry.register(stripePlugin);
registry.register(slackPlugin);

// The agent's run prints a single JSON object to stdout whose `summary` field
// is its final natural-language answer to the operator. The [P] judge needs
// that summary to grade recognition/decision criteria (otherwise it only sees
// state + tool calls and fails any agent that explained-but-did-not-act).
// Robust to noise: try the whole stdout as JSON, else scan lines from the end
// for the last JSON object carrying a string `summary`.
export function extractAgentSummary(stdout: string): string | undefined {
  const trimmed = stdout?.trim();
  if (!trimmed) return undefined;
  const fromCandidate = (text: string): string | undefined => {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && typeof (parsed as { summary?: unknown }).summary === "string") {
        return (parsed as { summary: string }).summary;
      }
    } catch {
      /* not JSON */
    }
    return undefined;
  };
  const whole = fromCandidate(trimmed);
  if (whole !== undefined) return whole;
  const lines = trimmed.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    const found = fromCandidate(line);
    if (found !== undefined) return found;
  }
  return undefined;
}

export async function evaluateScenario(input: {
  scenario: Scenario;
  initialState: unknown;
  finalState: unknown;
  events: LegacyRecorderEvent[];
  stdout: string;
}): Promise<Score> {
  // Boundary widening: callers still hand us the legacy GitHub-only
  // RecorderEvent shape, but plugins consume the twin-agnostic
  // shared-types RecorderEvent. Fields plugins actually read
  // (method/path/status/response_body/fidelity) exist on both.
  const events = input.events as unknown as RecorderEvent[];
  const twinId = input.scenario.config.twins[0] ?? "github";
  const agentSummary = extractAgentSummary(input.stdout);

  const results: CriterionResult[] = [];

  for (const criterion of input.scenario.criteria) {
    if (criterion.type === "P") {
      const result = await evaluateProbabilistic(criterion, {
        toolCallCount: events.length,
        stateBefore: input.initialState,
        stateAfter: input.finalState,
        agentSummary,
        events: events.map((e) => ({
          method: e.method,
          path: e.path,
          status: e.status,
          latency_ms: e.latency_ms,
          request_body: e.request_body,
          response_body: e.response_body,
        })),
      });
      results.push(result);
    } else {
      results.push(
        registry.dispatch({
          twinId,
          criterion,
          initialState: input.initialState,
          finalState: input.finalState,
          events,
        }),
      );
    }
  }

  return scoreResults(results);
}
