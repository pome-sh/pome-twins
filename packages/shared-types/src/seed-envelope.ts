// SPDX-License-Identifier: Apache-2.0
//
// shared-types §3 — multi-twin seed envelope. Re-exported through the
// `@pome-sh/shared-types` barrel (index.ts).
//
// THE RULE (no shape-sniffing anywhere): the create-session `seed` override is a
// per-twin envelope `{ <twin>: <flat seed> }` IF AND ONLY IF the session has
// more than one twin. Single-twin sessions ALWAYS use the flat single-twin seed
// shape (the domain seed object the twin's own `parseSeed` owns — see
// createSessionRequestSchema.seed). Callers decide which shape to send from the
// session's `twins` array alone (`isMultiTwinSeedEnvelope`), never by inspecting
// the seed's contents. This keeps the boundary shape-blind: a flat seed and an
// envelope are both JSON objects, so sniffing would be ambiguous and brittle.

import { z } from "zod";

// Multi-twin (M3) seed envelope: twin id → that twin's flat domain seed. Like
// createSessionRequestSchema.seed, each per-twin seed is a permissive,
// shape-blind JSON object — the twin pod's `parseSeed` is the sole authority on
// its domain shape. The envelope keeps only the two invariants that are the
// boundary's business: the envelope is a JSON object, and each value is a JSON
// object.
//
// WHERE THE ENVELOPE-IFF-MULTI-TWIN RULE IS ENFORCED (not here): this schema and
// createSessionRequestSchema.seed are deliberately shape-blind — the request
// boundary accepts any JSON-object `seed` for both single- and multi-twin
// sessions and forwards it verbatim. The correlation between the `seed` shape and
// `twins.length` is validated at the EDGES, where the `twins` array is known:
//   - the cloud validates envelope-iff-multi-twin at session create; and
//   - the CLI validates it at scenario parse time
// (both landing in follow-up PRs). Do NOT add that cross-field check to the
// request schema — the twin owns its seed shape, and sniffing here would be the
// ambiguous, brittle coupling THE RULE exists to avoid.
export const seedEnvelopeSchema = z.record(
  z.string(),
  z.record(z.string(), z.unknown()),
);
export type SeedEnvelope = z.infer<typeof seedEnvelopeSchema>;

/**
 * THE RULE, in code: a session's `seed` is a per-twin envelope iff the session
 * has more than one twin. Decide from the `twins` array alone — never by
 * sniffing the seed's shape.
 *
 * This is the shared PREDICATE, not the enforcement point. The actual
 * envelope-iff-multi-twin check runs at the edges that know `twins`: the cloud
 * at session create and the CLI at scenario parse time (follow-up PRs). The
 * create-session request schema stays a shape-blind pass-through by design.
 */
export function isMultiTwinSeedEnvelope(twins: string[]): boolean {
  return twins.length > 1;
}
