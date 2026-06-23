// SPDX-License-Identifier: Apache-2.0
/**
 * otel/event-schema — the OTel-inclusive event union (M1.1 / FDRS-480).
 *
 * `eventSchema` in `recorder-events.ts` is the FROZEN v1 legacy union (the
 * recording-spec contract under the repo's change-lock policy). Rather than
 * mutate that frozen union, this file composes the OTel-extended union
 * ADDITIVELY — a non-breaking superset:
 *
 *   - `eventSchema`     (recorder-events.ts) — the v1 legacy-only union.
 *   - `otelEventSchema` (this file)          — legacy variants PLUS `OtelSpanEvent`.
 *
 * OTel-aware consumers (M3 correlation, the native trace renderer) import
 * `otelEventSchema`; readers that only handle the v1 legacy shapes keep using
 * `eventSchema` and recognize `OtelSpanEvent` separately.
 *
 * This is the canonical home of the OTel surface; `pome-cloud` mirrors this
 * `src/otel/` directory verbatim (its earlier cloud-only copy collapses into
 * this mirror).
 */

import { z } from "zod";

import { eventSchema } from "../recorder-events.js";
import { otelSpanEventSchema } from "./span-event.js";

// The OTel-inclusive event row: the legacy `eventSchema` (a discriminated union
// over `kind`) OR an `OtelSpanEvent`. A plain `z.union` is used rather than
// extending the discriminated union because `otelSpanEventSchema` carries
// cross-field `superRefine` invariants (it is a `ZodEffects`, not a bare
// `ZodObject`, so it cannot be a discriminated-union member). For a 2-arm union
// this is a non-breaking superset: legacy rows match the first arm,
// OtelSpanEvent rows the second.
export const otelEventSchema = z.union([eventSchema, otelSpanEventSchema]);
export type OtelEvent = z.infer<typeof otelEventSchema>;
