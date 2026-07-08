// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import type { RecorderEvent } from "@pome-sh/shared-types";

/**
 * The CLI's in-memory event buffer. Structurally the engine's
 * `RecorderStore` — the ported twins (F-682) no longer export a per-twin
 * Recorder type to borrow.
 */
export interface Recorder {
  record(event: RecorderEvent): void;
  events(): RecorderEvent[];
}

export function createRecorder(): Recorder {
  const items: RecorderEvent[] = [];
  return {
    record(event) {
      items.push(event);
    },
    events() {
      return [...items];
    }
  };
}

export function createRequestId() {
  return `req_${randomUUID()}`;
}
