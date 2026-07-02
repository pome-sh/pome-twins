// SPDX-License-Identifier: Apache-2.0
// FDRS-635 — integration tests for the capture-server's deny-by-default
// egress floor.
//
// The proxy refuses CONNECT tunnels to hosts outside the allowlist with a
// 403 BEFORE dialing upstream, and records each refusal in the egress
// sidecar (egress.jsonl — deliberately NOT events.jsonl, whose row shape is
// locked by shared-types / the correlator). Loopback targets are always
// allowed so twin traffic can never be broken by a bad allowlist.
//
// The "allowed but unresolvable" case asserts the ordering: an allowlisted
// host fails with 502 (upstream dial attempted, `.invalid` never resolves —
// RFC 6761), a denied host fails with 403 (never dialed). Distinct status
// codes prove the gate fires before the dial.

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

async function startUpstream(): Promise<{
  port: number;
  connections: () => number;
  close: () => Promise<void>;
}> {
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createNetServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("data", (chunk) => {
      socket.write(chunk);
    });
    socket.once("close", () => sockets.delete(socket));
  });
  const port = await listenEphemeral(server);
  return {
    port,
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

// Retry `fn` until it returns non-null or ~2s elapse.
async function pollFor<T>(fn: () => Promise<T | null>): Promise<T> {
  for (let i = 0; i < 40; i++) {
    const value = await fn();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not reached within 2s");
}

// Send one CONNECT and resolve with the response status line (e.g. "200",
// "403", "502"). For a 200, immediately close the tunnel.
function connectStatus(
  proxyPort: number,
  targetHost: string,
  targetPort: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: "127.0.0.1", port: proxyPort });
    let header = "";
    let done = false;
    sock.on("error", reject);
    sock.on("data", (chunk: Buffer) => {
      if (done) return;
      header += chunk.toString("utf8");
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(header);
      if (!match) return;
      done = true;
      const status = match[1]!;
      sock.end();
      resolve(status);
    });
    sock.on("close", () => {
      if (!done) reject(new Error(`socket closed before a status line: ${header.slice(0, 120)}`));
    });
    sock.write(
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`,
    );
  });
}

describe("pome capture-server — egress floor (FDRS-635)", () => {
  let capture: CaptureServerHandle | null = null;
  let upstream: Awaited<ReturnType<typeof startUpstream>> | null = null;

  beforeEach(async () => {
    upstream = await startUpstream();
  });

  afterEach(async () => {
    if (capture) await capture.close();
    capture = null;
    if (upstream) await upstream.close();
    upstream = null;
  });

  it("refuses a CONNECT to a non-allowlisted host with 403 and records it in egress.jsonl", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "pome-egress-int-"));
    const eventsOut = join(runDir, "events.jsonl");
    const egressOut = join(runDir, "egress.jsonl");
    capture = await runCaptureServer({ port: 0, eventsOut, allowHosts: [], egressOut });

    const status = await connectStatus(capture.port, "blocked.example", 443);
    expect(status).toBe("403");

    await capture.flush();

    // The refusal is a sidecar row, not an LlmCallEvent.
    const egressRows = (await readFile(egressOut, "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { kind: string; host: string; port: number });
    expect(egressRows).toHaveLength(1);
    expect(egressRows[0]).toMatchObject({
      kind: "EgressRefusedEvent",
      host: "blocked.example",
      port: 443,
    });

    const events = (await readFile(eventsOut, "utf8")).trim();
    expect(events).toBe("");
  });

  it("still tunnels loopback targets with an empty allowlist (twin traffic can never break)", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "pome-egress-int-"));
    const eventsOut = join(runDir, "events.jsonl");
    const egressOut = join(runDir, "egress.jsonl");
    capture = await runCaptureServer({ port: 0, eventsOut, allowHosts: [], egressOut });

    const status = await connectStatus(capture.port, "127.0.0.1", upstream!.port);
    expect(status).toBe("200");

    // The LlmCallEvent lands when the server-side sockets close — that
    // trails the client's close by an event-loop turn or two, so poll.
    const lines = await pollFor(async () => {
      await capture!.flush();
      const content = (await readFile(eventsOut, "utf8")).trim().split("\n").filter(Boolean);
      return content.length >= 1 ? content : null;
    });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).kind).toBe("LlmCallEvent");
  });

  it("lets an allowlisted host through the gate (dial attempted → 502 on NXDOMAIN, never 403)", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "pome-egress-int-"));
    capture = await runCaptureServer({
      port: 0,
      eventsOut: join(runDir, "events.jsonl"),
      allowHosts: ["api.allowed.invalid"],
      egressOut: join(runDir, "egress.jsonl"),
    });

    const status = await connectStatus(capture.port, "api.allowed.invalid", 443);
    expect(status).toBe("502");
  });

  it("never dials upstream for a refused host", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "pome-egress-int-"));
    capture = await runCaptureServer({
      port: 0,
      eventsOut: join(runDir, "events.jsonl"),
      allowHosts: [],
      egressOut: join(runDir, "egress.jsonl"),
    });

    // Target the live upstream's port but under a denied hostname: if the
    // gate leaked, the dial would succeed and the upstream would see a
    // connection.
    const before = upstream!.connections();
    const status = await connectStatus(capture.port, "denied.example", upstream!.port);
    expect(status).toBe("403");
    expect(upstream!.connections()).toBe(before);
  });

  it("enforces the floor even without an egress sidecar configured", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "pome-egress-int-"));
    capture = await runCaptureServer({
      port: 0,
      eventsOut: join(runDir, "events.jsonl"),
      allowHosts: [],
    });

    const status = await connectStatus(capture.port, "blocked.example", 443);
    expect(status).toBe("403");
  });
});
