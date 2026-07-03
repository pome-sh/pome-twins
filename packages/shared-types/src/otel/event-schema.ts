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
 * This union is FORMAT surface and canonical HERE (ownership boundary settled
 * at FDRS-653 — see `./index.ts`). pome-cloud consumes it; its earlier
 * cloud-local composition of the same union collapses into this one at the
 * FDRS-654 consumer swap.
 */

import { z } from "zod";

import { eventSchema } from "../recorder-events.js";
import { otelSpanEventSchema } from "./span-event.js";

// The OTel-inclusive event row: the legacy `eventSchema` (a discriminated union
// over `kind`, with the FDRS-653 task-vocab normalization applied) OR an
// `OtelSpanEvent`. A plain `z.union` is used rather than extending the
// discriminated union because `otelSpanEventSchema` carries cross-field
// `superRefine` invariants (it is not a bare `ZodObject`, so it cannot be a
// discriminated-union member). For a 2-arm union this is a non-breaking
// superset: legacy rows match the first arm, OtelSpanEvent rows the second.
export const otelEventSchema = z.union([eventSchema, otelSpanEventSchema]);
export type OtelEvent = z.infer<typeof otelEventSchema>;
