// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import type { RecorderEvent } from "@pome-sh/shared-types";
import {
  createFileBackedRecorderStore,
  createRecorderStore,
  type RecorderStore,
} from "@pome-sh/sdk/server";

/**
 * The CLI's event buffer. Structurally the engine's `RecorderStore` — the
 * ported twins (F-682) no longer export a per-twin Recorder type to borrow.
 *
 * F-698: when `eventsPath` is set, uses the twin-core durable store so twin
 * HTTP events stream to `events.jsonl` during the run (crash-safe).
 */
export type Recorder = RecorderStore;

export function createRecorder(options: { eventsPath?: string; maxEvents?: number } = {}): Recorder {
  if (options.eventsPath) {
    return createFileBackedRecorderStore({
      path: options.eventsPath,
      maxEvents: options.maxEvents,
      fsync: true,
    });
  }
  return createRecorderStore({ maxEvents: options.maxEvents });
}

export function createRequestId() {
  return `req_${randomUUID()}`;
}
