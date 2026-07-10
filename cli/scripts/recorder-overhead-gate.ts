// SPDX-License-Identifier: Apache-2.0
//
// F-722 — recorder hot-path overhead gate.
// Micro-benchmarks heap vs durable (file-backed, fsync) `record()` latency
// using the same twin-core store production twins use, and fails if durable
// p99 exceeds RECORDER_OVERHEAD_BUDGET_MS (default 5ms per event).
//
// Reuses percentile math from overhead-stats.ts. Designed to run from `cli/`:
//   cd cli && npx tsx scripts/recorder-overhead-gate.ts

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileBackedRecorderStore,
  createRecorderStore,
} from "@pome-sh/sdk/server";
import type { RecorderEvent } from "@pome-sh/shared-types";
import { percentile, summarize } from "./overhead-stats.js";

const N = Number.parseInt(process.env.RECORDER_OVERHEAD_N ?? "200", 10);
const WARMUP = Number.parseInt(process.env.RECORDER_OVERHEAD_WARMUP ?? "20", 10);
// Hot-path budget: sync record() enqueue cost (not fsync). Default 1ms is
// generous vs heap (~µs) while still catching accidental sync disk I/O on
// the request path.
const BUDGET_RAW = process.env.RECORDER_OVERHEAD_BUDGET_MS ?? "1";
const BUDGET_MS = Number.parseFloat(BUDGET_RAW);
if (!Number.isFinite(BUDGET_MS) || BUDGET_MS <= 0) {
  console.error(
    `[recorder-overhead-gate] FAIL: RECORDER_OVERHEAD_BUDGET_MS must be a positive number (got ${JSON.stringify(BUDGET_RAW)})`,
  );
  process.exit(1);
}

function sampleEvent(i: number): RecorderEvent {
  return {
    ts: new Date().toISOString(),
    run_id: "run_overhead",
    twin: "toy",
    request_id: `req_${String(i).padStart(5, "0")}`,
    step_id: null,
    tool_call_id: null,
    method: "POST",
    path: "/s/test/items",
    request_body: { i },
    status: 201,
    response_body: { ok: true },
    latency_ms: 1,
    fidelity: "semantic",
    state_mutation: true,
    state_delta: null,
    error: null,
  };
}

async function benchHeap(): Promise<number[]> {
  const store = createRecorderStore();
  const samples: number[] = [];
  for (let i = 0; i < WARMUP + N; i++) {
    const t0 = performance.now();
    store.record(sampleEvent(i));
    const dt = performance.now() - t0;
    if (i >= WARMUP) samples.push(dt);
  }
  await store.flush?.();
  await store.close?.();
  return samples;
}

async function benchDurable(dir: string): Promise<number[]> {
  const store = createFileBackedRecorderStore({
    path: join(dir, "events.jsonl"),
    fsync: true,
  });
  const flush = store.flush;
  const close = store.close;
  if (!flush || !close) {
    fail("createFileBackedRecorderStore must implement flush/close");
  }
  const samples: number[] = [];
  for (let i = 0; i < WARMUP + N; i++) {
    const t0 = performance.now();
    // Hot path: record() queues the append; callers do not await flush per
    // event. Measuring flush-per-event would gate OS fsync noise, not twin
    // request latency.
    store.record(sampleEvent(i));
    const dt = performance.now() - t0;
    if (i >= WARMUP) samples.push(dt);
  }
  await flush();
  await close();
  return samples;
}

function fail(msg: string): never {
  console.error(`[recorder-overhead-gate] FAIL: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pome-recorder-overhead-"));
  console.log(
    `[recorder-overhead-gate] N=${N} warmup=${WARMUP} budget=${BUDGET_MS}ms path=${dir}`,
  );
  try {
    const heap = await benchHeap();
    const durable = await benchDurable(dir);
    const heapStats = summarize(heap);
    const durableStats = summarize(durable);
    const sortedDurable = [...durable].sort((a, b) => a - b);
    const durableP99 = percentile(sortedDurable, 0.99);

    console.log(
      `[recorder-overhead-gate] heap     p50=${heapStats.p50.toFixed(3)}ms p99=${heapStats.p99.toFixed(3)}ms`,
    );
    console.log(
      `[recorder-overhead-gate] durable  p50=${durableStats.p50.toFixed(3)}ms p99=${durableStats.p99.toFixed(3)}ms`,
    );
    console.log(
      `[recorder-overhead-gate] durable p99=${durableP99.toFixed(3)}ms (budget ${BUDGET_MS}ms)`,
    );

    if (!Number.isFinite(durableP99)) {
      fail(`durable p99 is not finite (${durableP99})`);
    }
    if (durableP99 > BUDGET_MS) {
      fail(
        `durable recorder p99 ${durableP99.toFixed(3)}ms exceeded budget ${BUDGET_MS}ms`,
      );
    }
    console.log("[recorder-overhead-gate] PASS");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Allow importing from a built workspace SDK when run from cli/ after pack,
// or from the monorepo node_modules link during local/dev CI.
void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
