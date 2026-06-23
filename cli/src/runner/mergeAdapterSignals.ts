// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from "node:fs/promises";
import { eventSchema, type Event } from "../types/shared.js";

// Post-run merge of the adapter signals JSONL into the canonical events.jsonl
// (FDRS-411 + FDRS-412). The canonical implementation of the pure ts-sort
// step lives in `@pome-sh/correlator` as `mergeSignalsIntoEvents`; we mirror
// it inline here to keep this IO wrapper independent of the vendored
// correlator tarball.
//
// Three sources write events.jsonl during a self-host run:
//   1. The capture-server child appends `LlmCallEvent` rows as each CONNECT
//      tunnel closes (FDRS-399) — capture-close order, not ts-order.
//   2. `scoreAndWriteRun` then appends `TwinHttpEvent` rows from the in-process
//      twin recorder (FDRS-415).
//   3. This helper reads `signals.jsonl` (HookEvent / ToolUseEvent /
//      ToolResultEvent / SubagentSpawnEvent rows written by the agent
//      subprocess via `POME_ADAPTER_SIGNALS_PATH`), validates each line
//      against the M0 unified `eventSchema`, then **interleaves** the signal
//      rows with the existing events.jsonl rows by ts ascending and rewrites
//      the file. The merged file is the canonical view for `pome inspect`
//      + dashboard upload.
//
// Robustness: a missing signals file, an empty file, malformed JSONL lines,
// and signals that fail schema validation never crash the run. Invalid signal
// lines are dropped and counted; the caller can log the drop count. Existing
// events.jsonl rows that fail to parse are passed through unsorted at the
// head of the file so a corrupted in-flight write is never silently dropped.
export async function mergeAdapterSignalsIntoEvents(
  signalsPath: string,
  eventsJsonlPath: string,
): Promise<{ appended: number; dropped: number }> {
  let rawSignals: string;
  try {
    rawSignals = await readFile(signalsPath, "utf8");
  } catch {
    return { appended: 0, dropped: 0 };
  }

  let dropped = 0;
  const signalRows: Event[] = [];
  for (const line of rawSignals.split("\n")) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      dropped += 1;
      continue;
    }
    const result = eventSchema.safeParse(parsed);
    if (!result.success) {
      dropped += 1;
      continue;
    }
    signalRows.push(result.data);
  }

  if (signalRows.length === 0) return { appended: 0, dropped };

  let rawEvents: string;
  try {
    rawEvents = await readFile(eventsJsonlPath, "utf8");
  } catch {
    rawEvents = "";
  }

  const eventRows: Event[] = [];
  const unparseablePassthrough: string[] = [];
  for (const line of rawEvents.split("\n")) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      unparseablePassthrough.push(line);
      continue;
    }
    const result = eventSchema.safeParse(parsed);
    if (result.success) {
      eventRows.push(result.data);
    } else {
      // A schema-invalid row on disk means the writer drifted from the M0
      // schema; preserving the raw line is safer than dropping it silently.
      unparseablePassthrough.push(line);
    }
  }

  // Concat + stable sort by ts — mirrors `@pome-sh/correlator`'s
  // `mergeSignalsIntoEvents`. ISO-8601 with `Z` sorts chronologically under
  // lexicographic compare.
  const merged = eventRows.concat(signalRows);
  merged.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  const sortedJsonl = merged.map((r) => JSON.stringify(r)).join("\n");
  const head = unparseablePassthrough.length > 0 ? unparseablePassthrough.join("\n") + "\n" : "";
  await writeFile(eventsJsonlPath, head + sortedJsonl + "\n");
  return { appended: signalRows.length, dropped };
}
