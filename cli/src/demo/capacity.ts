// SPDX-License-Identifier: Apache-2.0
// FDRS-643 / FDRS-662 — honest at-capacity states for the anonymous demo.
//
// The demo's cloud surface returns machine-readable 402/429 errors at three
// choke points (mint, model-call gateway, finalize/judge). Each maps to an
// honest labeled terminal state — never a stack trace, never a fabricated
// completion. Kinds of record (pome-cloud routes/demo-sessions.ts,
// routes/demo-llm.ts, routes/finalize.ts):
//   - mint 429 (per-IP daily session cap; no `kind` in details)
//   - mint 402 (house team session quota; no `kind`)
//   - gateway 429 kind=session_llm_call_cap
//   - gateway 429 kind=demo_ip_llm_cap
//   - gateway 402 kind=daily_model_cap
//   - finalize 402 kind=daily_judge_cap
//   - gateway 503 kind=ai_gateway_disabled / demo_model_unpriced

export type DemoCapacityKind =
  | "demo_ip_mint_cap"
  | "demo_mint_quota"
  | "session_llm_call_cap"
  | "demo_ip_llm_cap"
  | "daily_model_cap"
  | "daily_judge_cap"
  | "gateway_unavailable"
  | "unknown_capacity";

export class DemoCapacityError extends Error {
  constructor(
    public readonly kind: DemoCapacityKind,
    message: string,
  ) {
    super(message);
    this.name = "DemoCapacityError";
  }
}

/** Map a machine-readable error `kind` string (from the cloud envelope's
 *  details) + HTTP status to a DemoCapacityKind. */
export function capacityKindFrom(
  status: number,
  detailsKind: unknown,
): DemoCapacityKind | null {
  if (typeof detailsKind === "string") {
    switch (detailsKind) {
      case "session_llm_call_cap":
        return "session_llm_call_cap";
      case "demo_ip_llm_cap":
        return "demo_ip_llm_cap";
      case "daily_model_cap":
        return "daily_model_cap";
      case "daily_judge_cap":
        return "daily_judge_cap";
      case "ai_gateway_disabled":
      case "demo_model_unpriced":
        return "gateway_unavailable";
      default:
        break;
    }
  }
  if (status === 402 || status === 429) return "unknown_capacity";
  if (status === 503) return "gateway_unavailable";
  return null;
}

/** One honest human line per at-capacity kind (design: "the demo is at
 *  capacity today — try again tomorrow" register; no stack traces). */
export function capacityLabel(kind: DemoCapacityKind): string {
  switch (kind) {
    case "demo_ip_mint_cap":
    case "demo_ip_llm_cap":
      return "the demo hit today's limit for this network — try again tomorrow, or sign up for a free account";
    case "daily_model_cap":
      return "the demo's daily model budget is exhausted — try again tomorrow, or sign up for a free account";
    case "daily_judge_cap":
      return "the demo's daily evaluation budget is exhausted — try again tomorrow, or sign up for a free account";
    case "session_llm_call_cap":
      return "this trial hit its model-call ceiling";
    case "gateway_unavailable":
      return "the demo model gateway is unavailable right now — try again shortly";
    case "demo_mint_quota":
    case "unknown_capacity":
      return "the demo is at capacity today — try again tomorrow";
  }
}

/** Marker line the bundled agent prints to stderr when the GATEWAY reports
 *  capacity, so the parent `pome demo` process (which only sees the child's
 *  exit code + stderr) can render the honest label instead of a generic
 *  "trial errored". */
export const CAPACITY_STDERR_PREFIX = "POME_DEMO_CAPACITY:";

export function capacityMarkerLine(kind: DemoCapacityKind): string {
  return `${CAPACITY_STDERR_PREFIX}${kind}`;
}

export function parseCapacityMarker(stderr: string): DemoCapacityKind | null {
  const match = stderr.match(
    new RegExp(`${CAPACITY_STDERR_PREFIX}([a-z_]+)`, "m"),
  );
  if (!match) return null;
  const kind = match[1] as DemoCapacityKind;
  const known: DemoCapacityKind[] = [
    "demo_ip_mint_cap",
    "demo_mint_quota",
    "session_llm_call_cap",
    "demo_ip_llm_cap",
    "daily_model_cap",
    "daily_judge_cap",
    "gateway_unavailable",
    "unknown_capacity",
  ];
  return known.includes(kind) ? kind : "unknown_capacity";
}
