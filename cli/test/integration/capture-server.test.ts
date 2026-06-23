// SPDX-License-Identifier: Apache-2.0
// FDRS-406 — integration test for `pome capture-server`.
//
// Boots the capture-server in-process on an ephemeral port against a
// localhost upstream, runs one CONNECT-tunnelled request through it, and
// asserts an `LlmCallEvent` row was appended to `events.jsonl` with the
// expected shape.
//
// CONNECT tunnels are opaque to the proxy — the bytes inside are TLS, plain
// HTTP, or anything else, and the proxy never inspects them. So the upstream
// here is a plain TCP echo server: the proxy's behavior under CONNECT is
// identical whether the inner bytes are a real TLS handshake or arbitrary
// payload. The acceptance criterion (`bytes_out > 0`, host matches) exercises
// the same code path either way, without dragging openssl into the test
// runtime.

import { mkdtemp, readFile } from "node:fs/promises";
import { createServer as createNetServer, createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runCaptureServer,
  type CaptureServerHandle,
} from "../../src/capture-server/index.js";

function listenEphemeral(server: ReturnType<typeof createNetServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) resolve(addr.port);
      else reject(new Error("ephemeral listen returned no address"));
    });
  });
}

async function startUpstream(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.on("data", (chunk) => {
      socket.write(chunk);
    });
    socket.once("close", () => sockets.delete(socket));
  });
  const port = await listenEphemeral(server);
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

// Send a CONNECT request to the proxy, then write `payload` through the
// established tunnel and read back at most `payload.length` bytes (the
// upstream echoes). Resolves when the client closes the tunnel.
function tunnelOnce(
  proxyPort: number,
  targetHost: string,
  targetPort: number,
  payload: Buffer,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: "127.0.0.1", port: proxyPort });
    let header = "";
    let headerSeen = false;
    let echoBytes = 0;

    sock.on("error", reject);

    sock.on("data", (chunk: Buffer) => {
      if (!headerSeen) {
        header += chunk.toString("utf8");
        const split = header.indexOf("\r\n\r\n");
        if (split === -1) return;
        if (!/^HTTP\/1\.[01] 200/.test(header)) {
          sock.destroy();
          reject(new Error(`unexpected CONNECT response: ${header.slice(0, 80)}`));
          return;
        }
        headerSeen = true;
        const remainder = chunk.subarray(chunk.length - (header.length - split - 4));
        if (remainder.length > 0) echoBytes += remainder.length;
        sock.write(payload);
        return;
      }
      echoBytes += chunk.length;
      if (echoBytes >= payload.length) sock.end();
    });

    sock.on("close", () => resolve());

    sock.write(
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`,
    );
  });
}

describe("pome capture-server", () => {
  let capture: CaptureServerHandle | null = null;
  let upstream: { port: number; close: () => Promise<void> } | null = null;

  beforeEach(async () => {
    upstream = await startUpstream();
  });

  afterEach(async () => {
    if (capture) await capture.close();
    capture = null;
    if (upstream) await upstream.close();
    upstream = null;
  });

  it("appends one LlmCallEvent row per CONNECT tunnel", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "pome-capture-"));
    const eventsOut = join(runDir, "events.jsonl");

    capture = await runCaptureServer({ port: 0, eventsOut });

    const payload = Buffer.from("hello-from-test");
    await tunnelOnce(capture.port, "localhost", upstream!.port, payload);

    // The event is written when the upstream socket closes. Give the
    // write a tick to flush.
    await capture.flush();

    const lines = (await readFile(eventsOut, "utf8")).trim().split("\n");
    expect(lines.length).toBe(1);
    const row = JSON.parse(lines[0]!);
    expect(row.kind).toBe("LlmCallEvent");
    expect(row.host).toBe("localhost");
    expect(row.port).toBe(upstream!.port);
    expect(row.parent_id).toBeNull();
    expect(typeof row.event_id).toBe("string");
    expect(row.event_id.length).toBeGreaterThan(0);
    expect(row.bytes_out).toBeGreaterThan(0);
    expect(row.bytes_in).toBeGreaterThan(0);
    expect(row.latency_ms).toBeGreaterThanOrEqual(0);
    // TLS-terminate-only fields stay explicit-null in baseline mode.
    expect(row.url).toBeNull();
    expect(row.method).toBeNull();
    expect(row.status).toBeNull();
    expect(row.model).toBeNull();
    expect(row.prompt_tokens).toBeNull();
    expect(row.completion_tokens).toBeNull();
    expect(row.cost_usd).toBeNull();
  });

  it("rejects non-CONNECT requests with 405", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "pome-capture-"));
    const eventsOut = join(runDir, "events.jsonl");
    capture = await runCaptureServer({ port: 0, eventsOut });

    const response = await fetch(`http://127.0.0.1:${capture.port}/anything`);
    expect(response.status).toBe(405);
  });

  it("appends one row per tunnel across multiple connections", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "pome-capture-"));
    const eventsOut = join(runDir, "events.jsonl");
    capture = await runCaptureServer({ port: 0, eventsOut });

    const payload = Buffer.from("ping");
    await tunnelOnce(capture.port, "localhost", upstream!.port, payload);
    await tunnelOnce(capture.port, "localhost", upstream!.port, payload);
    await tunnelOnce(capture.port, "localhost", upstream!.port, payload);
    await capture.flush();

    const lines = (await readFile(eventsOut, "utf8")).trim().split("\n");
    expect(lines.length).toBe(3);
    const eventIds = new Set(lines.map((l) => JSON.parse(l).event_id));
    expect(eventIds.size).toBe(3);
  });

  it("flushes pending writes on close", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "pome-capture-"));
    const eventsOut = join(runDir, "events.jsonl");
    capture = await runCaptureServer({ port: 0, eventsOut });

    await tunnelOnce(capture.port, "localhost", upstream!.port, Buffer.from("x"));
    await capture.close();
    capture = null;

    const lines = (await readFile(eventsOut, "utf8")).trim().split("\n");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!).kind).toBe("LlmCallEvent");
  });
});
