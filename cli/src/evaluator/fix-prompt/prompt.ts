// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RecorderEvent } from "../../types/shared.js";
import type { CriterionResult } from "../score.js";
import type { Scenario } from "../../scenario/scenarioSchema.js";

export const FIX_PROMPT_TEMPLATE_VERSION = "v1";

const MAX_EVENTS = 50;
const BODY_CHAR_LIMIT = 800;

function loadSystemPrompt(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Source layout: src/evaluator/fix-prompt/prompts/fix-prompt-v1.md
  // Compiled layout (tsc): dist/src/evaluator/fix-prompt/prompts/fix-prompt-v1.md
  // tsconfig.build.json must copy the prompts/ folder; assert presence here.
  const path = join(here, "prompts", `fix-prompt-${FIX_PROMPT_TEMPLATE_VERSION}.md`);
  return readFileSync(path, "utf8");
}

export const FIX_PROMPT_SYSTEM_PROMPT = loadSystemPrompt();

export function escapeTagContent(text: string): string {
  return text.replace(/[&<>]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      default:
        return char;
    }
  });
}

export interface FixPromptContext {
  events: RecorderEvent[];
  criteriaResults: CriterionResult[];
  scenario: Scenario;
}

function truncateBody(body: unknown): unknown {
  if (body === undefined || body === null) return body;
  let serialized: string;
  try {
    serialized = JSON.stringify(body);
  } catch {
    return "[unserializable]";
  }
  if (serialized.length <= BODY_CHAR_LIMIT) return body;
  return `${serialized.slice(0, BODY_CHAR_LIMIT)}…`;
}

function renderEvent(e: RecorderEvent): string {
  return JSON.stringify({
    twin: e.twin,
    method: e.method,
    path: e.path,
    status: e.status,
    latency_ms: e.latency_ms,
    step_id: e.step_id,
    request_body: truncateBody(e.request_body),
    response_body: truncateBody(e.response_body),
    state_delta: e.state_delta,
  });
}

function renderEvents(events: RecorderEvent[]): string {
  const kept = events.slice(0, MAX_EVENTS);
  const lines = kept.map(renderEvent);
  if (events.length > MAX_EVENTS) {
    lines.push(`(${events.length - MAX_EVENTS} more omitted — kept first ${MAX_EVENTS})`);
  }
  return lines.join("\n");
}

function renderFailedCriteria(results: CriterionResult[]): string {
  const failed = results.filter((r) => !r.passed && !r.skipped);
  if (failed.length === 0) return "(no failed criteria)";
  return failed
    .map((r, idx) => {
      const conf =
        typeof r.confidence === "number"
          ? ` (judge confidence ${r.confidence.toFixed(2)})`
          : "";
      return `${idx + 1}. [${r.criterion.type}] ${r.criterion.text}\n   reason: ${r.reason}${conf}`;
    })
    .join("\n");
}

export function buildFixUserPrompt(ctx: FixPromptContext): string {
  const failures = renderFailedCriteria(ctx.criteriaResults);
  const trace = renderEvents(ctx.events);

  return `## Scenario
${ctx.scenario.title}

## Scenario prompt (what the agent was told to do)
${ctx.scenario.prompt}

## Failed criteria
${escapeTagContent(failures)}

## Trace (HTTP calls the agent made)
<agent-trace>
${escapeTagContent(trace)}
</agent-trace>`;
}
