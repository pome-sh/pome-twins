// SPDX-License-Identifier: Apache-2.0
//
// F-720 — recorder write-through contract tests.
// Covers in-memory + file-backed stores: acceptance, flush/close, redaction
// before persistence, and canonical RecorderEvent NDJSON rows.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recorderEventSchema,
  twinHttpEventSchema,
  type RecorderEvent,
} from "@pome-sh/shared-types";

// Optional fsync override so we can assert flush() rethrows a prior failure
// after the rejected promise has left `pending` (ESM blocks spyOn on node:fs).
const fsMocks = vi.hoisted(() => ({
  fsync:
    null as null | ((fd: number, cb: (err: NodeJS.ErrnoException | null) => void) => void),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsync: (fd: number, cb: (err: NodeJS.ErrnoException | null) => void) => {
      if (fsMocks.fsync) return fsMocks.fsync(fd, cb);
      return actual.fsync(fd, cb);
    },
  };
});

const {
  createFileBackedRecorderStore,
  createRecorderHandle,
  createRecorderStore,
  toTwinHttpEventRow,
} = await import("../src/recorder.js");
type RecorderStore = import("../src/recorder.js").RecorderStore;

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function sampleEvent(overrides: Partial<RecorderEvent> = {}): RecorderEvent {
  return {
    ts: new Date().toISOString(),
    run_id: "run_contract",
    twin: "toy",
    request_id: `req_${Math.random().toString(36).slice(2, 10)}`,
    step_id: null,
    tool_call_id: null,
    method: "POST",
    path: "/s/test/items",
    request_body: { item: "alpha" },
    status: 201,
    response_body: { ok: true },
    latency_ms: 1,
    fidelity: "semantic",
    state_mutation: true,
    state_delta: null,
    error: null,
    ...overrides,
  };
}

async function assertStoreContract(store: RecorderStore, opts?: { path?: string }) {
  const event = sampleEvent();
  store.record(event);
  expect(store.count?.() ?? store.events().length).toBe(1);
  expect(store.events()[0]).toMatchObject({
    run_id: "run_contract",
    twin: "toy",
    method: "POST",
    status: 201,
  });
  const parsed = recorderEventSchema.safeParse(store.events()[0]);
  expect(parsed.success, JSON.stringify(parsed)).toBe(true);

  await store.flush?.();
  await store.close?.();

  if (opts?.path) {
    const raw = await readFile(opts.path, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    const row = JSON.parse(lines[0]!) as unknown;
    const diskParsed = twinHttpEventSchema.safeParse(row);
    expect(diskParsed.success, JSON.stringify(diskParsed)).toBe(true);
    expect(row).toMatchObject({
      run_id: "run_contract",
      twin: "toy",
      method: "POST",
      status: 201,
    });
    // Durable store writes TwinHttpEvent NDJSON (uploaded events.jsonl shape).
    expect((row as { kind?: unknown }).kind).toBe("TwinHttpEvent");
    expect((row as { event_id?: unknown }).event_id).toBe(
      (store.events()[0] as { request_id: string }).request_id
    );
  }
}

describe("recorder write-through contract (F-720)", () => {
  it("documents twin-core home as packages/sdk (no packages/twin-core)", () => {
    // Structural pin: this module *is* the twin-core recorder. Import path
    // stays @pome-sh/sdk — F-681 did not create packages/twin-core.
    expect(createRecorderStore).toBeTypeOf("function");
    expect(createFileBackedRecorderStore).toBeTypeOf("function");
  });

  it("in-memory store: accept → events → flush/close no-ops", async () => {
    await assertStoreContract(createRecorderStore());
  });

  it("file-backed store: accept → NDJSON on disk after flush/close", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pome-recorder-"));
    tmpDirs.push(dir);
    const path = join(dir, "events.jsonl");
    const store = createFileBackedRecorderStore({ path });
    await assertStoreContract(store, { path });
  });

  it("file-backed store with fsync: flush drains pending durable writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pome-recorder-"));
    tmpDirs.push(dir);
    const path = join(dir, "events.jsonl");
    const store = createFileBackedRecorderStore({ path, fsync: true });
    store.record(sampleEvent({ request_id: "req_a" }));
    store.record(sampleEvent({ request_id: "req_b" }));
    await store.flush?.();
    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const row = JSON.parse(line) as { kind?: string };
      expect(row.kind).toBe("TwinHttpEvent");
      expect(twinHttpEventSchema.safeParse(row).success).toBe(true);
    }
    await store.close?.();
  });

  it("file-backed fsync path does not silently skip durability on first write", async () => {
    // Regression: createWriteStream's async open left writer.fd undefined,
    // so fsync was skipped. Sync openSync + explicit fd must keep the first
    // fsync'd record on disk after flush.
    const dir = await mkdtemp(join(tmpdir(), "pome-recorder-"));
    tmpDirs.push(dir);
    const path = join(dir, "events.jsonl");
    const store = createFileBackedRecorderStore({ path, fsync: true });
    store.record(sampleEvent({ request_id: "req_first_fsync" }));
    await store.flush?.();
    const raw = await readFile(path, "utf8");
    expect(raw).toContain("req_first_fsync");
    await store.close?.();
  });

  it("redacts before any store.record — including custom stores", async () => {
    const seen: RecorderEvent[] = [];
    const custom: RecorderStore = {
      record(event) {
        seen.push(event);
      },
      events() {
        return [...seen];
      },
    };
    const recorder = createRecorderHandle({ runId: "r", twin: "toy", store: custom });
    recorder.record(
      sampleEvent({
        request_body: { password: "hunter2", ok: "fine" },
        response_body: { api_key: "leak" },
      })
    );
    expect(seen).toHaveLength(1);
    const req = seen[0]!.request_body as Record<string, unknown>;
    const res = seen[0]!.response_body as Record<string, unknown>;
    expect(req.password).toBe("[REDACTED]");
    expect(req.ok).toBe("fine");
    expect(res.api_key).toBe("[REDACTED]");
  });

  it("file-backed path never persists unredacted secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pome-recorder-"));
    tmpDirs.push(dir);
    const path = join(dir, "events.jsonl");
    const store = createFileBackedRecorderStore({ path });
    const recorder = createRecorderHandle({ runId: "r", twin: "toy", store });
    recorder.record(
      sampleEvent({
        request_body: { client_secret: "should-not-land-on-disk" },
      })
    );
    await recorder.flush();
    await recorder.close();
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("should-not-land-on-disk");
    expect(raw).toContain("[REDACTED]");
  });

  it("handle.flush/close forward to the store", async () => {
    let flushed = 0;
    let closed = 0;
    const store: RecorderStore = {
      record() {},
      events() {
        return [];
      },
      async flush() {
        flushed += 1;
      },
      async close() {
        closed += 1;
      },
    };
    const recorder = createRecorderHandle({ runId: "r", twin: "toy", store });
    await recorder.flush();
    await recorder.close();
    expect(flushed).toBe(1);
    expect(closed).toBe(1);
  });

  it("record after close throws on file-backed store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pome-recorder-"));
    tmpDirs.push(dir);
    const store = createFileBackedRecorderStore({ path: join(dir, "events.jsonl") });
    await store.close?.();
    expect(() => store.record(sampleEvent())).toThrow(/after close/);
  });

  it("flush surfaces a prior fsync failure after the promise left pending", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pome-recorder-"));
    tmpDirs.push(dir);
    const path = join(dir, "events.jsonl");
    fsMocks.fsync = (_fd, cb) => {
      queueMicrotask(() => cb(new Error("simulated fsync failure")));
    };
    try {
      const store = createFileBackedRecorderStore({ path, fsync: true });
      store.record(sampleEvent({ request_id: "req_fail" }));
      // Let the write+fsync callbacks settle and leave `pending` before flush.
      await new Promise((r) => setTimeout(r, 30));
      await expect(store.flush?.()).rejects.toThrow(/simulated fsync failure/);
    } finally {
      fsMocks.fsync = null;
    }
  });

  it("toTwinHttpEventRow re-wraps non-TwinHttpEvent kinds", () => {
    const legacyShaped = {
      ...sampleEvent({ request_id: "req_legacy" }),
      kind: "LlmCallEvent",
    } as unknown as RecorderEvent;
    const wrapped = toTwinHttpEventRow(legacyShaped);
    expect(wrapped.kind).toBe("TwinHttpEvent");
    expect(wrapped.event_id).toBe("req_legacy");
    expect(wrapped.parent_id).toBeNull();
    const already = toTwinHttpEventRow({
      ...sampleEvent({ request_id: "req_ok" }),
      kind: "TwinHttpEvent",
      event_id: "req_ok",
      parent_id: null,
    } as RecorderEvent);
    expect(already.kind).toBe("TwinHttpEvent");
    expect(already.event_id).toBe("req_ok");
  });

  it("bounded file-backed store caps events() but keeps all rows on disk", async () => {
    // maxEvents is a heap-mirror bound (memory pressure), not a durable-tape
    // truncate. Crash-safe upload reads the NDJSON file, not events().
    const dir = await mkdtemp(join(tmpdir(), "pome-recorder-"));
    tmpDirs.push(dir);
    const path = join(dir, "events.jsonl");
    const store = createFileBackedRecorderStore({ path, maxEvents: 1 });
    store.record(sampleEvent({ request_id: "req_old" }));
    store.record(sampleEvent({ request_id: "req_new" }));
    expect(store.events()).toHaveLength(1);
    expect(store.events()[0]?.request_id).toBe("req_new");
    expect(store.dropped?.()).toBe(1);
    await store.flush?.();
    await store.close?.();
    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(raw).toContain("req_old");
    expect(raw).toContain("req_new");
  });
});
