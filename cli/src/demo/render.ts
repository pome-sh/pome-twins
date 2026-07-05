// SPDX-License-Identifier: Apache-2.0
// FDRS-643 — pure terminal rendering for `pome demo`, matching the
// design-of-record (CLI moments.dc.html moment 01, task/code-model
// vocabulary):
//
//   [bordered reassurance box]
//   spinning up github twin … ready (1.2s)
//   running 5 isolated trials of first-run-demo …
//   trial 1  ✓  passed   14.3s
//   trial 3  ✗  failed   15.9s  <criterion failure note>
//   trial 5  ⚠  errored         <reason> — excluded
//   ─────
//   2 of 4 passed · 1 trial errored on <reason>, excluded from the fraction
//   <failing-criterion phrase> in 2 of 4 — start there
//   see the full breakdown — read-only, still no account:
//   → https://app.pome.sh/demo/<group_id>
//
// Demo verdicts are WORDS (passed/failed), never scores; errored rows show
// no duration and are EXCLUDED from the fraction's denominator.

export type TrialVerdict =
  | { kind: "passed"; seconds: number }
  | { kind: "failed"; seconds: number; note: string }
  | { kind: "errored"; reason: string };

/** Reassurance frame. "No signup. No API keys." is verbatim copy of record
 *  ([DECISION] #5); the third line names the three places honestly — local
 *  twin locally, model calls via the anonymous demo gateway, trace evaluated
 *  in pome cloud. */
export function reassuranceBox(): string[] {
  const lines = [
    "pome demo · running locally",
    "No signup. No API keys.",
    "The GitHub twin runs on your machine; model calls go through pome's",
    "anonymous demo gateway; the trace is evaluated in pome cloud.",
    "Your repo and your data are never touched.",
  ];
  const width = Math.max(...lines.map((line) => line.length));
  const top = `┌${"─".repeat(width + 2)}┐`;
  const bottom = `└${"─".repeat(width + 2)}┘`;
  return [top, ...lines.map((line) => `│ ${line.padEnd(width)} │`), bottom];
}

export function twinReadyLine(seconds: number): string {
  return `spinning up github twin … ready (${seconds.toFixed(1)}s)`;
}

export function trialsHeaderLine(count: number, taskName: string): string {
  return `running ${count} isolated trials of ${taskName} …`;
}

export function evaluatingLine(index: number): string {
  return `trial ${index}  …  evaluating in the cloud …`;
}

export function trialLine(index: number, verdict: TrialVerdict): string {
  switch (verdict.kind) {
    case "passed":
      return `trial ${index}  ✓  passed   ${formatSeconds(verdict.seconds)}`;
    case "failed":
      return `trial ${index}  ✗  failed   ${formatSeconds(verdict.seconds)}  ${verdict.note}`;
    case "errored":
      return `trial ${index}  ⚠  errored         ${verdict.reason} — excluded`;
  }
}

function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(1)}s`;
}

export interface SummaryInput {
  verdicts: TrialVerdict[];
  /** Most-common failed-criterion phrase across evaluated trials, if any. */
  failingCriterionPhrase?: string;
  /** How many evaluated trials failed that criterion. */
  failingCriterionCount?: number;
  previewUrl: string;
}

export function summaryLines(input: SummaryInput): string[] {
  const passed = input.verdicts.filter((v) => v.kind === "passed").length;
  const failed = input.verdicts.filter((v) => v.kind === "failed").length;
  const errored = input.verdicts.filter(
    (v): v is Extract<TrialVerdict, { kind: "errored" }> => v.kind === "errored",
  );
  const denominator = passed + failed;

  const lines: string[] = ["─────"];

  let fraction: string;
  if (denominator === 0) {
    fraction = "no trials were evaluated";
  } else {
    fraction = `${passed} of ${denominator} passed`;
  }
  if (errored.length > 0) {
    const reason = errored[0]!.reason;
    const noun = errored.length === 1 ? "trial" : "trials";
    fraction += ` · ${errored.length} ${noun} errored on ${reason}, excluded from the fraction`;
  }
  lines.push(fraction);

  if (
    input.failingCriterionPhrase &&
    typeof input.failingCriterionCount === "number" &&
    input.failingCriterionCount > 0 &&
    denominator > 0
  ) {
    lines.push(
      `${input.failingCriterionPhrase} in ${input.failingCriterionCount} of ${denominator} — start there`,
    );
  }

  if (denominator > 0) {
    lines.push("see the full breakdown — read-only, still no account:");
    lines.push(`→ ${input.previewUrl}`);
  }

  return lines;
}

/** Compress a criterion's text into the short "start there" phrase: first
 *  clause, lower-cased lead, ~60 chars. */
export function criterionPhrase(text: string): string {
  const clause = text.split(/[.;]/)[0]?.trim() ?? text.trim();
  const lowered = clause.length > 0 ? clause[0]!.toLowerCase() + clause.slice(1) : clause;
  return lowered.length > 64 ? `${lowered.slice(0, 61).trimEnd()}…` : lowered;
}
