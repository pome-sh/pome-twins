// SPDX-License-Identifier: Apache-2.0
//
// Endpoint family extraction for the heuristic correlator.
//
// Strips the `/s/<sid>/` session prefix that all session-scoped twin routes
// carry, then returns the first two path segments. The result is the
// `family` used as a step-boundary signal in `heuristic.ts`.
//
// Examples:
//   /s/default/v1/refunds           -> /v1/refunds
//   /s/default/v1/charges/ch_abc    -> /v1/charges
//   /v1/refunds                     -> /v1/refunds (no prefix; pass-through)
//   /repos/owner/name/issues/42     -> /repos/owner
//   /                               -> /
//
// V1 deliberately does not detect Stripe resource ids (`re_xxx`, `ch_xxx`)
// or GitHub-style ids. Refinement → V1.5+ (see README § scope discipline).

const SESSION_PREFIX = /^\/s\/[^/]+(?=\/)/;

export function endpointFamily(path: string): string {
  const stripped = path.replace(SESSION_PREFIX, "");
  const segments = stripped.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return "/";
  if (segments.length === 1) return `/${segments[0]}`;
  return `/${segments[0]}/${segments[1]}`;
}
