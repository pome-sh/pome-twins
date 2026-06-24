// SPDX-License-Identifier: Apache-2.0
import type { Recorder, RecorderEvent } from "./types.js";
import { redactEvent } from "../recorder/redaction.js";

// In-memory, run-scoped recorder for the twin pod. Events live for the
// lifetime of the machine — discarded when the sandbox shuts down (DELETE
// /v1/sessions/:id or 30-min TTL).
export function createRecorder(): Recorder {
  const items: RecorderEvent[] = [];
  return {
    record(event) {
      items.push(redactEvent(event));
    },
    events() {
      return [...items];
    },
  };
}
