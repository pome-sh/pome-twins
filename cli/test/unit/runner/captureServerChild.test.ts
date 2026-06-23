// SPDX-License-Identifier: Apache-2.0
// FDRS-399 — unit tests for the capture-server child-process helper used by
// `pome run` to spawn `pome capture-server` as a child before invoking the
// agent.
//
// We avoid coupling to the real CLI build state by pointing the helper at a
// stub binary (a `node -e "..."` one-liner) that mimics the contract the real
// `pome capture-server` honors: print "listening on 127.0.0.1:<port> …" to
// stderr on boot, exit 0 on SIGTERM.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  spawnCaptureServerChild,
  type CaptureServerChildHandle,
} from "../../../src/runner/captureServerChild.js";

const NODE = process.execPath;

function stubScript(body: string): string[] {
  return [NODE, "-e", body];
}

// Healthy stub: bind ephemeral, print the listening line, sit on SIGTERM and
// exit 0.
const HEALTHY_STUB = `
  const http = require("node:http");
  const srv = http.createServer(() => {});
  srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address();
    process.stderr.write("pome capture-server listening on 127.0.0.1:" + port + " (events → x)\\n");
  });
  process.on("SIGTERM", () => { srv.close(() => process.exit(0)); });
`;

// Crashes before printing the listening line.
const EARLY_EXIT_STUB = `
  process.stderr.write("boot error: ENOENT\\n");
  process.exit(7);
`;

// Hangs without ever printing the listening line.
const HUNG_STUB = `
  setInterval(() => {}, 1000);
`;

// Refuses SIGTERM (forces the SIGKILL fallback path).
const SIGTERM_DEAF_STUB = `
  const http = require("node:http");
  const srv = http.createServer(() => {});
  srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address();
    process.stderr.write("pome capture-server listening on 127.0.0.1:" + port + " (events → x)\\n");
  });
  process.on("SIGTERM", () => { /* ignore */ });
  setInterval(() => {}, 1000);
`;

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pome-capture-child-"));
}

describe("spawnCaptureServerChild", () => {
  let handle: CaptureServerChildHandle | null = null;

  afterEach(async () => {
    if (handle) await handle.shutdown();
    handle = null;
  });

  it("resolves with the parsed ephemeral port and a live pid", async () => {
    const dir = await tmp();
    const [execPath, ...argv] = stubScript(HEALTHY_STUB);
    handle = await spawnCaptureServerChild({
      eventsOut: join(dir, "events.jsonl"),
      execPath,
      binArgs: argv,
    });
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.port).toBeLessThanOrEqual(65535);
    expect(handle.pid).toBeGreaterThan(0);
    // pid is alive — kill(pid, 0) returns true; throws ESRCH if dead.
    expect(() => process.kill(handle!.pid, 0)).not.toThrow();
  });

  it("rejects if the child exits before printing the listening line", async () => {
    const dir = await tmp();
    const [execPath, ...argv] = stubScript(EARLY_EXIT_STUB);
    await expect(
      spawnCaptureServerChild({
        eventsOut: join(dir, "events.jsonl"),
        execPath,
        binArgs: argv,
      }),
    ).rejects.toThrow(/exited.*before.*listening|boot error/i);
  });

  it("rejects with a timeout if the child never prints the line", async () => {
    const dir = await tmp();
    const [execPath, ...argv] = stubScript(HUNG_STUB);
    await expect(
      spawnCaptureServerChild({
        eventsOut: join(dir, "events.jsonl"),
        execPath,
        binArgs: argv,
        readyTimeoutMs: 250,
      }),
    ).rejects.toThrow(/timed out|did not.*listen/i);
  });

  it("shutdown() SIGTERMs the child cleanly", async () => {
    const dir = await tmp();
    const [execPath, ...argv] = stubScript(HEALTHY_STUB);
    handle = await spawnCaptureServerChild({
      eventsOut: join(dir, "events.jsonl"),
      execPath,
      binArgs: argv,
    });
    const pid = handle.pid;
    await handle.shutdown();
    handle = null;
    // ESRCH after shutdown — process is gone, no orphan.
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  });

  it("shutdown() is idempotent", async () => {
    const dir = await tmp();
    const [execPath, ...argv] = stubScript(HEALTHY_STUB);
    handle = await spawnCaptureServerChild({
      eventsOut: join(dir, "events.jsonl"),
      execPath,
      binArgs: argv,
    });
    await handle.shutdown();
    await expect(handle.shutdown()).resolves.toBeUndefined();
    handle = null;
  });

  it("falls back to SIGKILL when the child ignores SIGTERM", async () => {
    const dir = await tmp();
    const [execPath, ...argv] = stubScript(SIGTERM_DEAF_STUB);
    handle = await spawnCaptureServerChild({
      eventsOut: join(dir, "events.jsonl"),
      execPath,
      binArgs: argv,
      shutdownGraceMs: 250,
    });
    const pid = handle.pid;
    await handle.shutdown();
    handle = null;
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  });
});
