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
import type { CriterionResult, RecorderEvent } from "../types/shared.js";
import type { Criterion, Scenario } from "../scenario/scenarioSchema.js";
import { redactEvent, redactSecrets } from "../recorder/redaction.js";
import { outcomeOf } from "../hosted/evalResultView.js";
import type { VerdictArtifact } from "../hosted/evalResultCache.js";

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

  return `## Task
${scenarioTitle}

## Task prompt (what the agent was told to do)
${scenarioPrompt}

## Criteria the run had to satisfy
${escapeTagContent(criteria)}

## Trace (HTTP calls the agent made)
<agent-trace>
${escapeTagContent(trace)}
</agent-trace>`;
}

// ── FDRS-644: run-set mode ──────────────────────────────────────────────
//
// One prompt for a whole trial group, built from persisted CLOUD verdicts
// (verdict.json — provenance-labeled /finalize payloads, still no local
// scoring) + the raw traces. The judge's per-criterion reasons become
// GROUPED failure signatures; one representative trace keeps the prompt
// bounded (the others are named by path for the developer's own digging).

export interface TrialFixInput {
  /** Terminal-facing label, e.g. "trial 2 · ses_abc123". */
  label: string;
  /** The trial's artifacts dir (for naming non-representative traces). */
  runDir: string;
  verdict: VerdictArtifact;
  events: RecorderEvent[];
}

export interface GroupFixPromptContext {
  taskName: string;
  groupId: string | null;
  /** Parsed task file when it still resolves. Null degrades the prompt to
   *  the verdict-embedded criteria (the file may have moved since the run). */
  scenario: Scenario | null;
  /** Completed trials of the run set (verdict.json present), run order. */
  trials: TrialFixInput[];
}

function criterionMarker(c: CriterionResult["criterion"]): string {
  return `[${c.type}]`;
}

function failedResults(verdict: VerdictArtifact): CriterionResult[] {
  return verdict.criteria_results.filter((r) => outcomeOf(r) === "failed");
}

/** Judge reasons and criterion text are DATA rendered into prompt prose —
 *  flatten to one line so a crafted (or just verbose) string can never open
 *  a new markdown heading/section inside the prompt structure. */
function flattenLine(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Per-criterion failure signatures across the run set: criterion text →
 *  which trials failed it and what the judge said, failing-first. Criteria
 *  that never failed split honestly: "passed everywhere" requires every
 *  outcome to actually be `passed` — skipped/errored are named as such,
 *  never counted as passes. */
function renderGroupedSignatures(trials: TrialFixInput[]): string {
  const byCriterion = new Map<
    string,
    { marker: string; hits: Array<{ label: string; reason: string }> }
  >();
  // Criterion text → the set of non-failed outcomes seen for it.
  const outcomesSeen = new Map<string, Set<string>>();
  for (const trial of trials) {
    for (const result of trial.verdict.criteria_results) {
      const key = result.criterion.text;
      const outcome = outcomeOf(result);
      if (outcome === "failed") {
        const entry = byCriterion.get(key) ?? {
          marker: criterionMarker(result.criterion),
          hits: [],
        };
        entry.hits.push({ label: trial.label, reason: result.reason });
        byCriterion.set(key, entry);
      }
      const seen = outcomesSeen.get(key) ?? new Set<string>();
      seen.add(outcome);
      outcomesSeen.set(key, seen);
    }
  }

  const passedEverywhere: string[] = [];
  const notUniformlyEvaluated: string[] = [];
  for (const [key, seen] of outcomesSeen) {
    if (byCriterion.has(key)) continue;
    if (seen.size === 1 && seen.has("passed")) passedEverywhere.push(key);
    else notUniformlyEvaluated.push(key);
  }

  const completed = trials.length;
  const blocks = [...byCriterion.entries()]
    .sort((a, b) => b[1].hits.length - a[1].hits.length)
    .map(([text, { marker, hits }], idx) => {
      const lines = hits.map(
        (h) => `   - ${h.label}: ${flattenLine(h.reason)}`,
      );
      return `${idx + 1}. ${marker} ${flattenLine(text)} — failed in ${hits.length} of ${completed} completed trials\n${lines.join("\n")}`;
    });
  if (blocks.length === 0 && passedEverywhere.length === 0 && notUniformlyEvaluated.length === 0) {
    return "(no criteria recorded)";
  }
  const notes: string[] = [];
  if (blocks.length === 0) {
    notes.push("(no criterion failed in any completed trial)");
  }
  if (passedEverywhere.length > 0) {
    notes.push(
      `passed in every completed trial: ${passedEverywhere.map((t) => `"${flattenLine(t)}"`).join(" · ")}`,
    );
  }
  if (notUniformlyEvaluated.length > 0) {
    notes.push(
      `not uniformly evaluated (skipped or errored in some trials — no pass is claimed for these): ${notUniformlyEvaluated.map((t) => `"${flattenLine(t)}"`).join(" · ")}`,
    );
  }
  return [...blocks, ...notes].join("\n");
}

/** The failing trial with the most failed criteria — the representative
 *  whose full trace anchors the prompt. */
export function representativeFailingTrial(
  trials: TrialFixInput[],
): TrialFixInput | null {
  const failing = trials.filter((t) => !t.verdict.passed);
  if (failing.length === 0) return null;
  return failing.reduce((worst, t) =>
    failedResults(t.verdict).length > failedResults(worst.verdict).length
      ? t
      : worst,
  );
}

export function buildGroupFixUserPrompt(ctx: GroupFixPromptContext): string {
  const completed = ctx.trials.length;
  const passed = ctx.trials.filter((t) => t.verdict.passed).length;
  const representative = representativeFailingTrial(ctx.trials);
  const otherFailing = ctx.trials.filter(
    (t) => !t.verdict.passed && t !== representative,
  );

  const signatures = redactSecrets(
    renderGroupedSignatures(ctx.trials),
  ) as string;
  const criteriaBlock = ctx.scenario
    ? (redactSecrets(renderCriteria(ctx.scenario.criteria)) as string)
    : (redactSecrets(
        renderCriteria(
          (ctx.trials[0]?.verdict.criteria_results ?? []).map((r) => ({
            type: r.criterion.type,
            text: r.criterion.text,
          })) as Criterion[],
        ),
      ) as string);
  const promptBlock = ctx.scenario
    ? (redactSecrets(ctx.scenario.prompt) as string)
    : `(task file not found at ${ctx.trials[0]?.verdict.scenario_path ?? "?"} — criteria above come from the cloud verdicts)`;

  const sections: string[] = [];
  sections.push(`## Run set (cloud-judged)
task ${redactSecrets(ctx.taskName) as string} · ${
    ctx.groupId ? `group ${ctx.groupId}` : "single run"
  } · ${passed} of ${completed} completed trials passed`);

  sections.push(`## Grouped failure signatures (from the cloud judge)
${escapeTagContent(signatures)}`);

  sections.push(`## Task prompt (what the agent was told to do)
${promptBlock}`);

  sections.push(`## Criteria the run had to satisfy
${escapeTagContent(criteriaBlock)}`);

  if (representative) {
    const trace = renderEvents(
      representative.events.map((event) => redactEvent(event)),
    );
    sections.push(`## Trace of the most-failing trial (${representative.label})
<agent-trace>
${escapeTagContent(trace)}
</agent-trace>`);
  }

  if (otherFailing.length > 0) {
    const lines = otherFailing.map((t) => {
      const failed = failedResults(t.verdict)
        .map((r) => criterionPhraseSafe(r.criterion.text))
        .join(" · ");
      return `- ${t.label} — failed: ${failed || "(see verdict)"} — trace at ${join(t.runDir, "events.jsonl")}`;
    });
    sections.push(`## Other failing trials (traces on disk)
${escapeTagContent(redactSecrets(lines.join("\n")) as string)}`);
  }

  if (passed > 0 && passed < completed) {
    sections.push(`## Variance note
${passed} of ${completed} completed trials passed the same criteria — the failure is variance, not a hard wall. Prefer fixes that remove the variance source (ambiguous instructions, missing determinism) over pattern-matching to one trace.`);
  }

  return sections.join("\n\n");
}

/** Short criterion phrase without pulling in the demo renderer's styling. */
function criterionPhraseSafe(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
}
