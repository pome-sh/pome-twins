// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import type { Recorder, RecorderEvent } from "../twin/github/types.js";

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
