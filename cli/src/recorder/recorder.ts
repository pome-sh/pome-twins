// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import type { RecorderEvent } from "@pome-sh/shared-types";
import type { Recorder } from "@pome-sh/twin-github";

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
