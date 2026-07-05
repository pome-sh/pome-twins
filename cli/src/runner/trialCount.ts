// SPDX-License-Identifier: Apache-2.0
// FDRS-636 — trial-count resolution for `pome run -n k`.
//
// [DECISION 2026-07-05]: -n is an integer 1..20 on the hosted run path. The
// DEFAULT is the scenario config's `runs` field (scenarioConfigSchema parses
// it, defaulting 1; nothing consumed it before this ticket) — -n overrides;
// both are capped at 20. k=1 keeps EXACTLY today's single-run behavior (no
// group is ever stamped — a group of 1 would flip the reliability page off
// its implicit latest-k fallback and regress the view).

import { HostedUsageError } from "../hosted/errors.js";

/** Hard cap on trials per group — matches the reliability read's bound. */
export const MAX_TRIALS = 20;

/** Parse the raw `-n` flag value. Throws HostedUsageError (documented
 *  exit 5) on anything but an integer 1..MAX_TRIALS. */
export function parseTrialsFlag(raw: string): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new HostedUsageError(
      `Invalid -n "${raw}" (expected an integer 1-${MAX_TRIALS}).`,
    );
  }
  const n = Number.parseInt(trimmed, 10);
  if (n < 1 || n > MAX_TRIALS) {
    throw new HostedUsageError(
      `Invalid -n "${raw}" (expected an integer 1-${MAX_TRIALS}).`,
    );
  }
  return n;
}

/** Effective k for one scenario: the validated -n flag when present,
 *  otherwise the scenario config's `runs` field capped at MAX_TRIALS. */
export function effectiveTrialCount(
  flagValue: number | undefined,
  configRuns: number,
): number {
  if (flagValue !== undefined) return flagValue;
  return Math.min(Math.max(1, Math.trunc(configRuns)), MAX_TRIALS);
}
