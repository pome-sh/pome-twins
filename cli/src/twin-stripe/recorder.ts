// SPDX-License-Identifier: Apache-2.0
// Bounded recorder per D-ENG-10 / E-10. Drops oldest events on overflow and
// exposes a `dropped` counter so /_pome/health can surface the bound and any
// loss. Default cap is 10k; adjustable via opts for tests.
import type { Recorder, RecorderEvent } from "./types.js";
import { redactEvent } from "../recorder/redaction.js";

export type RecorderOptions = {
  maxEvents?: number;
};

export const DEFAULT_RECORDER_CAP = 10_000;

export function createRecorder(opts: RecorderOptions = {}): Recorder {
  const cap = Math.max(1, opts.maxEvents ?? DEFAULT_RECORDER_CAP);
  const items: RecorderEvent[] = [];
  let droppedCount = 0;

  return {
    record(event: RecorderEvent) {
      items.push(redactEvent(event));
      while (items.length > cap) {
        items.shift();
        droppedCount += 1;
      }
    },
    events() {
      return [...items];
    },
    dropped() {
      return droppedCount;
    }
  };
}
