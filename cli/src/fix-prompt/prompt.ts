// SPDX-License-Identifier: Apache-2.0
//
// Assembles the paste-into-IDE fix prompt for a failed run (FDRS-657).
//
// CAPTURE-ONLY: the OSS CLI does NOT call an LLM here. `pome fix-prompt`
// assembles a self-contained prompt — system instructions + the scenario's
// criteria + the raw captured trace — and prints it so the developer can paste
// it into THEIR own coding assistant (Cursor / Claude Code). The former BYOK
// local-judge call that generated the handoff CLI-side was removed under
// FDRS-657 (no local LLM/judge anywhere in the OSS CLI). This module was also
// relocated out of the deleted `src/evaluator/` tree.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RecorderEvent } from "../types/shared.js";
import type { Criterion, Scenario } from "../scenario/scenarioSchema.js";
import { redactEvent, redactSecrets } from "../recorder/redaction.js";

export const FIX_PROMPT_TEMPLATE_VERSION = "v1";

const MAX_EVENTS = 50;
const BODY_CHAR_LIMIT = 800;

function loadSystemPrompt(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Source layout:   src/fix-prompt/prompts/fix-prompt-v1.md
  // Compiled layout: dist/src/fix-prompt/prompts/fix-prompt-v1.md
  // tsconfig.build.json (via scripts/copy-prompts.mjs) copies the prompts/
  // folder; assert presence here.
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

// The OSS CLI holds NO local verdict (evaluation is cloud-only), so the prompt
// lists every criterion the run had to satisfy and lets the developer's own
// assistant diagnose against the trace. No pass/fail is claimed here.
function renderCriteria(criteria: Criterion[]): string {
  if (criteria.length === 0) return "(no criteria declared)";
  return criteria
    .map((c, idx) => `${idx + 1}. [${c.type}] ${c.text}`)
    .join("\n");
}

export function buildFixUserPrompt(ctx: FixPromptContext): string {
  const criteria = redactSecrets(renderCriteria(ctx.scenario.criteria)) as string;
  const trace = renderEvents(ctx.events.map((event) => redactEvent(event)));
  const scenarioTitle = redactSecrets(ctx.scenario.title) as string;
  const scenarioPrompt = redactSecrets(ctx.scenario.prompt) as string;

  return `## Scenario
${scenarioTitle}

## Scenario prompt (what the agent was told to do)
${scenarioPrompt}

## Criteria the run had to satisfy
${escapeTagContent(criteria)}

## Trace (HTTP calls the agent made)
<agent-trace>
${escapeTagContent(trace)}
</agent-trace>`;
}
