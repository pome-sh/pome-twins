// SPDX-License-Identifier: Apache-2.0
// FDRS-636 — pure terminal rendering for `pome run -n k` trial groups,
// matching the design-of-record (CLI moments.dc.html moment 04,
// task/code-model vocabulary):
//
//   -n sets how many isolated trials to run · the agent command comes from pome.json
//   provisioning 5 isolated github twins … ready
//   spawning agent <cmd> · from pome.json …
//   trial 1  ✓  100      14.3s
//   trial 2  ✓  96       12.1s
//   trial 3  ✗  58       15.9s  <failing criteria summary>
//   trial 5  ⚠  errored         <reason> — excluded
//   ─────
//   2 of 4 passed · 1 errored, excluded from the fraction
//   <failing-criterion phrase> failed in 2 of 4 — start there
//   full trace, per-criterion diffs, and the trial spread:
//   → <reliability page url>
//
// Trial verdicts are NUMERIC SCORES from the cloud judge — never words (that
// vocabulary belongs to `pome demo`, moment 01). Errored rows show no
// duration and are EXCLUDED from the fraction's denominator.

import { criterionPhrase } from "../demo/render.js";

export type TrialRow =
  | {
      kind: "completed";
      /** Cloud-authoritative satisfaction score, 0-100. */
      score: number;
      /** Cleared the scenario's pass threshold. */
      passed: boolean;
      seconds: number;
      /** Failing-criteria summary ("a · b"), absent when none were reported. */
      note?: string;
    }
  | { kind: "errored"; reason: string };

/** The muted hint under the command echo, naming where the agent command
 *  came from (pome.json / --agent / the built-in default). */
export function flagHintLine(agentCommandSource: string): string {
  return `-n sets how many isolated trials to run · the agent command comes from ${agentCommandSource}`;
}

/** Printed once the upfront mints are done (the cloud provisions one
 *  isolated twin sandbox per session — ADR-012). FDRS-663: when the plan's
 *  concurrent-twin quota bounded the upfront mint below k, the bound is
 *  named honestly — k stays the design default, the wall-clock stretches. */
export function provisioningLine(
  k: number,
  twins: string[],
  bound?: number,
): string {
  if (bound !== undefined && bound < k) {
    return `provisioning ${bound} isolated ${twins.join("+")} twins … ready (plan concurrency ${bound} — ${k} trials reuse slots as they finish)`;
  }
  return `provisioning ${k} isolated ${twins.join("+")} twins … ready`;
}

export function spawningAgentLine(command: string, source: string): string {
  return `spawning agent ${command} · from ${source} …`;
}

// Column layout (moment 04): score field padded to 9 so durations align;
// "errored" padded to the duration column (16) so reasons align with the
// failing-criteria notes.
export function trialRowLine(n: number, row: TrialRow): string {
  if (row.kind === "errored") {
    return `trial ${n}  ⚠  ${"errored".padEnd(16)}${row.reason} — excluded`;
  }
  const mark = row.passed ? "✓" : "✗";
  const base = `trial ${n}  ${mark}  ${String(row.score).padEnd(9)}${row.seconds.toFixed(1)}s`;
  return row.note ? `${base}  ${row.note}` : base;
}

export interface GroupSummaryInput {
  rows: TrialRow[];
  /** Most-common failed-criterion phrase across completed trials, if any. */
  failingCriterionPhrase?: string;
  /** How many completed trials failed that criterion. */
  failingCriterionCount?: number;
  /** The task's reliability page (dashboard /runs/task/<taskName>). */
  reliabilityUrl: string;
}

export function groupSummaryLines(input: GroupSummaryInput): string[] {
  const completed = input.rows.filter(
    (r): r is Extract<TrialRow, { kind: "completed" }> => r.kind === "completed",
  );
  const passed = completed.filter((r) => r.passed).length;
  const errored = input.rows.length - completed.length;

  const lines: string[] = ["─────"];

  // The fraction counts COMPLETED trials only; errored trials are named and
  // excluded, never silently folded into the denominator.
  let fraction =
    completed.length === 0
      ? "no trials completed"
      : `${passed} of ${completed.length} passed`;
  if (errored > 0) {
    fraction += ` · ${errored} errored, excluded from the fraction`;
  }
  lines.push(fraction);

  if (
    input.failingCriterionPhrase &&
    typeof input.failingCriterionCount === "number" &&
    input.failingCriterionCount > 0 &&
    completed.length > 0
  ) {
    lines.push(
      `${input.failingCriterionPhrase} failed in ${input.failingCriterionCount} of ${completed.length} — start there`,
    );
  }

  // The dashboard handoff only makes sense when at least one run row exists.
  if (completed.length > 0) {
    lines.push("");
    lines.push("full trace, per-criterion diffs, and the trial spread:");
    lines.push(`→ ${input.reliabilityUrl}`);
  }

  return lines;
}

/** [DECISION 2026-07-05] group exit code: 0 iff at least one trial completed
 *  AND every completed trial passed; 1 when a completed trial failed; 2 when
 *  nothing completed. Documented next to the k=1 mapping in
 *  src/hosted/errors.ts. */
export function groupExitCode(rows: TrialRow[]): number {
  const completed = rows.filter(
    (r): r is Extract<TrialRow, { kind: "completed" }> => r.kind === "completed",
  );
  if (completed.length === 0) return 2;
  return completed.every((r) => r.passed) ? 0 : 1;
}

/** Modal failed-criterion text across the group's completed trials, as the
 *  short phrase the "start there" line renders. */
export function mostCommonFailedCriterion(
  failures: string[],
): { phrase: string; count: number } | null {
  if (failures.length === 0) return null;
  const counts = new Map<string, number>();
  for (const text of failures) {
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  const [text, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  return { phrase: criterionPhrase(text), count };
}

/** Flatten an errored trial's reason to one short row-friendly line. */
export function shortReason(reason: string): string {
  const flat = reason.replace(/\s+/g, " ").trim();
  return flat.length > 72 ? `${flat.slice(0, 69)}…` : flat;
}

/** FDRS-644 — the fix & green handoff, printed under the group summary when
 *  at least one COMPLETED trial failed (errored trials are sandbox noise —
 *  the answer there is re-run, not a code fix). Copy stays modest per the
 *  north-star honesty note ("don't sell a 5-trial bump as proof"): a
 *  greener set is a signal, the climb across re-runs is what to watch. */
export function fixHandoffLines(input: {
  fixPromptCommand: string;
  rerunCommand: string;
}): string[] {
  return [
    "",
    "fix & green: hand the failure signatures to your coding agent —",
    `  ${input.fixPromptCommand}`,
    `after the fix lands, re-run the task:  ${input.rerunCommand}`,
    "fresh trials, honestly counted — one greener set is a signal, not proof; the reliability page tracks the climb.",
  ];
}
