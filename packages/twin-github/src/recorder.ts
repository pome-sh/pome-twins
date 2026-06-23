// SPDX-License-Identifier: Apache-2.0
import type { Recorder, RecorderEvent } from "./types.js";
import { redactSecrets } from "./redaction.js";

// In-memory, run-scoped recorder for the twin pod. Events live for the
// lifetime of the machine — discarded when Fly destroys the pod (DELETE
// /v1/sessions/:id or 30-min TTL). This is intentional: the trace is
// fetched once via GET /_pome/events at end-of-run by the CLI; any
// post-mortem inspection happens via the cloud-side trace blob the CLI
// uploads after.
//
// Memory cap: bounded by session timeout × max-rps. A 30-min session at
// 10 rps × ~500B per event ≈ 9 MB. Comfortably below the pod's 256 MB.
//
// Centralized secret redaction (FDRS-402): request_body / response_body run
// through `redactSecrets` here so every call site benefits without each
// route remembering to do it.
export function createRecorder(): Recorder {
  const items: RecorderEvent[] = [];
  return {
    record(event) {
      items.push({
        ...event,
        request_body: redactSecrets(event.request_body),
        response_body: redactSecrets(event.response_body),
      });
    },
    events() {
      return [...items];
    },
  };
}
