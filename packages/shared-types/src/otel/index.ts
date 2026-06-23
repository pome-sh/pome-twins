// SPDX-License-Identifier: Apache-2.0
/**
 * otel — OpenTelemetry-native trace surface (Open Telemetry Integration, M1).
 *
 * Barrel re-export. Canonical home of the OTel surface; `pome-cloud` mirrors
 * this directory verbatim. The golden-fixture corpus under `./fixtures/` is a
 * test/dev artifact and is intentionally NOT re-exported from the public barrel.
 */
export * from "./semconv.js";
export * from "./nano.js";
export * from "./project.js";
export * from "./span-event.js";
export * from "./map-span.js";
export * from "./legacy-shim.js";
export * from "./event-schema.js";
