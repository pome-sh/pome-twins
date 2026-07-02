// SPDX-License-Identifier: Apache-2.0
// FDRS-634 — terminal rendering for the doctor report, per
// `CLI moments.dc.html` moment 03: one line per executed check, then (on
// failure) exactly one cause/fix card and the two closing warning lines.
// Plain text, no color deps — matches the rest of the CLI's output.

import type { DoctorReport } from "./checks.js";

const CAUSE_COLUMN = "cause  ";
const FIX_COLUMN = "fix    ";
const CONTINUATION = " ".repeat(FIX_COLUMN.length);

export function renderDoctorReport(report: DoctorReport): string[] {
  const lines: string[] = ["checking your wiring …"];

  for (const check of report.checks) {
    const glyph = check.status === "pass" ? "✓" : "✗";
    const detail = check.detail ? `  ${check.detail}` : "";
    lines.push(`${glyph} ${check.label}${detail}`);
  }

  const failed = report.checks.find((c) => c.status === "fail");
  if (failed) {
    lines.push("");
    if (failed.cause) lines.push(`${CAUSE_COLUMN}${failed.cause}`);
    if (failed.fix) {
      const [first, ...rest] = failed.fix.split("\n");
      lines.push(`${FIX_COLUMN}${first ?? ""}`);
      for (const line of rest) lines.push(`${CONTINUATION}${line}`);
    }
    lines.push("");
    lines.push("until this passes, your agent would hit production.");
    lines.push("pome will not run trials against a live API.");
  }

  return lines;
}
