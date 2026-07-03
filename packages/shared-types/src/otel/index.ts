// SPDX-License-Identifier: Apache-2.0
/**
 * otel — OpenTelemetry-native trace surface (Open Telemetry Integration, M1).
 *
 * Barrel re-export. The golden-fixture corpus under `./fixtures/` is a
 * test/dev artifact and is intentionally NOT re-exported from the public barrel.
 *
 * OWNERSHIP BOUNDARY (settled at FDRS-653; supersedes the earlier
 * "pome-cloud mirrors this directory verbatim" claim, which no longer held):
 *   - FORMAT schemas are canonical HERE, in `pome-sh/pome-twins`
 *     `@pome-sh/shared-types` v0.5.0+: `span-event`, `event-schema`,
 *     `semconv`, `nano`, `project`, `map-span`, `legacy-shim`, and the
 *     `fixtures/` corpus. pome-cloud CONSUMES this surface (FDRS-654 swaps it
 *     onto the published package); it does not fork it.
 *   - INGEST-side utilities are cloud-owned consumers and intentionally do NOT
 *     live here: OTLP wire decoding (`decode-otlp.ts`), redaction/allowlist
 *     processors, storage helpers, and the raw OTLP envelope capture tooling +
 *     captured envelope fixtures that feed the decoder.
 */
export * from "./semconv.js";
export * from "./nano.js";
export * from "./project.js";
export * from "./span-event.js";
export * from "./map-span.js";
export * from "./legacy-shim.js";
export * from "./event-schema.js";
