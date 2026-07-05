// SPDX-License-Identifier: Apache-2.0
// Cloud → CLI exit-code mapping per docs/05-api-spec.md §1 "pome run".
//   0 — pass; 1 — below pass-threshold; 2 — twin/orch error;
//   3 — auth (401/403); 4 — quota (402/429); 5 — usage error.
//
// Session A (Linear FDRS-423) audit confirmed cloud-side responses map
// cleanly: 401 only from `lib/auth.ts` (CLI exit 3), 402/429 = quota (CLI
// exit 4), 502 = downstream/gateway (CLI exit 2), 410/426 are not auth
// errors (CLI exit 2). F0-5 covers the CLI-side mapping gaps the test
// plan walkthrough surfaced:
//   - F0-5a: `pome run /does/not/exist.md` was returning exit 2 instead
//     of 5 because file-not-found threw a plain Error.
//   - F0-5c: `pome logout && pome run` was returning exit 2 instead of 3
//     because credential-resolution failure threw a plain Error.
//   - F18: hosted sub-threshold runs sometimes returned exit 3 because
//     `runScenarioHosted.ts` mapped any non-zero agent exit to exit 3,
//     stealing the auth slot.
//
// FDRS-636 — trial groups (`pome run -n k`, k>1) map the WHOLE GROUP to one
// exit code ([DECISION 2026-07-05]):
//   0 — at least one trial completed AND every completed trial passed;
//   1 — at least one completed trial failed its pass threshold;
//   2 — no trial completed (every trial errored/was abandoned).
// Errored trials are excluded from the verdict fraction and never lower a
// passing group below 0 on their own. Single-run (k=1) semantics above are
// untouched.

export class HostedAuthError extends Error {
  constructor(message: string, public readonly requestId?: string) {
    super(message);
    this.name = "HostedAuthError";
  }
}

export class HostedQuotaError extends Error {
  /** `details` mirrors the cloud error envelope's machine-readable details
   *  (e.g. `{ kind: "daily_judge_cap" }`) so `pome demo` (FDRS-643/662) can
   *  render honest labeled at-capacity states. Optional: older responses and
   *  the twin-pod 401 shape carry none. */
  constructor(
    message: string,
    public readonly requestId?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HostedQuotaError";
  }
}

export class HostedOrchError extends Error {
  /** `status` is the HTTP status that produced this error, when one exists
   *  (network/parse failures leave it undefined). `pome eval` uses it to
   *  scope its reaped-session retry to 404/410 only (FDRS-656 review). */
  constructor(
    message: string,
    public readonly requestId?: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "HostedOrchError";
  }
}

/** Bad invocation — missing scenario file, unknown flag value, etc. Maps
 *  to documented exit code 5 ("usage error"). F0-5a. */
export class HostedUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostedUsageError";
  }
}

/** FDRS-636 — a group trial errored before a cloud verdict existed
 *  (preflight failure, agent timeout, agent crash). The session was
 *  abandoned (POST /v1/sessions/:id/abandon) with `errorCode`; the group
 *  runner renders the trial as an errored row EXCLUDED from the verdict
 *  fraction. `message` is the short human reason shown on that row. */
export class HostedTrialError extends Error {
  constructor(message: string, public readonly errorCode: string) {
    super(message);
    this.name = "HostedTrialError";
  }
}

export function exitCodeFor(err: unknown): number {
  if (err instanceof HostedAuthError) return 3;
  if (err instanceof HostedQuotaError) return 4;
  if (err instanceof HostedUsageError) return 5;
  return 2;
}
