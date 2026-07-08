// SPDX-License-Identifier: Apache-2.0
/**
 * otel/fixtures — typed accessor for the golden-fixture conformance corpus
 * (M1.3 / FDRS-482).
 *
 * Stable import path for every consuming milestone (M1.2, M2–M6):
 *
 *   import { getLegacyFixtures, getEmitterFixtures } from "@pome-sh/shared-types/otel/fixtures";
 *
 * The corpus itself is static data in `./data`; this module is the documented,
 * typed entry point. Keep all access going through these accessors so a future
 * corpus reorganization is a one-file change.
 */

import {
  EMITTER_FIXTURES,
  EXTERNAL_API_FIXTURES,
  LEGACY_FIXTURES,
  TRACE_FIXTURES,
  type EmitterFixture,
  type ExternalApiFixture,
  type LegacyFixture,
  type TraceFixture,
} from "./data.js";

export type {
  EmitterFixture,
  ExternalApiFixture,
  LegacyFixture,
  TraceFixture,
} from "./data.js";

/** (legacy record → expected OtelSpanEvent) pairs — consumed by the M1.2 shim. */
export function getLegacyFixtures(): readonly LegacyFixture[] {
  return LEGACY_FIXTURES;
}

/** Real-emitter spans (Traceloop / Vercel AI SDK / Pydantic Logfire). */
export function getEmitterFixtures(): readonly EmitterFixture[] {
  return EMITTER_FIXTURES;
}

/** Multi-span sub-agent traces (parent_span_id trees). */
export function getTraceFixtures(): readonly TraceFixture[] {
  return TRACE_FIXTURES;
}

/** Twin-relevant external-API (HTTP) spans. */
export function getExternalApiFixtures(): readonly ExternalApiFixture[] {
  return EXTERNAL_API_FIXTURES;
}

/** Every normalized span across the emitter, trace, and external-API families. */
export function getAllSpanInputs() {
  return [
    ...EMITTER_FIXTURES.map((fixture) => fixture.span),
    ...TRACE_FIXTURES.flatMap((fixture) => fixture.spans),
    ...EXTERNAL_API_FIXTURES.map((fixture) => fixture.span),
  ];
}

/** Look up a legacy fixture by its stable `name`; throws if absent. */
export function getLegacyFixtureByName(name: string): LegacyFixture {
  const fixture = LEGACY_FIXTURES.find((candidate) => candidate.name === name);
  if (fixture === undefined) {
    throw new Error(`unknown legacy fixture: ${name}`);
  }
  return fixture;
}
